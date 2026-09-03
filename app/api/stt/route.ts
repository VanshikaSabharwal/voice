/**
 * Speech-to-text. Accepts a recorded audio blob as multipart form data and
 * transcribes it with the provider selected in Settings.
 */

import { keyFor } from "../../lib/providers/env";

export const dynamic = "force-dynamic";

/**
 * Guard against oversized uploads; a voice turn is seconds, not minutes.
 *
 * Also keeps the Gemini path within the ~20MB inline-request ceiling: audio is
 * base64-encoded inline, which inflates it by ~4/3, so 12MB of audio stays
 * comfortably under the limit.
 */
const MAX_BYTES = 12 * 1024 * 1024;

async function transcribeGemini(
  audio: File,
  model: string,
  language: string,
  key: string,
): Promise<string> {
  const bytes = Buffer.from(await audio.arrayBuffer());

  // Browser recordings can report:
  // audio/webm;codecs=opus
  //
  // Gemini expects the container MIME type, so normalize it to:
  // audio/webm
  const uploadMimeType = audio.type.split(";")[0] || "audio/webm";

  if (process.env.NODE_ENV !== "production") {
    console.log("Gemini STT:", {
      model,
      language,
      audioType: audio.type,
      uploadMimeType,
      audioSize: audio.size,
    });
  }

  // Send the audio inline rather than via the Files API. Files exists for
  // payloads too large for a single request; a voice turn is tens of kilobytes,
  // well inside the inline limit. Inlining removes an entire WAN round trip
  // (upload, then generate) from every turn — the bulk of STT latency.
  //
  // MAX_BYTES caps uploads below the inline ceiling, so this path always fits.

  // For "auto", omit the transcription configuration.
  // Gemini will automatically detect the language.
  const body: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: uploadMimeType,
              data: bytes.toString("base64"),
            },
          },
        ],
      },
    ],
  };

  // Only provide a language when the user explicitly selected one.
  if (language && language !== "auto") {
    body.generationConfig = {
      audioTranscriptionConfig: {
        languageCodes: [
          language.includes("-") ? language : `${language}-IN`,
        ],
      },
    };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify(body),
    },
  );

  // Read the response once so the body is available for both logging and parsing.
  const rawResponse = await res.text();

  if (process.env.NODE_ENV !== "production") {
    console.log("Gemini STT response:", rawResponse);
  }

  if (!res.ok) {
    throw new Error(
      `Gemini STT ${res.status}: ${rawResponse.slice(0, 1000)}`,
    );
  }

  let data: any;

  try {
    data = JSON.parse(rawResponse);
  } catch {
    throw new Error("Gemini returned an invalid JSON response.");
  }

  // Dedicated transcription models (gemini-*-transcribe) return the transcript
  // as an `audioTranscription` part; the general multimodal models return an
  // ordinary `text` part for the same request. Accept either shape.
  const text = data.candidates?.[0]?.content?.parts
    ?.map(
      (p: { text?: string; audioTranscription?: { text?: string } }) =>
        p.text ?? p.audioTranscription?.text ?? "",
    )
    .join("")
    .trim();

  return text || "";
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

  // Sarvam expects a full BCP-47 tag.
  // Default to Hindi-India for the Indic path.
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
    headers: {
      "api-subscription-key": key,
    },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");

    console.error("Sarvam STT error:", detail);

    throw new Error(
      `Sarvam STT ${res.status}: ${detail.slice(0, 1000)}`,
    );
  }

  const data = await res.json();

  return (data.transcript ?? "").trim();
}

export async function POST(request: Request) {
  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart form data." },
      { status: 400 },
    );
  }

  const audio = form.get("audio");
  const provider = String(form.get("provider"));
  const model = String(form.get("model") ?? "gpt-4o-transcribe");
  const language = String(form.get("language") ?? "auto");

  if (!(audio instanceof File) || audio.size === 0) {
    return Response.json(
      { error: "No audio supplied." },
      { status: 400 },
    );
  }

  if (audio.size > MAX_BYTES) {
    return Response.json(
      { error: "Audio file too large." },
      { status: 413 },
    );
  }

  const key = keyFor(provider);

  if (!key) {
    return Response.json(
      { error: `No API key configured for ${provider}.` },
      { status: 400 },
    );
  }

  // Sarvam rejects WebM/Opus outright.
  // The client should convert these recordings to WAV first.
  if (provider === "sarvam" && audio.type.toLowerCase().includes("webm")) {
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
      text = await transcribeGemini(
        audio,
        model,
        language,
        key,
      );
    } else if (provider === "sarvam") {
      text = await transcribeSarvam(
        audio,
        model,
        language,
        key,
      );
    } else {
      return Response.json(
        {
          error: `Transcription is not wired up for ${provider} yet.`,
        },
        { status: 400 },
      );
    }

    if (!text) {
      return Response.json(
        {
          error: "Nothing was transcribed. Try speaking for longer.",
        },
        { status: 422 },
      );
    }

    return Response.json({ text });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Transcription failed.";

    console.error("STT error:", err);

    return Response.json(
      { error: message },
      { status: 502 },
    );
  }
}

