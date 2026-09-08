"use client";

/**
 * The fake phone.
 *
 * Stands in for Twilio: same 8 kHz mu-law, same 20 ms frames, same rule that
 * audio already sent must be explicitly cleared to stop it. Anything that
 * works here should work on a real call, and anything that breaks on a real
 * call should be reproducible here.
 *
 * The VAD meter is the most useful thing on the page. Nearly every "the agent
 * isn't hearing me" turns out to be a threshold problem, and without seeing
 * the level against the threshold you are guessing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useConfig } from "./lib/ConfigContext";
import { decodeMulaw, encodeMulaw, FRAME_BYTES } from "./lib/mulaw-client";

type CallState =
  | "idle"
  | "greeting"
  | "listening"
  | "capturing"
  | "thinking"
  | "speaking"
  | "ended";

type Entry = {
  role: "user" | "assistant" | "system";
  text: string;
  interrupted?: boolean;
  toolsUsed?: string[];
  sttMs?: number;
  llmMs?: number;
  ttsMs?: number;
};

const STATE_LABEL: Record<CallState, string> = {
  idle: "Not connected",
  greeting: "Greeting",
  listening: "Listening",
  capturing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
};

const STATE_TONE: Record<CallState, string> = {
  idle: "bg-[var(--surface-muted)] text-[var(--text-muted)]",
  greeting: "bg-[var(--brand-soft)] text-[var(--brand)]",
  listening: "bg-[var(--brand-soft)] text-[var(--brand)]",
  capturing: "bg-[var(--danger-soft)] text-[var(--danger)]",
  thinking: "bg-[var(--surface-muted)] text-[var(--text-muted)]",
  speaking: "bg-[var(--brand-soft)] text-[var(--brand)]",
  ended: "bg-[var(--surface-muted)] text-[var(--text-muted)]",
};

const WS_BASE =
  process.env.NEXT_PUBLIC_VOICE_WS_URL ?? "ws://localhost:3001/ws/call";

export default function CallTestPage() {
  const { activeId } = useConfig();

  const [state, setState] = useState<CallState>("idle");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Live VAD readings, for the meter.
  const [level, setLevel] = useState(0);
  const [threshold, setThreshold] = useState(0.012);
  const [speech, setSpeech] = useState(false);

  // Knobs. These map onto real config fields the engine reads.
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [interruption, setInterruption] = useState(true);
  const [endpointingMs, setEndpointingMs] = useState(500);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playbackRef = useRef<AudioWorkletNode | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  const hangUp = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    void ctxRef.current?.close();
    ctxRef.current = null;
    playbackRef.current = null;

    setConnected(false);
    setState("ended");
    setSpeech(false);
    setLevel(0);
  }, []);

  useEffect(() => hangUp, [hangUp]);

  const call = useCallback(async () => {
    setError(null);
    setEntries([]);
    setState("idle");

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Without this, laptop speakers feed the agent's own voice back into
          // the mic and it interrupts itself constantly. The toggle exists to
          // demonstrate exactly that failure.
          echoCancellation,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      setError("Microphone permission is required to place a call.");
      return;
    }

    streamRef.current = stream;

    const ctx = new AudioContext();
    ctxRef.current = ctx;

    try {
      await ctx.audioWorklet.addModule("/call-worklet.js");
    } catch {
      setError("Could not load the audio worklet.");
      hangUp();
      return;
    }

    const params = new URLSearchParams();
    if (activeId) params.set("agentId", activeId);

    const ws = new WebSocket(`${WS_BASE}?${params.toString()}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const capture = new AudioWorkletNode(ctx, "capture-processor");
    const playback = new AudioWorkletNode(ctx, "playback-processor");
    playbackRef.current = playback;

    ctx.createMediaStreamSource(stream).connect(capture);
    playback.connect(ctx.destination);

    // Mic -> mu-law -> socket. Encoding on this thread keeps the worklet to
    // pure DSP and the codec in one place.
    capture.port.onmessage = (event: MessageEvent<Int16Array>) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      ws.send(encodeMulaw(event.data));
    };

    ws.onopen = () => {
      setConnected(true);
      void ctx.resume();
    };

    ws.onmessage = (event: MessageEvent) => {
      // Binary is audio, text is control. That distinction is the protocol.
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);

        for (let i = 0; i + FRAME_BYTES <= bytes.length; i += FRAME_BYTES) {
          playback.port.postMessage({
            type: "audio",
            samples: decodeMulaw(bytes.subarray(i, i + FRAME_BYTES)),
          });
        }

        return;
      }

      const msg = JSON.parse(event.data as string);

      switch (msg.type) {
        case "state":
          setState(msg.value as CallState);
          break;

        case "vad":
          setLevel(msg.rms);
          setThreshold(msg.threshold);
          setSpeech(msg.speech);
          break;

        case "transcript":
          setEntries((prev) => [
            ...prev,
            {
              role: msg.role,
              text: msg.text,
              interrupted: msg.interrupted,
              toolsUsed: msg.toolsUsed,
              sttMs: msg.sttMs,
              llmMs: msg.llmMs,
              ttsMs: msg.ttsMs,
            },
          ]);
          break;

        case "clear":
          // Barge-in: drop audio not yet heard, instantly.
          playback.port.postMessage({ type: "clear" });
          break;

        case "mark":
          // Echo back once playback reaches it, the way Twilio does.
          ws.send(JSON.stringify({ type: "mark", name: msg.name }));
          break;

        case "connected":
          setEntries((prev) => [
            ...prev,
            {
              role: "system",
              text: `${msg.direction === "outbound" ? "Outbound" : "Inbound"} call connected to "${msg.agent}".`,
            },
          ]);
          break;

        case "hangup":
          hangUp();
          break;

        case "error":
          setError(msg.message);
          break;
      }
    };

    ws.onerror = () => {
      setError(
        `Could not reach the voice server at ${WS_BASE}. Is it running? (npm run dev:voice)`,
      );
    };

    ws.onclose = () => {
      setConnected(false);
      setState("ended");
    };
  }, [activeId, echoCancellation, hangUp]);

  /** Push a knob change to the live session. */
  const patch = useCallback((body: Record<string, unknown>) => {
    const ws = wsRef.current;

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "params", ...body }));
    }
  }, []);

  // The meter is logarithmic-ish so quiet speech is still visible.
  const pct = Math.min(100, Math.round(Math.sqrt(level) * 180));
  const thresholdPct = Math.min(100, Math.round(Math.sqrt(threshold) * 180));

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[var(--border)] bg-white px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold">Call Test</h1>
            <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
              A stand-in phone line: 8&nbsp;kHz mu-law, 20&nbsp;ms frames — the
              same audio a real call carries.
            </p>
          </div>

          <span
            className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-medium ${STATE_TONE[state]}`}
          >
            {STATE_LABEL[state]}
          </span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6" ref={scrollRef}>
        <div className="mx-auto max-w-3xl space-y-4">
          {error && (
            <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]">
              {error}
            </p>
          )}

          {/* The single most useful debugging affordance on this page. */}
          <section className="rounded-xl border border-[var(--border)] bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-medium">Voice activity</h2>
              <span
                className={`text-[11px] ${speech ? "text-[var(--danger)]" : "text-[var(--text-subtle)]"}`}
              >
                {speech ? "speech detected" : "silence"}
              </span>
            </div>

            <div className="relative h-3 overflow-hidden rounded-full bg-[var(--surface-muted)]">
              <div
                className={`h-full transition-[width] duration-75 ${speech ? "bg-[var(--danger)]" : "bg-[var(--brand)]"}`}
                style={{ width: `${pct}%` }}
              />
              {/* Where the threshold sits — speech above this line counts. */}
              <div
                className="absolute top-0 h-full w-0.5 bg-[var(--text)]"
                style={{ left: `${thresholdPct}%` }}
                title="Detection threshold"
              />
            </div>

            <p className="mt-1.5 text-[10px] text-[var(--text-subtle)]">
              level {level.toFixed(4)} · threshold {threshold.toFixed(4)} (the
              line adapts to background noise)
            </p>
          </section>

          <section className="grid gap-3 sm:grid-cols-3">
            <label className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[11px]">
              <input
                type="checkbox"
                checked={echoCancellation}
                disabled={connected}
                onChange={(e) => setEchoCancellation(e.target.checked)}
              />
              <span>
                Echo cancellation
                <span className="block text-[10px] text-[var(--text-subtle)]">
                  off = agent interrupts itself
                </span>
              </span>
            </label>

            <label className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[11px]">
              <input
                type="checkbox"
                checked={interruption}
                onChange={(e) => {
                  setInterruption(e.target.checked);
                  patch({ interruptionEnabled: e.target.checked });
                }}
              />
              <span>
                Allow barge-in
                <span className="block text-[10px] text-[var(--text-subtle)]">
                  talk over the agent
                </span>
              </span>
            </label>

            <label className="rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[11px]">
              <span className="mb-1 block">
                Endpointing {endpointingMs}&nbsp;ms
              </span>
              <input
                type="range"
                min={200}
                max={1500}
                step={100}
                value={endpointingMs}
                className="w-full"
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setEndpointingMs(value);
                  patch({ endpointingMs: value });
                }}
              />
            </label>
          </section>

          <section className="space-y-2">
            {entries.length === 0 && (
              <p className="py-8 text-center text-[11px] text-[var(--text-subtle)]">
                Press Call, wait for the greeting, then speak. Try talking over
                the agent to test barge-in.
              </p>
            )}

            {entries.map((entry, i) => (
              <div
                key={i}
                className={`rounded-xl px-3 py-2 text-xs ${
                  entry.role === "system"
                    ? "bg-[var(--surface-muted)] text-[var(--text-subtle)]"
                    : entry.role === "user"
                      ? "ml-auto max-w-[85%] bg-[var(--brand)] text-white"
                      : "mr-auto max-w-[85%] border border-[var(--border)] bg-white"
                }`}
              >
                <p>{entry.text}</p>

                {(entry.interrupted ||
                  entry.toolsUsed?.length ||
                  entry.sttMs ||
                  entry.llmMs) && (
                  <p
                    className={`mt-1 text-[10px] ${entry.role === "user" ? "text-white/70" : "text-[var(--text-subtle)]"}`}
                  >
                    {entry.interrupted && "interrupted · "}
                    {entry.toolsUsed?.length
                      ? `${entry.toolsUsed.join(", ")} · `
                      : ""}
                    {entry.sttMs ? `stt ${entry.sttMs}ms ` : ""}
                    {entry.llmMs ? `llm ${entry.llmMs}ms ` : ""}
                    {entry.ttsMs ? `tts ${entry.ttsMs}ms` : ""}
                  </p>
                )}
              </div>
            ))}
          </section>
        </div>
      </div>

      <footer className="border-t border-[var(--border)] bg-white px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl justify-center">
          {connected ? (
            <button
              onClick={hangUp}
              className="rounded-full bg-[var(--danger)] px-6 py-2.5 text-xs font-medium text-white transition hover:opacity-90"
            >
              Hang up
            </button>
          ) : (
            <button
              onClick={() => void call()}
              className="rounded-full bg-[var(--brand)] px-6 py-2.5 text-xs font-medium text-white transition hover:bg-[var(--brand-hover)]"
            >
              Call
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
