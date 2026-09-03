/**
 * Text-to-speech. Returns raw audio bytes for the browser to play, using the
 * provider, model and voice selected in Settings.
 */

import { keyFor } from "../../lib/providers/env";

export const dynamic = "force-dynamic";

/**
 * ElevenLabs addresses voices by opaque id. These are "premade" voices, which
 * free-tier keys may use; library/professional voices need a paid plan.
 */
const ELEVENLABS_VOICE_IDS: Record<string, string> = {
  Sarah: "EXAVITQu4vr4xnSDxMaL",
  Laura: "FGY2WhTYpPnrIDTdsKH5",
  Roger: "CwhRBWXzGAHq8TQ4Fs17",
  Charlie: "IKne3meq5aSn9XLyUdCD",
  George: "JBFqnCBsd6RMkjVDRZzb",
  Alice: "Xb7hH8MSUJpSbSDYk0k2",
  River: "SAz9YHcvj6GT2YYXdXww",
  Liam: "TX3LPaxmHKxFdv7VOQHJ",
};

const CARTESIA_VOICE_IDS: Record<string, string> = {
  Sophie: "bf0a246a-8642-498a-9950-80c35e9276b5",
  Marcus: "a0e99841-438c-4a64-b679-ae501e7d6091",
  Nova: "3b554273-4299-48b9-9aaf-eefd438e3941",
};

async function speakElevenLabs(
  text: string,
  model: string,
  voice: string,
  key: string,
): Promise<Response> {
  const voiceId = ELEVENLABS_VOICE_IDS[voice] ?? ELEVENLABS_VOICE_IDS.Sarah;

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ text, model_id: model }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
  }

  return new Response(await res.arrayBuffer(), {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}

async function speakCartesia(
  text: string,
  model: string,
  voice: string,
  language: string,
  key: string,
): Promise<Response> {
  const voiceId = CARTESIA_VOICE_IDS[voice] ?? CARTESIA_VOICE_IDS.Sophie;

  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "X-API-Key": key,
      "Cartesia-Version": "2024-06-10",
      "Content-Type": "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      model_id: model,
      transcript: text,
      voice: { mode: "id", id: voiceId },
      language: (language || "en").split("-")[0],
      output_format: {
        container: "mp3",
        encoding: "mp3",
        sample_rate: 44100,
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Cartesia ${res.status}: ${detail.slice(0, 200)}`);
  }

  return new Response(await res.arrayBuffer(), {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}

async function speakSarvam(
  text: string,
  model: string,
  voice: string,
  language: string,
  key: string,
): Promise<Response> {
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "api-subscription-key": key, "Content-Type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      inputs: [text],
      target_language_code:
        language && language !== "auto"
          ? language.includes("-")
            ? language
            : `${language}-IN`
          : "hi-IN",
      speaker: voice.toLowerCase(),
      model,
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

  return new Response(Buffer.from(b64, "base64"), {
    headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  let body: {
    text?: string;
    provider?: string;
    model?: string;
    voice?: string;
    language?: string;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const text = body.text?.trim();
  const provider = body.provider ?? "elevenlabs";
  const model = body.model ?? "eleven_multilingual_v2";
  const voice = body.voice ?? "Sarah";
  const language = body.language ?? "en";

  if (!text) {
    return Response.json({ error: "text is required." }, { status: 400 });
  }

  const key = keyFor(provider);
  if (!key) {
    return Response.json(
      { error: `No API key configured for ${provider}.` },
      { status: 400 },
    );
  }

  try {
    if (provider === "elevenlabs") return await speakElevenLabs(text, model, voice, key);
    if (provider === "cartesia")
      return await speakCartesia(text, model, voice, language, key);
    if (provider === "sarvam")
      return await speakSarvam(text, model, voice, language, key);

    return Response.json(
      { error: `Speech is not wired up for ${provider} yet.` },
      { status: 400 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Speech failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
