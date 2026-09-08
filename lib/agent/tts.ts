/**
 * Text-to-speech for telephony: 8 kHz mu-law frames, streamed and cancellable.
 *
 * The important discovery behind this module is that both ElevenLabs and
 * Cartesia will emit 8 kHz mu-law directly — the exact format the phone
 * network carries. So there is no decoding step at all: no ffmpeg, no MP3
 * decoder, no Web Audio (which does not exist in Node anyway). Provider bytes
 * are chopped into 160-byte frames and handed to the transport verbatim.
 *
 * Sarvam is the exception. It only returns WAV at its own rate, so that path
 * parses and resamples — the sole place in the engine that touches DSP for
 * output audio.
 *
 * Everything yields through an async iterator so playback can begin before
 * generation finishes, and so an interruption can stop it mid-sentence.
 */

import { keyFor } from "../../app/lib/providers/env";
import type { AgentConfig } from "../../app/lib/types";
import { encodeMulaw, SAMPLE_RATE } from "../audio/mulaw";
import { parseWav, resampleLinear } from "../audio/resample";
import { FrameSplitter } from "../audio/frames";
import { cartesiaVoiceId, elevenLabsVoiceId } from "./voices";
import { TTS_TIMEOUT_MS, withDeadline } from "./deadline";

export type TtsStream = AsyncIterable<Uint8Array>;

/** Cartesia wants a bare language code, not a full BCP-47 tag. */
function langOf(cfg: AgentConfig): string {
  return (cfg.language || "en").split("-")[0];
}

/**
 * Chop a byte stream into whole mu-law frames as it arrives.
 *
 * Shared by every provider path: they differ only in how the bytes are
 * obtained, never in how they are framed.
 */
async function* frameStream(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const splitter = new FrameSplitter();

  for await (const chunk of source) {
    for (const frame of splitter.push(chunk)) yield frame;
  }

  const tail = splitter.flush();
  if (tail) yield tail;
}

/** Read a fetch body as an async iterable of chunks. */
async function* readBody(res: Response): AsyncGenerator<Uint8Array> {
  if (!res.body) {
    yield new Uint8Array(await res.arrayBuffer());
    return;
  }

  const reader = res.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs — streams mu-law 8k straight out of the HTTP endpoint.
// ---------------------------------------------------------------------------

async function* elevenLabs(
  cfg: AgentConfig,
  text: string,
  key: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const voiceId = elevenLabsVoiceId(cfg.tts.voice);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/basic",
      },
      cache: "no-store",
      signal: withDeadline(signal, TTS_TIMEOUT_MS),
      body: JSON.stringify({
        text,
        model_id: cfg.tts.model,
        voice_settings: {
          stability: cfg.tts.stability,
          similarity_boost: cfg.tts.similarityBoost,
        },
      }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
  }

  yield* readBody(res);
}

// ---------------------------------------------------------------------------
// Cartesia — also emits raw mu-law; the HTTP path is used here for symmetry.
// ---------------------------------------------------------------------------

async function* cartesia(
  cfg: AgentConfig,
  text: string,
  key: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "X-API-Key": key,
      "Cartesia-Version": "2024-06-10",
      "Content-Type": "application/json",
    },
    cache: "no-store",
    signal: withDeadline(signal, TTS_TIMEOUT_MS),
    body: JSON.stringify({
      model_id: cfg.tts.model,
      transcript: text,
      voice: { mode: "id", id: cartesiaVoiceId(cfg.tts.voice) },
      language: langOf(cfg),
      output_format: {
        container: "raw",
        encoding: "pcm_mulaw",
        sample_rate: SAMPLE_RATE,
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Cartesia ${res.status}: ${detail.slice(0, 200)}`);
  }

  yield* readBody(res);
}

// ---------------------------------------------------------------------------
// Sarvam — WAV only, so this is the one path that must resample.
// ---------------------------------------------------------------------------

async function* sarvam(
  cfg: AgentConfig,
  text: string,
  key: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const language = cfg.language && cfg.language !== "auto"
    ? cfg.language.includes("-") ? cfg.language : `${cfg.language}-IN`
    : "hi-IN";

  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "api-subscription-key": key, "Content-Type": "application/json" },
    cache: "no-store",
    signal: withDeadline(signal, TTS_TIMEOUT_MS),
    body: JSON.stringify({
      inputs: [text],
      target_language_code: language,
      speaker: cfg.tts.voice.toLowerCase(),
      model: cfg.tts.model,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sarvam TTS ${res.status}: ${detail.slice(0, 200)}`);
  }

  // Sarvam returns base64 WAV strings rather than raw audio bytes.
  const data = await res.json();
  const b64 = data.audios?.[0];

  if (!b64) throw new Error("Sarvam returned no audio.");

  const { pcm, sampleRate } = parseWav(Buffer.from(b64, "base64"));

  yield encodeMulaw(resampleLinear(pcm, sampleRate, SAMPLE_RATE));
}

// ---------------------------------------------------------------------------

/**
 * Speak `text`, yielding 160-byte mu-law frames.
 *
 * Abort the signal to stop generation partway; on a phone call that happens
 * whenever the caller talks over the agent.
 */
export function speak(
  cfg: AgentConfig,
  text: string,
  signal: AbortSignal,
): TtsStream {
  const provider = cfg.tts.provider;
  const key = keyFor(provider);

  if (!key) {
    throw new Error(`No API key configured for ${provider}.`);
  }

  const source =
    provider === "cartesia"
      ? cartesia(cfg, text, key, signal)
      : provider === "sarvam"
        ? sarvam(cfg, text, key, signal)
        : elevenLabs(cfg, text, key, signal);

  return frameStream(source);
}

/** Providers able to produce telephony audio at all. */
export const TELEPHONY_TTS_PROVIDERS = new Set(["elevenlabs", "cartesia", "sarvam"]);
