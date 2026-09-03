/**
 * Speech-to-text. Accepts a recorded audio blob as multipart form data and
 * transcribes it with the provider selected in Settings.
 */

import { keyFor } from "../../lib/providers/env";

export const dynamic = "force-dynamic";

/** Guard against oversized uploads; a voice turn is seconds, not minutes. */
const MAX_BYTES = 25 * 1024 * 1024;

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

  console.log("Gemini STT:", {
    model,
    language,
    audioType: audio.type,
    uploadMimeType,
    audioName: audio.name,
    audioSize: audio.size,
  });

  // -------------------------------------------------------------------------
  // 1. Upload audio to Gemini Files API
  // -------------------------------------------------------------------------

  const uploadRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(
      key,
    )}`,
    {
      method: "POST",
      headers: {
        "Content-Type": uploadMimeType,
        "X-Goog-Upload-Protocol": "raw",
        "X-Goog-Upload-File-Name": audio.name || "audio.webm",
      },
      body: bytes,
      signal: AbortSignal.timeout(60000),
    },
  );

  if (!uploadRes.ok) {
    const detail = await uploadRes.text().catch(() => "");

    console.error("Gemini file upload error:", detail);

    throw new Error(
      `Gemini file upload ${uploadRes.status}: ${detail.slice(0, 1000)}`,
    );
  }

  const uploaded = await uploadRes.json();

  console.log("Gemini uploaded file:", uploaded);

  const fileUri = uploaded.file?.uri;
  const mimeType = uploaded.file?.mimeType || uploadMimeType;

  if (!fileUri) {
    throw new Error(
      "Gemini file upload succeeded but no file URI was returned.",
    );
  }

  // -------------------------------------------------------------------------
  // 2. Send uploaded audio to Gemini Transcribe
  // -------------------------------------------------------------------------

  // For "auto", omit the transcription configuration.
  // Gemini will automatically detect the language.
  const body: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [
          {
            fileData: {
              fileUri,
              mimeType,
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

  // Read the response once so we can log the exact Gemini response.
  const rawResponse = await res.text();

  console.log("Gemini STT response:", rawResponse);

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

  // Sarvam and Smallest reject WebM/Opus outright.
  // The client should convert these recordings to WAV first.
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

