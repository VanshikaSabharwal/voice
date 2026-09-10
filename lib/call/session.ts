/**
 * The conversation engine.
 *
 * One CallSession drives one call, whatever is carrying it. Inbound and
 * outbound differ only in who opened the transport — both land in `greeting`
 * and run the same loop from there, which is why there is one engine here
 * rather than two.
 *
 * The loop is: listen for speech, decide the caller has stopped, transcribe,
 * think, speak — while staying interruptible throughout. Most of the subtlety
 * is in that last clause.
 */

import { decodeMulaw, FRAME_MS } from "../audio/mulaw";
import { FrameRing, PlaybackQueue } from "../audio/frames";
import { BargeInDetector, Vad } from "../audio/vad";
import { callParamsFrom, type CallParams } from "./params";
import { createTranscriber, type Transcriber } from "../agent/transcriber";
import { runAgent } from "../agent/llm";
import { speak } from "../agent/tts";
import type { MediaTransport, CallDirection } from "./transport";
import type { AgentConfig, ChatTurn } from "../../app/lib/types";

export type CallState =
  | "idle"
  | "greeting"
  | "listening"
  | "capturing"
  | "thinking"
  | "speaking"
  | "ended";

export type TurnRecord = {
  role: "user" | "assistant";
  text: string;
  at: number;
  interrupted?: boolean;
  toolsUsed?: string[];
  sttMs?: number;
  /** Model inference only; tool execution is reported separately as toolMs. */
  llmMs?: number;
  /** Time inside tools (RAG retrieval, lookups), carved out of the LLM stage. */
  toolMs?: number;
  ttsMs?: number;
};

export type SessionHooks = {
  onState?: (state: CallState) => void;
  onTurn?: (turn: TurnRecord) => void;
  onVad?: (reading: { rms: number; threshold: number; speech: boolean }) => void;
  onError?: (message: string) => void;
  onEnded?: () => void;
};

export type SessionOptions = {
  transport: MediaTransport;
  config: AgentConfig;
  direction: CallDirection;
  greeting?: string;
  hooks?: SessionHooks;
};

/** How long after the agent starts speaking before interruption is allowed. */
const BARGE_IN_GUARD_MS = 200;

/** How often to report VAD levels upstream. Every frame would be 50/s. */
const VAD_REPORT_EVERY = 5;

/** Consecutive unanswered prompts before giving up and ending the call. */
const MAX_REPROMPTS = 3;

/**
 * Shortest capture worth sending to STT, in frames (20 ms each).
 *
 * A door closing or a cough clears the energy threshold but cannot be a
 * sentence. Below this the audio is discarded without an STT call, which also
 * saves the round trip and the per-request cost.
 */
const MIN_UTTERANCE_FRAMES = 15; // 300 ms

/**
 * Frames of *speech* above which a filler transcript is believed.
 *
 * A spoken "yes" carries sustained energy; a noise trigger is mostly silence
 * that happened to cross the threshold. Counting speech frames separates the
 * two, so the filter can drop hallucinations without swallowing a real
 * one-word answer. Anything at or above this is taken at face value.
 */
const SPOKEN_FILLER_FRAMES = 10; // 200 ms of actual speech

/**
 * Transcripts to treat as "nothing was said".
 *
 * STT models are trained to always emit text, so on pure noise they do not
 * return empty — they hallucinate the most probable short utterance. Verified
 * against the live APIs: 1.5 s of white/pink/mains-hum noise makes Sarvam
 * return "हाँ।" / "हाँ हाँ।" / "हाँ जी।" every time (Gemini correctly returns
 * empty). Without this guard the agent answers a "yes" the caller never said.
 *
 * Deliberately narrow: only filler with no content, and only when it is the
 * WHOLE transcript — and even then only when the capture carried too little
 * speech to contain it (see SPOKEN_FILLER_FRAMES). A caller answering "yes" to
 * "shall I book that?" must survive.
 */
const NOISE_TRANSCRIPTS = new Set([
  // Hindi/Indic fillers Sarvam produces from noise.
  "हाँ", "हां", "हा", "जी", "अच्छा", "ठीक", "हूँ", "हम",
  // English equivalents seen from noise on other providers.
  "yeah", "yes", "yep", "uh", "um", "hmm", "mm", "mhm", "ah", "oh", "okay", "ok",
  // Common transcriber placeholders for non-speech.
  "you", "thank you", "thanks for watching", "bye",
]);

/**
 * Is this transcript most likely hallucinated from noise rather than spoken?
 *
 * Strips punctuation and splits into words, then asks whether every word is a
 * contentless filler. A one-or-two-word all-filler transcript from a capture
 * that was mostly silence is the signature of a noise trigger.
 */
function looksLikeNoise(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[.,!?;:।॥"'`]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // An empty or very long transcript is handled elsewhere; only short
  // all-filler results are suspect.
  if (words.length === 0 || words.length > 3) return false;

  return words.every((w) => NOISE_TRANSCRIPTS.has(w));
}

/**
 * The opening line for a config, when no explicit greeting was supplied.
 *
 * Language-matched, because an English greeting from an agent configured to
 * speak Hindi is the first thing the caller hears and immediately signals that
 * something is misconfigured. TTS also mispronounces text it was not given the
 * right language for.
 *
 * Exported and pure so the server can synthesize this ahead of the call and
 * have it waiting in the TTS cache — computing the string in two places would
 * mean warming audio the session then does not use.
 */
export function defaultGreetingFor(
  cfg: AgentConfig,
  direction: CallDirection,
): string {
  const name = cfg.name;
  const outbound = direction === "outbound";

  switch ((cfg.language || "en").split("-")[0]) {
    case "hi":
      return outbound
        ? `नमस्ते, मैं ${name} से बात कर रहा हूँ। मैं आपकी क्या मदद कर सकता हूँ?`
        : `नमस्ते, आप ${name} पर पहुँचे हैं। मैं आपकी क्या मदद कर सकता हूँ?`;

    default:
      return outbound
        ? `Hello, this is ${name} calling. How can I help you today?`
        : `Hello, you have reached ${name}. How can I help you today?`;
  }
}

export class CallSession {
  readonly id: string;
  readonly direction: CallDirection;

  private state: CallState = "idle";
  private readonly transport: MediaTransport;
  private readonly cfg: AgentConfig;
  private readonly hooks: SessionHooks;
  private params: CallParams;

  private readonly vad: Vad;
  private readonly bargeIn = new BargeInDetector();
  private readonly preRoll: FrameRing;
  private readonly playback: PlaybackQueue;

  private history: ChatTurn[] = [];
  private transcriber: Transcriber | null = null;

  /**
   * Monotonic turn counter.
   *
   * AbortController closes the network race but not the microtask one: a fetch
   * can resolve and queue its continuation moments before abort() lands, so
   * every async step re-checks this before touching state. Interrupting the
   * agent bumps it, which quietly invalidates any work still in flight.
   */
  private turnId = 0;

  private llmAbort: AbortController | null = null;
  private ttsAbort: AbortController | null = null;

  private captureFrames = 0;
  /** Frames of the current capture the VAD judged to be speech. */
  private speechFrames = 0;
  private idleFrames = 0;
  private frameCounter = 0;
  private reprompts = 0;
  /** Set when the current utterance is the last thing this call will say. */
  private farewell = false;
  private speakingSince = 0;
  private spokenText = "";
  private closed = false;
  private readonly greetingText?: string;

  /** A reply that has been generated but is still playing out to the caller. */
  private pendingTurn: {
    turn: number;
    text: string;
    toolsUsed?: string[];
    sttMs?: number;
    llmMs?: number;
    toolMs?: number;
    ttsMs?: number;
  } | null = null;

  constructor(opts: SessionOptions) {
    this.id = opts.transport.id;
    this.transport = opts.transport;
    this.cfg = opts.config;
    this.direction = opts.direction;
    this.hooks = opts.hooks ?? {};
    this.params = callParamsFrom(opts.config);

    this.vad = new Vad(this.params.vad);
    this.preRoll = new FrameRing(this.params.vad.onsetFrames);

    this.playback = new PlaybackQueue(
      (frame) => this.transport.sendAudio(frame),
      (name) => this.onMarkReached(name),
    );

    this.transport.onAudio((frame) => this.onFrame(frame));
    this.transport.onClose(() => this.end());

    // Prefer the transport's own playback report when it has one: Twilio (and
    // the harness imitating it) knows when audio actually reached the caller's
    // ear, which our frames-sent estimate can only approximate.
    this.transport.onMark?.((name) => this.onMarkReached(name));

    this.greetingText = opts.greeting;
  }

  /** Retune mid-call. The harness exposes these as live sliders. */
  updateParams(patch: Partial<{ endpointingMs: number; silenceTimeout: number; interruptionEnabled: boolean }>): void {
    if (patch.endpointingMs !== undefined) {
      this.params.vad.endpointFrames = Math.max(1, Math.round(patch.endpointingMs / FRAME_MS));
      this.vad.setParams({ endpointFrames: this.params.vad.endpointFrames });
    }

    if (patch.silenceTimeout !== undefined) {
      this.params.idleRepromptFrames = Math.max(1, Math.round((patch.silenceTimeout * 1000) / FRAME_MS));
    }

    if (patch.interruptionEnabled !== undefined) {
      this.params.interruptionEnabled = patch.interruptionEnabled;
    }
  }

  /** The opening line, when no explicit greeting was supplied. */
  private defaultGreeting(): string {
    return defaultGreetingFor(this.cfg, this.direction);
  }

  /** Begin the call. Both directions greet first. */
  async start(): Promise<void> {
    if (this.state !== "idle") return;

    const greeting = this.greetingText?.trim() || this.defaultGreeting();

    this.setState("greeting");
    await this.say(greeting);
  }

  // -------------------------------------------------------------------------
  // Inbound audio
  // -------------------------------------------------------------------------

  private onFrame(frame: Uint8Array): void {
    if (this.closed) return;

    const pcm = decodeMulaw(frame);

    // While the agent is talking, the only question that matters is whether
    // the caller has started talking over it.
    if (this.state === "speaking" || this.state === "greeting") {
      this.maybeInterrupt(frame, pcm);
      return;
    }

    if (this.state !== "listening" && this.state !== "capturing") return;

    const reading = this.vad.push(pcm);

    if (++this.frameCounter % VAD_REPORT_EVERY === 0) {
      this.hooks.onVad?.({
        rms: reading.rms,
        threshold: reading.threshold,
        speech: reading.speech,
      });
    }

    // Without VAD, fall back to a fixed window so the pipeline stays testable.
    if (!this.params.vadEnabled) {
      this.fixedWindowCapture(frame);
      return;
    }

    if (this.state === "listening") {
      // Hold recent frames so the first syllable is not lost to the onset
      // debounce — by the time speech is confirmed, it has already happened.
      this.preRoll.push(frame);

      if (reading.event === "onset") {
        this.beginCapture();
        return;
      }

      // Nothing said since the agent stopped: nudge rather than wait forever.
      if (++this.idleFrames >= this.params.idleRepromptFrames) {
        this.idleFrames = 0;
        this.reprompts++;

        // But do not nudge indefinitely. A caller who has said nothing after
        // several prompts has hung up, walked away, or is on a dead line, and
        // an agent talking to itself forever ties up a channel and bills for
        // TTS nobody hears.
        if (this.reprompts > MAX_REPROMPTS) {
          void this.sayThenHangup(
            "I could not hear anything, so I will end the call now. Please call back when you are ready.",
          );
          return;
        }

        void this.say(this.params.fallbackMessage);
      }

      return;
    }

    // capturing
    this.transcriber?.push(frame);
    this.captureFrames++;
    // Track how much of this capture was actually speech, so finishTurn can
    // tell a spoken one-word answer from noise that tripped the threshold.
    if (reading.speech) this.speechFrames++;

    if (reading.event === "endpoint") {
      void this.finishTurn();
      return;
    }

    // A stuck-open mic must not buffer forever.
    if (this.captureFrames >= this.params.maxUtteranceFrames) {
      this.vad.reset();
      void this.finishTurn();
    }
  }

  /** Capture a fixed window when VAD is disabled — a debugging aid. */
  private fixedWindowCapture(frame: Uint8Array): void {
    if (this.state === "listening") {
      this.beginCapture();
    }

    this.transcriber?.push(frame);

    if (++this.captureFrames >= this.params.maxUtteranceFrames) {
      void this.finishTurn();
    }
  }

  private beginCapture(): void {
    this.setState("capturing");

    this.idleFrames = 0;
    this.captureFrames = 0;
    this.speechFrames = 0;
    // The caller is there after all; forget any unanswered prompts.
    this.reprompts = 0;
    this.transcriber = createTranscriber(this.cfg);

    // Replay the pre-roll so the utterance starts where the caller did.
    for (const held of this.preRoll.drain()) {
      this.transcriber.push(held);
      this.captureFrames++;
    }
  }

  // -------------------------------------------------------------------------
  // Barge-in
  // -------------------------------------------------------------------------

  private maybeInterrupt(frame: Uint8Array, pcm: Int16Array): void {
    if (!this.params.interruptionEnabled) return;

    // No audio has left yet — TTS is still generating. There is nothing to
    // interrupt, and the caller cannot be reacting to speech they have not
    // heard, so let the detector keep warming up without acting on it.
    if (this.speakingSince === 0) return;

    // Ignore the first moments of our own speech: on a speakerphone the
    // agent's opening syllable echoes back and would instantly interrupt it.
    if (Date.now() - this.speakingSince < BARGE_IN_GUARD_MS) return;

    // The raw noise floor, not vad.threshold: the detector applies its own
    // ratio, and passing an already-scaled threshold applied it twice.
    if (!this.bargeIn.push(pcm, this.vad.floor)) return;

    this.interrupt();

    // Carry the frames that triggered the interruption into the new turn.
    this.beginCapture();
    this.transcriber?.push(frame);
    this.captureFrames++;
  }

  /**
   * Stop talking, immediately.
   *
   * Order matters: kill the audio the caller is hearing first, then stop
   * producing more. Doing it the other way round leaves buffered speech
   * playing while we tear down, which is precisely the "it ignored me" feel
   * that barge-in exists to eliminate.
   */
  private interrupt(): void {
    this.turnId++;

    this.transport.clearBuffer();
    this.playback.clear();

    this.ttsAbort?.abort();
    this.llmAbort?.abort();
    this.ttsAbort = null;
    this.llmAbort = null;

    this.bargeIn.reset();
    this.vad.reset();

    // Record only what the caller actually heard. Storing the full reply would
    // leave the model believing it said something the caller never received,
    // and it will happily refer back to it later.
    if (this.spokenText) {
      const heard = this.truncateToPlayed(this.spokenText);
      const meta = this.pendingTurn;

      this.pushHistory("assistant", heard);
      this.hooks.onTurn?.({
        role: "assistant",
        text: heard,
        at: Date.now(),
        interrupted: true,
        toolsUsed: meta?.toolsUsed,
        sttMs: meta?.sttMs,
        llmMs: meta?.llmMs,
        toolMs: meta?.toolMs,
        ttsMs: meta?.ttsMs,
      });

      this.spokenText = "";
    }

    this.pendingTurn = null;
  }

  /** Estimate how much of a reply was played, from frames actually released. */
  private truncateToPlayed(text: string): string {
    const playedMs = this.playback.playedMs;

    // Rough but adequate: speech runs about 14 characters a second.
    const chars = Math.max(0, Math.floor((playedMs / 1000) * 14));

    if (chars >= text.length) return text;

    const cut = text.slice(0, chars).trimEnd();
    return cut.length > 0 ? `${cut}…` : "…";
  }

  /**
   * A point in the outgoing audio has finished playing.
   *
   * Reached twice for the same mark — once from our own paced queue, once
   * echoed by the transport — so it must be idempotent. Whichever arrives
   * first hands the turn back; the state check makes the second a no-op.
   */
  private onMarkReached(name: string): void {
    if (!name.startsWith("turn:")) return;

    const id = Number(name.slice(5));

    // The reply finished playing without being interrupted.
    if (id !== this.turnId || this.state !== "speaking") return;

    const done = this.pendingTurn;

    if (done && done.turn === id) {
      this.pendingTurn = null;
      this.spokenText = "";

      this.pushHistory("assistant", done.text);
      this.hooks.onTurn?.({
        role: "assistant",
        text: done.text,
        at: Date.now(),
        toolsUsed: done.toolsUsed,
        sttMs: done.sttMs,
        llmMs: done.llmMs,
        toolMs: done.toolMs,
        ttsMs: done.ttsMs,
      });
    }

    this.beginListening();
  }

  // -------------------------------------------------------------------------
  // Turn processing
  // -------------------------------------------------------------------------

  private async finishTurn(): Promise<void> {
    const turn = this.turnId;
    const transcriber = this.transcriber;
    // Snapshot now: beginCapture resets this, and the checks below run after
    // awaits during which a new capture may already have started.
    const speechFrames = this.speechFrames;

    this.transcriber = null;

    if (!transcriber) return;

    /* Too short to be a sentence — a cough, a door, a line pop. Discard it
       without an STT round trip rather than paying for a transcription that
       can only come back as a hallucinated filler word. */
    if (transcriber.frameCount < MIN_UTTERANCE_FRAMES) {
      transcriber.cancel();
      this.beginListening();
      return;
    }

    this.setState("thinking");

    const sttStart = Date.now();
    let text = "";

    try {
      text = await transcriber.end();
    } catch (err) {
      if (turn !== this.turnId) return;

      this.hooks.onError?.(
        err instanceof Error ? err.message : "Transcription failed.",
      );
      this.beginListening();
      return;
    }

    // Checkpoint one: the caller may have spoken again while we transcribed.
    if (turn !== this.turnId || this.closed) return;

    const sttMs = Date.now() - sttStart;

    if (!text.trim()) {
      // Heard something, understood nothing. Ask rather than sit silent.
      await this.say(this.params.fallbackMessage);
      return;
    }

    /* Noise that STT turned into words. Go back to listening WITHOUT speaking:
       the caller said nothing, so a fallback prompt here would have the agent
       talking at a room, and each phantom turn also pushes a fake "user" line
       into history that the model then tries to answer.

       The reprompt timer keeps running, so a genuinely silent line still gets
       nudged by the idle path rather than being ignored forever. */
    if (speechFrames < SPOKEN_FILLER_FRAMES && looksLikeNoise(text)) {
      this.beginListening();
      return;
    }

    this.pushHistory("user", text);
    this.hooks.onTurn?.({ role: "user", text, at: Date.now(), sttMs });

    const llmStart = Date.now();
    this.llmAbort = new AbortController();

    let reply: { text: string; toolsUsed: string[]; toolMs?: number };

    try {
      reply = await runAgent(this.cfg, this.history, this.llmAbort.signal);
    } catch (err) {
      if (turn !== this.turnId) return;

      this.hooks.onError?.(err instanceof Error ? err.message : "Agent failed.");
      await this.say(this.params.fallbackMessage);
      return;
    } finally {
      this.llmAbort = null;
    }

    // Checkpoint two: interruption may have landed while the model thought.
    if (turn !== this.turnId || this.closed) return;

    /* runAgent's elapsed time covers model inference AND any tool round trips
       it made. Report them apart: a slow turn caused by RAG retrieval needs a
       different fix from one caused by the model, and a single combined number
       cannot tell you which you have. */
    const toolMs = reply.toolMs ?? 0;
    const llmMs = Math.max(0, Date.now() - llmStart - toolMs);

    if (!reply.text) {
      await this.say(this.params.fallbackMessage);
      return;
    }

    await this.say(reply.text, {
      llmMs,
      sttMs,
      toolMs: toolMs > 0 ? toolMs : undefined,
      toolsUsed: reply.toolsUsed,
    });
  }

  /** Speak text to the caller, streaming frames as they are generated. */
  private async say(
    text: string,
    meta?: { llmMs?: number; sttMs?: number; toolMs?: number; toolsUsed?: string[] },
  ): Promise<void> {
    const turn = this.turnId;

    this.setState("speaking");

    // Deliberately not started yet: the guard below measures time since audio
    // actually began reaching the caller, and TTS takes a beat to produce its
    // first frame. Starting the clock here would spend the entire guard window
    // waiting on the provider, leaving the opening words uninterruptible.
    this.speakingSince = 0;
    this.spokenText = text;
    this.playback.resetCounter();
    this.bargeIn.reset();

    this.ttsAbort = new AbortController();

    const ttsStart = Date.now();
    let ttsMs: number | undefined;

    try {
      for await (const frame of speak(this.cfg, text, this.ttsAbort.signal)) {
        // Checkpoint three: stop feeding the queue the moment we are cut off.
        if (turn !== this.turnId || this.closed) return;

        if (ttsMs === undefined) {
          ttsMs = Date.now() - ttsStart;
          // First audio is on its way to the caller; the guard starts now.
          this.speakingSince = Date.now();
        }

        this.playback.enqueue([frame]);
      }
    } catch (err) {
      if (turn !== this.turnId || this.closed) return;

      // An aborted stream is an interruption, not a failure.
      if ((err as Error)?.name !== "AbortError") {
        this.hooks.onError?.(
          err instanceof Error ? err.message : "Speech failed.",
        );
        this.beginListening();
      }

      return;
    } finally {
      this.ttsAbort = null;
    }

    if (turn !== this.turnId || this.closed) return;

    // Generation has finished, but the caller is still listening — a few
    // seconds of audio are queued ahead of them. The turn is only genuinely
    // spoken once that queue drains, so the history entry and the completion
    // callback are deferred to the mark below. Recording it here instead would
    // log the full reply even when the caller cuts it off a word later.
    this.pendingTurn = {
      turn,
      text,
      toolsUsed: meta?.toolsUsed,
      sttMs: meta?.sttMs,
      llmMs: meta?.llmMs,
      toolMs: meta?.toolMs,
      ttsMs,
    };

    // Hand back to the caller only once this audio has actually played out.
    this.playback.addMark(`turn:${turn}`);
  }

  /**
   * Say a closing line, then drop the line once it has actually been heard.
   *
   * Hanging up the instant the text is generated would cut off the goodbye
   * mid-word, so this waits for the audio to drain first.
   */
  private async sayThenHangup(text: string): Promise<void> {
    this.farewell = true;
    await this.say(text);
  }

  private beginListening(): void {
    // A farewell just finished playing; the call is over.
    if (this.farewell) {
      this.hangup();
      return;
    }

    if (this.closed) return;

    this.setState("listening");

    this.idleFrames = 0;
    this.captureFrames = 0;
    this.preRoll.clear();
    this.vad.reset();
    this.bargeIn.reset();
  }

  // -------------------------------------------------------------------------

  private pushHistory(role: "user" | "assistant", content: string): void {
    this.history.push({ role, content });

    // Keep the prompt bounded on a long call; the browser page sends unbounded
    // history, which is fine for a short demo but not for a 10-minute call.
    if (this.history.length > 40) {
      this.history = this.history.slice(-40);
    }
  }

  private setState(state: CallState): void {
    if (this.state === state) return;

    this.state = state;
    this.hooks.onState?.(state);
  }

  get currentState(): CallState {
    return this.state;
  }

  get transcript(): ChatTurn[] {
    return [...this.history];
  }

  /** Tear down. Safe to call more than once. */
  end(): void {
    if (this.closed) return;

    this.closed = true;
    this.turnId++;

    this.ttsAbort?.abort();
    this.llmAbort?.abort();
    this.transcriber?.cancel();
    this.playback.dispose();

    this.setState("ended");
    this.hooks.onEnded?.();
  }

  /** End the call and drop the line. */
  hangup(): void {
    this.end();
    this.transport.hangup();
  }
}
