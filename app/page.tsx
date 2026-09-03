"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Waveform from "./components/Waveform";
import { BotIcon, MicIcon, PlayIcon, UserIcon, KeyboardIcon } from "./components/Icons";
import { useConfig } from "./lib/ConfigContext";
import { providerAcceptsBlob, toWav } from "./lib/audio";
import { LANGUAGES, type ChatTurn } from "./lib/types";

type Message = {
  id: number;
  role: "assistant" | "user";
  text: string;
  time: string;
  /** Object URL for spoken audio, when TTS succeeded. */
  audio?: string;
  toolsUsed?: string[];
};

type Phase = "idle" | "recording" | "transcribing" | "thinking" | "speaking";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Tap the mic to speak",
  recording: "Recording… release to send",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

export default function VoiceBotPage() {
  const { cfg } = useConfig();

  const [messages, setMessages] = useState<Message[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [autoPlay, setAutoPlay] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Held in a ref so the async pipeline always sees the latest history.
  const messagesRef = useRef<Message[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  // Release the mic and any object URLs when the page unmounts.
  useEffect(() => {
    const urls: string[] = [];
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      messagesRef.current.forEach((m) => m.audio && urls.push(m.audio));
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const now = () =>
    new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const addMessage = useCallback((msg: Omit<Message, "id" | "time">) => {
    const full: Message = { ...msg, id: Date.now() + Math.random(), time: now() };
    setMessages((m) => [...m, full]);
    return full;
  }, []);

  /** Speak the assistant's reply and attach the audio to its bubble. */
  const speak = useCallback(
    async (text: string, messageId: number) => {
      setPhase("speaking");
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            provider: cfg.tts.provider,
            model: cfg.tts.model,
            voice: cfg.tts.voice,
            language: cfg.language,
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Speech failed (${res.status})`);
        }

        const url = URL.createObjectURL(await res.blob());
        setMessages((m) =>
          m.map((x) => (x.id === messageId ? { ...x, audio: url } : x)),
        );

        if (autoPlay) {
          const audio = new Audio(url);
          audioRef.current = audio;
          await audio.play().catch(() => {
            // Browsers block autoplay until the user interacts; the play
            // button on the bubble still works, so this is not an error.
          });
        }
      } catch (err) {
        // A TTS failure must not lose the text reply, so surface it softly.
        setError(err instanceof Error ? err.message : "Speech failed");
      } finally {
        setPhase("idle");
      }
    },
    [cfg.tts, cfg.language, autoPlay],
  );

  /** Send a user turn to the LLM and speak the reply. */
  const sendToAgent = useCallback(
    async (userText: string) => {
      setPhase("thinking");
      setError(null);

      const history: ChatTurn[] = [
        ...messagesRef.current.map((m) => ({
          role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.text,
        })),
        { role: "user", content: userText },
      ];

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: cfg, messages: history }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Chat failed (${res.status})`);

        const reply = addMessage({
          role: "assistant",
          text: data.text,
          toolsUsed: data.toolsUsed?.length ? data.toolsUsed : undefined,
        });

        await speak(data.text, reply.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Chat failed");
        setPhase("idle");
      }
    },
    [cfg, addMessage, speak],
  );

  /** Upload the recording, transcribe it, then hand off to the agent. */
  const transcribeAndSend = useCallback(
    async (blob: Blob) => {
      setPhase("transcribing");
      setError(null);

      try {
        /* Browsers can only record WebM/Opus (or MP4 on Safari). Providers such
           as Sarvam accept neither, so re-encode to WAV before uploading. */
        let upload = blob;
        if (!providerAcceptsBlob(cfg.stt.provider, blob)) {
          upload = await toWav(blob);
        }

        const ext = upload.type.includes("wav")
          ? "wav"
          : upload.type.includes("mp4")
            ? "mp4"
            : "webm";

        const form = new FormData();
        form.append("audio", upload, `turn.${ext}`);
        form.append("provider", cfg.stt.provider);
        form.append("model", cfg.stt.model);
        form.append("language", cfg.stt.language);

        const res = await fetch("/api/stt", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Transcription failed (${res.status})`);

        addMessage({ role: "user", text: data.text });
        await sendToAgent(data.text);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Transcription failed");
        setPhase("idle");
      }
    },
    [cfg.stt, addMessage, sendToAgent],
  );

  async function startRecording() {
    if (phase !== "idle") return;
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Prefer webm/opus; Safari falls back to whatever it supports.
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);

      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        // Ignore accidental taps that produce almost no audio.
        if (blob.size < 1200) {
          setPhase("idle");
          return;
        }
        void transcribeAndSend(blob);
      };

      recorder.start();
      recorderRef.current = recorder;
      setPhase("recording");
    } catch {
      setError("Microphone access denied. Allow it in your browser settings.");
      setPhase("idle");
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") recorder.stop();
    recorderRef.current = null;
  }

  async function sendText() {
    const text = draft.trim();
    if (!text || phase !== "idle") return;
    setDraft("");
    addMessage({ role: "user", text });
    await sendToAgent(text);
  }

  function endConversation() {
    audioRef.current?.pause();
    messages.forEach((m) => m.audio && URL.revokeObjectURL(m.audio));
    setMessages([]);
    setError(null);
    setPhase("idle");
  }

  const busy = phase !== "idle" && phase !== "recording";

  return (
    <div className="flex h-[calc(100vh-57px)] flex-col lg:h-screen">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-white px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <h1 className="text-sm font-semibold">Voice Bot</h1>
          <span className="chip-connected">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
            Online
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={autoPlay}
              onChange={(e) => setAutoPlay(e.target.checked)}
              className="accent-[var(--brand)]"
            />
            Auto-play
          </label>
          <button
            onClick={endConversation}
            className="rounded-lg border border-[var(--danger)] px-3 py-1.5 text-xs font-medium text-[var(--danger)] transition hover:bg-[var(--danger-soft)]"
          >
            End Conversation
          </button>
        </div>
      </header>

      <div className="bg-gradient-to-b from-[var(--brand-soft)] to-white px-4 py-6 text-center">
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-[var(--border)]">
          <BotIcon className="h-8 w-8 text-[var(--brand)]" />
        </span>
        <p className="mt-3 text-sm font-semibold">{cfg.name}</p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          {cfg.stt.provider} → {cfg.llm.model} → {cfg.tts.voice}
        </p>
      </div>

      <div
        ref={scrollRef}
        className="mx-auto w-full max-w-2xl flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6"
      >
        {messages.length === 0 && (
          <div className="pt-10 text-center">
            <p className="text-sm text-[var(--text-subtle)]">
              Say something to start the conversation.
            </p>
            <p className="mt-2 text-xs text-[var(--text-subtle)]">
              Try: &ldquo;What&rsquo;s the status of SR1234?&rdquo;
            </p>
          </div>
        )}

        {messages.map((m) => {
          const isUser = m.role === "user";
          return (
            <div key={m.id} className={`flex items-end gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full
                  ${isUser
                    ? "bg-[var(--surface-muted)] text-[var(--text-muted)]"
                    : "bg-[var(--brand-soft)] text-[var(--brand)]"
                  }`}
              >
                {isUser ? <UserIcon className="h-3.5 w-3.5" /> : <BotIcon className="h-4 w-4" />}
              </span>

              <div className="max-w-[78%] sm:max-w-[70%]">
                <div
                  className={`rounded-2xl px-3 py-2.5
                    ${isUser
                      ? "rounded-br-sm bg-[var(--brand)] text-white"
                      : "rounded-bl-sm bg-white text-[var(--foreground)] ring-1 ring-[var(--border)]"
                    }`}
                >
                  {m.audio && (
                    <div className="mb-1.5 flex items-center gap-2">
                      <button
                        aria-label="Play message"
                        onClick={() => {
                          const audio = new Audio(m.audio);
                          audioRef.current = audio;
                          void audio.play();
                        }}
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                          ${isUser ? "bg-white/20 text-white" : "bg-[var(--brand-soft)] text-[var(--brand)]"}`}
                      >
                        <PlayIcon className="h-3 w-3" />
                      </button>
                      <Waveform
                        seed={Math.floor(m.id)}
                        className={isUser ? "text-white/70" : "text-[var(--brand)]/50"}
                      />
                    </div>
                  )}
                  <p className="text-[13px] leading-relaxed">{m.text}</p>
                </div>

                <p className={`mt-1 text-[10px] text-[var(--text-subtle)] ${isUser ? "text-right" : ""}`}>
                  {isUser ? "You" : "Assistant"} • {m.time}
                  {m.toolsUsed && ` • called ${m.toolsUsed.join(", ")}`}
                </p>
              </div>
            </div>
          );
        })}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--brand-soft)] text-[var(--brand)]">
              <BotIcon className="h-4 w-4" />
            </span>
            {PHASE_LABEL[phase]}
          </div>
        )}
      </div>

      <footer className="border-t border-[var(--border)] bg-white px-4 py-4 sm:px-6">
        {error && (
          <p className="mx-auto mb-3 max-w-2xl rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]">
            {error}
          </p>
        )}

        <p className="mb-3 text-center text-[11px] text-[var(--text-subtle)]">
          {PHASE_LABEL[phase]}
        </p>

        <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
          <button
            onClick={() => setTextMode((t) => !t)}
            aria-label="Toggle text input"
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition
              ${textMode
                ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
              }`}
          >
            <KeyboardIcon className="h-4 w-4" />
          </button>

          {textMode ? (
            <>
              <input
                className="field-input flex-1"
                placeholder="Type a message…"
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void sendText()}
              />
              <button
                onClick={() => void sendText()}
                disabled={busy || !draft.trim()}
                className="shrink-0 rounded-lg bg-[var(--brand)] px-4 py-2 text-xs font-medium text-white transition hover:bg-[var(--brand-hover)] disabled:opacity-50"
              >
                Send
              </button>
            </>
          ) : (
            <div className="flex flex-1 justify-center">
              <button
                onMouseDown={() => void startRecording()}
                onMouseUp={stopRecording}
                onMouseLeave={() => phase === "recording" && stopRecording()}
                onTouchStart={(e) => {
                  e.preventDefault();
                  void startRecording();
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  stopRecording();
                }}
                disabled={busy}
                aria-label="Hold to record"
                className={`flex h-14 w-14 items-center justify-center rounded-full text-white transition
                  ${phase === "recording"
                    ? "scale-110 bg-[var(--danger)] ring-4 ring-[var(--danger-soft)]"
                    : "bg-[var(--brand)] hover:bg-[var(--brand-hover)]"
                  } disabled:opacity-50`}
              >
                <MicIcon className="h-5 w-5" />
              </button>
            </div>
          )}

          <span className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-2 text-xs text-[var(--text-muted)]">
            {LANGUAGES.find((l) => l.value === cfg.language)?.value.toUpperCase() ??
              cfg.language.toUpperCase()}
          </span>
        </div>
      </footer>
    </div>
  );
}
