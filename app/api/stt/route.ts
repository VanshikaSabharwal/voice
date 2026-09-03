/**
 * Speech-to-text. Accepts a recorded audio blob as multipart form data and
 * transcribes it with the provider selected in Settings.
 */

import { keyFor } from "../../lib/providers/env";

export const dynamic = "force-dynamic";

/** Guard against oversized uploads; a voice turn is seconds, not minutes. */
const MAX_BYTES = 25 * 1024 * 1024;

// async function transcribeOpenAI(
//   audio: File,
//   model: string,
//   language: string,
//   key: string,
// ): Promise<string> {
//   const form = new FormData();
//   form.append("file", audio, audio.name || "audio.webm");
//   form.append("model", model);
//   // "auto" means let the model detect it — omit the parameter entirely.
//   if (language && language !== "auto") {
//     form.append("language", language.split("-")[0]);
//   }

//   const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
//     method: "POST",
//     headers: { Authorization: `Bearer ${key}` },
//     body: form,
//     cache: "no-store",
//     signal: AbortSignal.timeout(60000),
//   });

//   if (!res.ok) {
//     const detail = await res.text().catch(() => "");
//     throw new Error(`OpenAI STT ${res.status}: ${detail.slice(0, 200)}`);
//   }

//   const data = await res.json();
//   return (data.text ?? "").trim();
// }

async function transcribeGemini(
  audio: File,
  model: string,
  language: string,
  key: string,
): Promise<string> {
  const bytes = Buffer.from(await audio.arrayBuffer()).toString("base64");
  const hint =
    language && language !== "auto"
      ? ` The audio is in ${language}.`
      : "";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Transcribe this audio verbatim. Return only the transcript with no commentary.${hint}`,
              },
              {
                inlineData: {
                  mimeType: audio.type || "audio/webm",
                  data: bytes,
                },
              },
            ],
          },
        ],
      }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini STT ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p: { text?: string }) => p.text ?? "")
    .join("")
    .trim();
}

async function transcribeSarvam(
  audio: File,
  model: string,
  language: string,
  key: string,
): Promise<string> {
  // Sarvam rejects WebM/Opus; the client re-encodes to WAV before upload, so
  // forward the blob under a name matching its actual container.
  const name = audio.type.includes("wav")
    ? "audio.wav"
    : audio.type.includes("mpeg") || audio.type.includes("mp3")
      ? "audio.mp3"
      : audio.name || "audio.wav";

  const form = new FormData();
  form.append("file", audio, name);
  form.append("model", model);
  // Sarvam expects a full BCP-47 tag; default to Hindi-India for the Indic path.
  form.append(
    "language_code",
    language && language !== "auto"
      ? language.includes("-")
        ? language
        : `${language}-IN`
      : "hi-IN",
  );

  const res = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sarvam STT ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.transcript ?? "").trim();
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data." }, { status: 400 });
  }

  const audio = form.get("audio");
  const provider = String(form.get("provider") ?? "openai");
  const model = String(form.get("model") ?? "gpt-4o-transcribe");
  const language = String(form.get("language") ?? "auto");

  if (!(audio instanceof File) || audio.size === 0) {
    return Response.json({ error: "No audio supplied." }, { status: 400 });
  }
  if (audio.size > MAX_BYTES) {
    return Response.json({ error: "Audio file too large." }, { status: 413 });
  }

  const key = keyFor(provider);
  if (!key) {
    return Response.json(
      { error: `No API key configured for ${provider}.` },
      { status: 400 },
    );
  }

  // Sarvam and Smallest reject WebM/Opus outright. The client converts to WAV
  // first, so reaching here with WebM means that conversion failed.
  if (
    (provider === "sarvam" || provider === "smallest") &&
    audio.type.toLowerCase().includes("webm")
  ) {
    return Response.json(
      {
        error: `${provider} cannot accept WebM audio. Audio conversion to WAV failed in the browser.`,
      },
      { status: 415 },
    );
  }

  try {
    let text: string;
    if (provider === "gemini") {
      text = await transcribeGemini(audio, model, language, key);
    } else if (provider === "sarvam") {
      text = await transcribeSarvam(audio, model, language, key);
    }
    //  else if (provider === "openai") {
    //   text = await transcribeOpenAI(audio, model, language, key);
    // } 
    else {
      return Response.json(
        { error: `Transcription is not wired up for ${provider} yet.` },
        { status: 400 },
      );
    }

    if (!text) {
      return Response.json(
        { error: "Nothing was transcribed. Try speaking for longer." },
        { status: 422 },
      );
    }

    return Response.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
