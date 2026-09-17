"use client";

/**
 * Streaming recorder for reading assessment.
 *
 * Pipeline:
 *   mic -> worklet (16 kHz PCM16) -> voice server (Gemini Live proxy) ->
 *   interim partials (preview, immediate) + final segments (committed) ->
 *   incremental aligner -> marks the page paints.
 *
 * Latency comes out of the pipeline: a word is painted as soon as the
 * recogniser's partial reaches the server — tens of milliseconds, not a
 * chunk-and-round-trip. Only recogniser-final words are ever committed, so the
 * greens that get *submitted* for the authoritative score are exactly the
 * stable ones.
 *
 * The old chunk-based recorder (useReadingRecorder) stays as a fallback for
 * providers without a streaming path. The page does not need to know which
 * mode it is in — this hook funnels both into the same live-marks shape.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReadingRecorder } from "./useReadingRecorder";
import { createIncrementalAligner } from "../../lib/reading/live-align";
import { alignLive, tokenize } from "../../lib/reading/align";
import type { LiveMarks } from "../../lib/reading/live-align";
import type { MarkKind, WordMark } from "../../lib/reading/types";

/**
 * "connecting" is its own state so the page can tell a child not to speak yet.
 *
 * Getting from a tap to a live recogniser takes a mic permission, a worklet
 * load, a websocket and an upstream handshake — often a second or more. Before
 * this state existed the page said "Listening" throughout, and the opening
 * words of a page went into a pipe that was not connected yet.
 */
export type LiveRecorderState = "idle" | "connecting" | "recording" | "finishing";

type Options = {
  pageWords: string[];
  onError: (message: string) => void;
};

/** Locate the live-ASR socket, defaulting to the shared voice server. */
function liveWsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_LIVE_ASR_WS_URL?.trim();
  if (explicit) return explicit;

  const shared = process.env.NEXT_PUBLIC_VOICE_WS_URL?.trim();

  if (shared) return shared.replace(/\/ws\/call$/, "/ws/live-asr");

  return "ws://localhost:3001/ws/live-asr";
}

/** How long the voice server may take to start its session before fallback. */
const CONNECT_TIMEOUT_MS = 6000;

/** How long stop() may wait for the flushed final before giving up. */
const STOP_TIMEOUT_MS = 4500;

function emptyMarks(): LiveMarks {
  return { byIndex: new Map(), insertions: [], reached: 0 };
}

export function useLiveReadingRecorder({ pageWords, onError }: Options) {
  const [state, setState] = useState<LiveRecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [marks, setMarks] = useState<LiveMarks>(emptyMarks());
  const [liveActive, setLiveActive] = useState(false);

  /* Whether the streaming path is even worth attempting. Probed once on mount;
     null means "not decided yet", which we treat as try-live. */
  const [mode, setMode] = useState<"live" | "fallback" | "deciding">("deciding");

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const pageWordsRef = useRef(pageWords);
  useEffect(() => {
    pageWordsRef.current = pageWords;
  }, [pageWords]);

  /* The incremental aligner is recreated for each new page/attempt. */
  const alignerRef = useRef(createIncrementalAligner(pageWords));
  const alignerReset = useCallback(() => {
    alignerRef.current = createIncrementalAligner(pageWordsRef.current);
    setMarks(emptyMarks());
  }, []);

  function bump(): void {
    setMarks(alignerRef.current.snapshot());
  }

  /* --- Fallback path: legacy chunked recorder → alignLive ----------------- */

  const legacyTranscriptRef = useRef("");
  const [legacyVersion, setLegacyVersion] = useState(0);

  const bumpLegacy = useCallback(() => {
    const text = legacyTranscriptRef.current;
    const pageWordsNow = pageWordsRef.current;

    if (!text.trim() || pageWordsNow.length === 0) {
      setMarks(emptyMarks());
      return;
    }

    const marksList = alignLive(pageWordsNow, tokenize(text));

    const byIndex = new Map<number, WordMark>();
    const insertions: WordMark[] = [];
    let lastReached = -1;

    for (const mark of marksList) {
      if (mark.index >= 0) {
        byIndex.set(mark.index, mark);
        if (mark.kind !== "omitted") lastReached = Math.max(lastReached, mark.index);
      } else {
        insertions.push(mark);
      }
    }

    setMarks({ byIndex, insertions, reached: lastReached + 1 });
  }, []);

  const onFallbackTranscript = useCallback(
    (text: string) => {
      legacyTranscriptRef.current = `${legacyTranscriptRef.current} ${text}`.trim();
      setLegacyVersion((v) => v + 1);
    },
    [],
  );

  /* Always mounted so fallback can kick in without violating the rules of
     hooks. It only ever records when the live path is unavailable. */
  const fallback = useReadingRecorder({
    onTranscript: onFallbackTranscript,
    onError: (message) => onErrorRef.current(message),
  });

  useEffect(() => {
    bumpLegacy();
  }, [bumpLegacy, legacyVersion]);

  /* --- Live path state ---------------------------------------------------- */

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef = useRef(false);
  const liveReadyRef = useRef(false);
  const stopResolveRef = useRef<(() => void) | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Audio captured before the socket was ready. Flushed upstream on "ready" so
     a child who starts reading early is not transcribed from midway through
     their first sentence. Bounded so a stalled handshake cannot grow it
     without limit — ~10s at 100ms per chunk. */
  const pendingAudioRef = useRef<Int16Array[]>([]);
  const PENDING_AUDIO_MAX_CHUNKS = 100;

  /* When the mic actually started, as opposed to when the socket was ready. */
  const captureStartedAtRef = useRef(0);

  const teardownLive = useCallback((bufferForNext: boolean): void => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    } catch {
      /* Already stopped. */
    }
    streamRef.current = null;
    try {
      void audioCtxRef.current?.close();
    } catch {
      /* Closing a closed context. */
    }
    audioCtxRef.current = null;
    try {
      wsRef.current?.close();
    } catch {
      /* Already closed. */
    }
    wsRef.current = null;
    liveReadyRef.current = false;
    pendingAudioRef.current = [];

    if (bufferForNext) activeRef.current = false;
  }, []);

  /* --- Start -------------------------------------------------------------- */

  const startLive = useCallback(async (): Promise<"ok" | "mic" | "fail"> => {
    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });
    } catch {
      onErrorRef.current("Microphone permission is needed to read aloud.");
      return "mic";
    }

    streamRef.current = stream;

    let ctx: AudioContext;

    try {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
      await ctx.audioWorklet.addModule("/live-capture-worklet.js");
    } catch {
      onErrorRef.current("Could not load the audio worklet.");
      teardownLive(true);
      return "fail";
    }

    /* Start capturing NOW, before the socket exists. Anything spoken during
       the handshake is buffered and flushed on "ready" rather than dropped —
       the opening words of a page are exactly the ones a child says soonest
       after tapping. */
    pendingAudioRef.current = [];
    captureStartedAtRef.current = Date.now();

    try {
      await ctx.resume();

      const capture = new AudioWorkletNode(ctx, "live-capture-processor");
      ctx.createMediaStreamSource(stream).connect(capture);

      capture.port.onmessage = (ev: MessageEvent<Int16Array>) => {
        const ws = wsRef.current;

        if (liveReadyRef.current && ws?.readyState === WebSocket.OPEN) {
          ws.send(ev.data);
          return;
        }

        if (pendingAudioRef.current.length < PENDING_AUDIO_MAX_CHUNKS) {
          pendingAudioRef.current.push(ev.data);
        }
      };
    } catch {
      onErrorRef.current("Could not start capturing audio.");
      teardownLive(true);
      return "fail";
    }

    return await new Promise<"ok" | "mic" | "fail">((resolve) => {
      const ws = new WebSocket(liveWsUrl());
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      let settled = false;
      const settle = (outcome: "ok" | "mic" | "fail"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        resolve(outcome);
      };

      const connectTimer = setTimeout(() => {
        if (!settled) {
          onErrorRef.current("The streaming recogniser did not connect.");
          teardownLive(true);
          settle("fail");
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        /* send nothing yet; wait for "ready" from the server */
      };

      ws.onmessage = (event) => {
        let msg: { type?: string; text?: string; message?: string };

        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        if (msg.type === "ready") {
          /* Capture is already running (started before this socket existed).
             Flush whatever the child said during the handshake, in order, then
             let the worklet send directly from here on. */
          const buffered = pendingAudioRef.current;
          pendingAudioRef.current = [];

          for (const chunk of buffered) {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
          }

          liveReadyRef.current = true;
          setLiveActive(true);
          setState("recording");

          /* Time the reading from the first captured audio, not from "ready" —
             the buffered words are part of the reading and count toward wpm. */
          startedAtRef.current = captureStartedAtRef.current || Date.now();
          activeRef.current = true;

          tickRef.current = setInterval(() => {
            if (activeRef.current) {
              setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
            }
          }, 1000);

          settle("ok");
          return;
        }

        if (msg.type === "interim" && typeof msg.text === "string") {
          alignerRef.current.preview(msg.text);
          bump();
          return;
        }

        if (msg.type === "final" && typeof msg.text === "string") {
          alignerRef.current.commit(msg.text);
          bump();
          return;
        }

        if (msg.type === "done") {
          if (stopResolveRef.current) {
            const resolveStop = stopResolveRef.current;
            stopResolveRef.current = null;
            resolveStop();
          }
          return;
        }

        if (msg.type === "error") {
          onErrorRef.current(msg.message ?? "The transcriber failed.");
          if (!liveReadyRef.current) {
            teardownLive(true);
            settle("fail");
          }
        }
      };

      ws.onerror = () => {
        if (!liveReadyRef.current) {
          teardownLive(true);
          onErrorRef.current("Could not reach the streaming recogniser.");
          settle("fail");
        }
      };

      ws.onclose = () => {
        if (stopResolveRef.current) {
          const resolveStop = stopResolveRef.current;
          stopResolveRef.current = null;
          resolveStop();
        }
      };
    });
  }, [teardownLive]);

  const start = useCallback(async () => {
    if (activeRef.current) return;

    alignerReset();
    legacyTranscriptRef.current = "";
    setElapsed(0);
    setMarks(emptyMarks());

    /* Say "getting ready" until capture is genuinely live, so the page can
       hold the child back rather than inviting them to read into a mic that
       is not connected yet. */
    setState("connecting");

    /* Decide live vs fallback. A still-undetermined probe (null) is treated
       as try-live; if the provider has no streaming path the server rejects
       the session and we fall back below. */
    let canLive = true;

    try {
      const res = await fetch("/api/reading/live-config");
      const data = (await res.json()) as { available?: boolean };
      canLive = data.available !== false;
    } catch {
      canLive = true;
    }

    if (mode === "fallback") canLive = false;

    let reason: "ok" | "mic" | "fail" = "fail";

    if (canLive) {
      setMode("live");
      reason = await startLive();
    }

    if (reason === "mic") {
      /* The fallback would hit the same denial; stop here rather than enter a
         recording state that cannot record. */
      setState("idle");
      return;
    }

    if (reason === "fail") {
      /* Live failed to establish — switch to the chunked recorder for the
         whole page. */
      setLiveActive(false);
      setMode("fallback");
      setState("recording");
      activeRef.current = true;
      startedAtRef.current = Date.now();

      await fallback.start();

      tickRef.current = setInterval(() => {
        if (activeRef.current) {
          setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
        }
      }, 1000);
    }
  }, [alignerReset, fallback, mode, startLive]);

  /* --- Stop --------------------------------------------------------------- */

  const stop = useCallback(async (): Promise<{
    transcript: string;
    durationSec: number;
    recovered: number;
  }> => {
    if (!activeRef.current) {
      return { transcript: "", durationSec: 0, recovered: 0 };
    }

    activeRef.current = false;
    setState("finishing");

    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }

    const durationSec = Math.max(
      1,
      Math.round((Date.now() - startedAtRef.current) / 1000),
    );

    if (liveReadyRef.current && wsRef.current) {
      /* Flush: ask the server to force the final of whatever is still being
         spoken, then wait for it to echo back before reading the transcript. */
      await new Promise<void>((resolve) => {
        stopResolveRef.current = resolve;
        stopTimerRef.current = setTimeout(() => {
          stopResolveRef.current = null;
          resolve();
        }, STOP_TIMEOUT_MS);

        try {
          wsRef.current?.send(JSON.stringify({ type: "end" }));
        } catch {
          resolve();
        }
      }).finally(() => {
        if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      });
    }

    teardownLive(true);
    setState("idle");

    if (mode === "fallback") {
      await fallback.stop();
    }

    /* Before reading the transcript, give words the recogniser dropped from
       its finals a second chance against the interims it emitted. This only
       rescues words that were actually heard, so it cannot invent a reading. */
    let recovered = 0;

    if (mode !== "fallback") {
      recovered = alignerRef.current.recoverFromInterims();
      if (recovered > 0) setMarks(alignerRef.current.snapshot());
    }

    /* The transcript scored comes from whichever path actually ran: the
       committed words when streaming, the accumulated chunks otherwise. */
    const transcript =
      mode === "fallback"
        ? legacyTranscriptRef.current.trim()
        : alignerRef.current.transcript();

    return { transcript, durationSec, recovered };
  }, [fallback, mode, teardownLive]);

  /* Release the microphone on unmount, like the chunked recorder does. */
  useEffect(() => {
    return () => {
      teardownLive(true);
    };
  }, [teardownLive]);

  /* Probe whether the deployment supports streaming reading STT. */
  useEffect(() => {
    let cancelled = false;

    fetch("/api/reading/live-config")
      .then((r) => r.json())
      .then((data: { available?: boolean }) => {
        if (!cancelled) setMode(data.available === false ? "fallback" : "deciding");
      })
      .catch(() => {
        if (!cancelled) setMode("deciding");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const liveAccuracy = useMemo(() => {
    if (!marks || marks.reached <= 0 || pageWords.length === 0) return 0;

    let correct = 0;

    for (let i = 0; i < marks.reached && i < pageWords.length; i++) {
      if (marks.byIndex.get(i)?.kind === "correct") correct++;
    }

    return Math.round((correct / pageWords.length) * 100);
  }, [marks, pageWords.length]);

  return { state, elapsed, marks, liveAccuracy, liveActive, start, stop };
}

export type { MarkKind, WordMark, LiveMarks };