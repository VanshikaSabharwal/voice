"use client";

/**
 * Chunked recording for reading assessment.
 *
 * Uses MediaRecorder rather than the AudioWorklet path in app/page.tsx: that
 * one produces 8 kHz mu-law because a phone call must, and downsampling a
 * child's voice to telephone quality would throw away exactly the detail the
 * recogniser needs. Here webm/opus goes straight to the STT provider.
 *
 * Audio is transcribed in chunks while the child reads, so words can be marked
 * during the page rather than only at the end. Each chunk is a STANDALONE
 * recording — MediaRecorder's timeslice mode emits fragments that are not
 * independently decodable, so a fragment sent alone transcribes as silence.
 * The recorder is therefore stopped and restarted per chunk.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Seconds per chunk. Long enough for context, short enough to feel live. */
const CHUNK_SECONDS = 5;

export type RecorderState = "idle" | "recording" | "finishing";

type Options = {
  /** Called with each chunk's transcript as it arrives. */
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
};

/** The first container the browser actually supports. */
function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }

  return "";
}

export function useReadingRecorder({ onTranscript, onError }: Options) {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const cycleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  /* Whether recording should continue, read inside async callbacks. State
     would be stale there — the callbacks close over the value at setup. */
  const activeRef = useRef(false);

  /* Transcription requests are queued so chunks are appended in the order they
     were spoken. Without this, a slow chunk lands after a later fast one and
     the transcript reads out of order. */
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const send = useCallback(
    (blob: Blob) => {
      if (blob.size < 1024) return;

      queueRef.current = queueRef.current.then(async () => {
        const form = new FormData();
        form.append("audio", blob, "chunk.webm");

        try {
          const res = await fetch("/api/reading/transcribe", {
            method: "POST",
            body: form,
          });

          const data = await res.json();

          if (!res.ok) {
            /* Report but keep going: a provider hiccup on one chunk should not
               end the page. The words in it are lost, which the final score
               reflects honestly as omissions. */
            onError(data.error ?? "Could not transcribe part of the reading.");
            return;
          }

          if (data.text) onTranscript(data.text);
        } catch {
          onError("Lost connection while transcribing.");
        }
      });
    },
    [onError, onTranscript],
  );

  /* The cycle re-enters itself from onstop. Going through a ref rather than
     naming runCycle inside its own definition avoids referencing the binding
     before it is initialised, and keeps a long recording chained to the
     current callback rather than the one captured at start. */
  const runCycleRef = useRef<() => void>(() => {});

  /** Record one chunk, then schedule the next. */
  const runCycle = useCallback(() => {
    const stream = streamRef.current;

    if (!stream || !activeRef.current) return;

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;

    const parts: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };

    recorder.onstop = () => {
      if (parts.length > 0) {
        send(new Blob(parts, { type: recorder.mimeType || "audio/webm" }));
      }

      // Chain the next chunk from onstop so recordings never overlap.
      if (activeRef.current) runCycleRef.current();
    };

    recorder.start();

    cycleRef.current = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, CHUNK_SECONDS * 1000);
  }, [send]);

  // Assigned in an effect, not during render: refs must not be written while
  // rendering. start() only runs after mount, so the ref is set by then.
  useEffect(() => {
    runCycleRef.current = runCycle;
  }, [runCycle]);

  const start = useCallback(async () => {
    if (activeRef.current) return;

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      onError("Microphone permission is needed to read aloud.");
      return;
    }

    streamRef.current = stream;
    activeRef.current = true;
    startedAtRef.current = Date.now();

    setElapsed(0);
    setState("recording");

    tickRef.current = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 1000);

    runCycle();
  }, [onError, runCycle]);

  /**
   * Stop recording and resolve once every chunk has been transcribed.
   *
   * Awaiting the queue is what makes the final score complete: submitting
   * immediately would score the page without its last few seconds.
   */
  const stop = useCallback(async (): Promise<number> => {
    if (!activeRef.current) return 0;

    activeRef.current = false;
    setState("finishing");

    if (cycleRef.current) {
      clearTimeout(cycleRef.current);
      cycleRef.current = null;
    }

    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }

    const recorder = recorderRef.current;

    // Wait for the final chunk to be handed to the queue by onstop.
    if (recorder && recorder.state === "recording") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }

    await queueRef.current;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;

    setState("idle");

    return Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
  }, []);

  // Releasing the microphone on unmount matters: the browser's recording
  // indicator otherwise stays lit after the child navigates away.
  useEffect(() => {
    return () => {
      activeRef.current = false;
      if (cycleRef.current) clearTimeout(cycleRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return { state, elapsed, start, stop };
}
