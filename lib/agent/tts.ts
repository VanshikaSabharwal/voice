/**
 * Text-to-speech for telephony: 8 kHz mu-law frames, streamed and cancellable.
 *
 * The important discovery behind this module is that both ElevenLabs and
 * Cartesia will emit 8 kHz mu-law directly — the exact format the phone
 * network carries. So there is no decoding step at all: no ffmpeg, no MP3
 * decoder, no Web Audio (which does not exist in Node anyway). Provider bytes
 * are chopped into 160-byte frames and handed to the transport verbatim.
 *
 * Sarvam and Gemini are the exceptions, and are where the engine's only output
 * DSP lives: Sarvam returns WAV at its own rate, Gemini headerless PCM16 at
 * 24 kHz, so both parse and resample down to 8 kHz.
 *
 * Everything yields through an async iterator so playback can begin before
 * generation finishes, and so an interruption can stop it mid-sentence. Note
 * that the two resampling providers are single-shot APIs: they yield one blob
 * at the end rather than streaming, so an interruption can still cut playback
 * short but cannot save the generation cost the way it does on the others.
 */

import { envVarFor, keyFor } from "../../app/lib/providers/env";
import type { AgentConfig } from "../../app/lib/types";
import { encodeMulaw, SAMPLE_RATE } from "../audio/mulaw";
import { parseWav, resampleLinear } from "../audio/resample";
import { FrameSplitter } from "../audio/frames";
import { cartesiaVoiceId, elevenLabsVoiceId } from "./voices";
import { TTS_TIMEOUT_MS, withDeadline } from "./deadline";
import * as cache from "./tts-cache";
import { cacheKey } from "./tts-cache";

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
// Bodhan — OpenAI-shaped endpoint returning WAV, so it resamples too.
// ---------------------------------------------------------------------------

async function* bodhan(
  cfg: AgentConfig,
  text: string,
  key: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const res = await fetch("https://api.bodhan.ai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    signal: withDeadline(signal, TTS_TIMEOUT_MS),
    body: JSON.stringify({
      model: cfg.tts.model,
      input: text,
      voice: cfg.tts.voice,
      // Bodhan takes the language as a JSON *string*, not a nested object, and
      // wants a bare two-letter code — so "en-IN" must be trimmed to "en".
      instructions: JSON.stringify({ lang: langOf(cfg) }),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");

    // Mirror of the STT path: a key scoped to the transcription model cannot
    // synthesize, and the raw message does not say which variable to set.
    if (res.status === 403 && detail.includes("key_model_access_denied")) {
      throw new Error(
        `Bodhan TTS 403: this key is not permitted to use ${cfg.tts.model}. ` +
          "Bodhan issues one key per model — create a key for the speech model " +
          "and set BODHAN_TTS_API_KEY.",
      );
    }

    throw new Error(`Bodhan TTS ${res.status}: ${detail.slice(0, 200)}`);
  }

  // Returns audio/wav (PCM16 24 kHz mono) as raw bytes, not base64 JSON.
  const { pcm, sampleRate } = parseWav(Buffer.from(await res.arrayBuffer()));

  yield encodeMulaw(resampleLinear(pcm, sampleRate, SAMPLE_RATE));
}

// ---------------------------------------------------------------------------
// Gemini — raw PCM16 at its own rate, so this path resamples like Sarvam's.
// ---------------------------------------------------------------------------

/** Default when a response omits the rate; every model observed emits 24 kHz. */
const GEMINI_DEFAULT_RATE = 24000;

/**
 * Pull the sample rate out of an L16 mime type.
 *
 * The models are not consistent about how they spell it — one returns
 * "audio/l16; rate=24000; channels=1" and another "audio/L16;codec=pcm;rate=24000"
 * — so this matches case-insensitively on the rate parameter rather than
 * assuming a fixed string or a fixed rate.
 */
function pcmRateOf(mimeType: string | undefined): number {
  const match = /rate=(\d+)/i.exec(mimeType ?? "");
  return match ? Number(match[1]) : GEMINI_DEFAULT_RATE;
}

async function* gemini(
  cfg: AgentConfig,
  text: string,
  key: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      cfg.tts.model,
    )}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      cache: "no-store",
      signal: withDeadline(signal, TTS_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: cfg.tts.voice },
            },
          },
        },
      }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini TTS ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data: {
    candidates?: {
      content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    }[];
  } = await res.json();

  const audio = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
    ?.inlineData;

  if (!audio?.data) throw new Error("Gemini returned no audio.");

  // Headerless PCM16 little-endian — there is no WAV container to parse, so
  // the bytes are reinterpreted as samples directly.
  const bytes = Buffer.from(audio.data, "base64");
  const pcm = new Int16Array(bytes.length >> 1);

  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = bytes.readInt16LE(i * 2);
  }

  yield encodeMulaw(resampleLinear(pcm, pcmRateOf(audio.mimeType), SAMPLE_RATE));
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
  const key = keyFor(provider, "tts");

  if (!key) {
    throw new Error(
      `No API key configured for ${provider}. Set ${envVarFor(provider, "tts")}.`,
    );
  }

  const cacheId = cacheKey(cfg, text);
  const cached = cache.get(cacheId);

  if (cached) return replay(cached, signal);

  const source =
    provider === "cartesia"
      ? cartesia(cfg, text, key, signal)
      : provider === "sarvam"
        ? sarvam(cfg, text, key, signal)
        : provider === "gemini"
          ? gemini(cfg, text, key, signal)
          : provider === "bodhan"
            ? bodhan(cfg, text, key, signal)
            : elevenLabs(cfg, text, key, signal);

  return collecting(cacheId, text, frameStream(source));
}

/**
 * Yield cached frames.
 *
 * Still honours the abort signal: a cached greeting must be as interruptible
 * as a generated one, or barge-in would stop working on exactly the lines most
 * likely to be talked over.
 */
async function* replay(
  frames: Uint8Array[],
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for (const frame of frames) {
    if (signal.aborted) return;
    yield frame;
  }
}

/**
 * Pass frames through, keeping a copy, and cache it only if the stream ends
 * cleanly.
 *
 * The generator simply stops being iterated when a turn is interrupted, so
 * `return` runs but the loop body does not reach the end — which is why the
 * commit sits after the loop rather than in a `finally`. Caching a partial
 * would replay the truncation on every future call.
 */
async function* collecting(
  key: string,
  text: string,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const frames: Uint8Array[] = [];

  for await (const frame of source) {
    frames.push(frame);
    yield frame;
  }

  cache.set(key, frames, text);
}

/** Providers able to produce telephony audio at all. */
export const TELEPHONY_TTS_PROVIDERS = new Set([
  "elevenlabs",
  "cartesia",
  "sarvam",
  "gemini",
  "bodhan",
]);
