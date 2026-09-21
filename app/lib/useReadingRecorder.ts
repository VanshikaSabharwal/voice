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
 *
 * Transcription requests run in PARALLEL. Results are still applied in chunk
 * order so a slow earlier phrase cannot land after a later one and scramble
 * the live highlight. Serialising the fetch itself was making greens lag by
 * one full STT round-trip per chunk.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Seconds per chunk. Balance: shorter feels live, longer gives STT a phrase.
 *
 * Also a rate-limit budget. Each chunk is one provider call, so the cadence
 * sets requests-per-minute: 60 / CHUNK_SECONDS. The project is currently
 * enforced at 10 RPM for gemini-3.5-transcribe, so 1.8s (~33 RPM) exhausted
 * the quota ~18s into a page — two or three lines. 7s is ~8.5 RPM, which fits
 * with headroom for the retry below.
 *
 * Tier 2 documents 1000 RPM for this model; the 10 being enforced looks like a
 * provider-side shortfall and is open with Google. If that is corrected this
 * can go back to ~2s, which is where the live highlight feels immediate.
 */
const CHUNK_SECONDS = 7;

/**
 * Retries for a chunk the provider rate-limited.
 *
 * A dropped chunk is not a neutral loss: its words never reach the aligner, so
 * they score as omissions and the child is marked down for words they read
 * correctly. Retrying buys those words back.
 */
const RATE_LIMIT_RETRIES = 2;

/**
 * Longest a chunk may wait before its retry is abandoned.
 *
 * An exhausted per-minute quota can ask for most of a minute back. Honouring
 * that literally would hold the chunk — and the drain at stop() — for that
 * long, so a child finishing a page would sit watching a frozen screen. Past
 * this the words are given up, which the score reports as omissions.
 */
const MAX_RETRY_WAIT_MS = 10000;

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

  /* Whether in-flight transcriptions may still retry. Distinct from
     activeRef: stop() clears that one first and then drains, so a retry
     keyed on it would abandon the last chunk of every page — the one most
     likely to be rate-limited, arriving at the end of a burst. Cleared only
     on unmount, when nothing is left to score. */
  const transcribingRef = useRef(false);

  /* Parallel STT with ordered apply: each chunk gets an index; results land
     in a sparse map and are drained in sequence as soon as the next gap
     is filled. */
  const chunkSeqRef = useRef(0);
  const nextApplyRef = useRef(0);
  const pendingTextRef = useRef<Map<number, string>>(new Map());
  const inFlightRef = useRef(0);
  const drainWaitersRef = useRef<Array<() => void>>([]);

  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  }, [onTranscript, onError]);

  const flushReady = useCallback(() => {
    while (pendingTextRef.current.has(nextApplyRef.current)) {
      const text = pendingTextRef.current.get(nextApplyRef.current) ?? "";
      pendingTextRef.current.delete(nextApplyRef.current);
      nextApplyRef.current += 1;
      if (text) onTranscriptRef.current(text);
    }

    if (inFlightRef.current === 0 && pendingTextRef.current.size === 0) {
      const waiters = drainWaitersRef.current;
      drainWaitersRef.current = [];
      for (const resolve of waiters) resolve();
    }
  }, []);

  const send = useCallback(
    (blob: Blob) => {
      if (blob.size < 1024) return;

      const seq = chunkSeqRef.current++;
      inFlightRef.current += 1;

      void (async () => {
        let text = "";

        try {
          for (let attempt = 0; ; attempt++) {
            /* Rebuilt per attempt: a FormData already sent cannot be reused. */
            const form = new FormData();
            form.append("audio", blob, "chunk.webm");

            const res = await fetch("/api/reading/transcribe", {
              method: "POST",
              body: form,
            });

            const data = await res.json();

            if (res.ok) {
              text = typeof data.text === "string" ? data.text.trim() : "";
              break;
            }

            const message: string =
              data.error ?? "Could not transcribe part of the reading.";

            /* The route turns provider failures into 502s, so a rate limit
               arrives as a 502 whose message carries the upstream 429. */
            const rateLimited = res.status === 429 || /\b429\b/.test(message);

            if (!rateLimited || attempt >= RATE_LIMIT_RETRIES) {
              /* Report but keep going: one bad chunk should not end the page.
                 Its words are lost, which the score reflects as omissions. */
              onErrorRef.current(message);
              break;
            }

            /* Wait out the window. The provider states how long; stt.ts hoists
               it to "retryDelay=Ns" ahead of the body it truncates, so honour
               that rather than guessing.

               Capped: a quota that is already exhausted can ask for most of a
               minute, and a child sitting in front of a frozen page is worse
               than a few lost words. Past the cap the chunk is given up. */
            const stated = /retryDelay=([\d.]+)s/.exec(message);
            const waitMs = Math.min(
              stated ? Math.ceil(Number(stated[1]) * 1000) + 250 : 2000 * (attempt + 1),
              MAX_RETRY_WAIT_MS,
            );

            if (waitMs >= MAX_RETRY_WAIT_MS && stated) {
              onErrorRef.current(message);
              break;
            }

            if (!transcribingRef.current) break;

            await new Promise((resolve) => setTimeout(resolve, waitMs));

            /* The page was torn down while waiting; nothing will read the
               result, so stop spending calls on it. */
            if (!transcribingRef.current) break;
          }
        } catch {
          onErrorRef.current("Lost connection while transcribing.");
        } finally {
          pendingTextRef.current.set(seq, text);
          inFlightRef.current -= 1;
          flushReady();
        }
      })();
    },
    [flushReady],
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
      onErrorRef.current("Microphone permission is needed to read aloud.");
      return;
    }

    streamRef.current = stream;
    activeRef.current = true;
    transcribingRef.current = true;
    startedAtRef.current = Date.now();
    chunkSeqRef.current = 0;
    nextApplyRef.current = 0;
    pendingTextRef.current.clear();
    inFlightRef.current = 0;
    drainWaitersRef.current = [];

    setElapsed(0);
    setState("recording");

    tickRef.current = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 1000);

    runCycle();
  }, [runCycle]);

  /**
   * Stop recording and resolve once every chunk has been transcribed.
   *
   * Awaiting in-flight work is what makes the final score complete: submitting
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

    // Wait for the final chunk to be handed off by onstop.
    if (recorder && recorder.state === "recording") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }

    if (inFlightRef.current > 0 || pendingTextRef.current.size > 0) {
      await new Promise<void>((resolve) => {
        drainWaitersRef.current.push(resolve);
        flushReady();
      });
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;

    setState("idle");

    return Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
  }, [flushReady]);

  // Releasing the microphone on unmount matters: the browser's recording
  // indicator otherwise stays lit after the child navigates away.
  useEffect(() => {
    return () => {
      activeRef.current = false;
      transcribingRef.current = false;
      if (cycleRef.current) clearTimeout(cycleRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return { state, elapsed, start, stop };
}
