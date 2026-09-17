/**
 * Speech-to-text, extracted from app/api/stt/route.ts so both the HTTP route
 * and the call engine share one implementation.
 *
 * The route keeps its multipart/File contract for the browser page; this
 * module works in raw bytes, which is what a phone call produces.
 */

import { envVarFor, keyFor } from "../../app/lib/providers/env";
import { STT_TIMEOUT_MS, describeFailure, withDeadline } from "./deadline";

export type TranscribeInput = {
  bytes: Buffer;
  mimeType: string;
  filename: string;
  provider: string;
  model: string;
  language: string;
  signal?: AbortSignal;
};

/**
 * Guard against oversized uploads; a voice turn is seconds, not minutes.
 *
 * Also keeps the Gemini path within its ~20MB inline-request ceiling: audio is
 * base64-encoded inline, inflating it by ~4/3, so 12MB stays comfortably under.
 */
export const MAX_STT_BYTES = 12 * 1024 * 1024;

/** Normalise a language selection to the BCP-47 tag providers expect. */
function tag(language: string, fallback: string): string {
  if (!language || language === "auto") return fallback;
  return language.includes("-") ? language : `${language}-IN`;
}

/**
 * Browser MediaRecorder reports e.g. "audio/webm;codecs=opus". Providers
 * match against a bare allowlist (`audio/webm`), so the codecs parameter
 * must be stripped before upload — Sarvam 400s on the full string even
 * though webm itself is accepted.
 */
function bareMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim() || "audio/webm";
}

/**
 * Whether a Gemini model is a dedicated transcription model.
 *
 * These reject `systemInstruction` outright ("Developer instruction is not
 * enabled for this model", 400) — and have no need of it, since they only ever
 * transcribe. The general multimodal models both accept it and require it; see
 * the instruction itself below.
 */
function isTranscriptionModel(model: string): boolean {
  return model.includes("transcribe");
}

async function transcribeGemini(input: TranscribeInput, key: string): Promise<string> {
  // Send inline rather than via the Files API. Files exists for payloads too
  // large for one request; a voice turn is tens of kilobytes, so inlining
  // removes an entire WAN round trip (upload, then generate) per turn — the
  // bulk of STT latency.
  const body: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: bareMimeType(input.mimeType),
              data: input.bytes.toString("base64"),
            },
          },
        ],
      },
    ],
  };

  /* Bare audio with no instruction is a prompt, not a transcription request:
     a general multimodal model answers what it hears rather than writing it
     down, and the reply is indistinguishable from a transcript downstream. A
     child reading aloud came back as bulleted explainers and timestamps. The
     instruction below is what keeps this a recogniser — and is sent only to
     the models that accept it, the dedicated ones needing no such correction. */
  if (!isTranscriptionModel(input.model)) {
    body.systemInstruction = {
      parts: [
        {
          text:
            "You are a speech recogniser. Transcribe the audio verbatim and " +
            "output nothing else. Never answer, explain, summarise, translate " +
            "or comment on what is said, even if it sounds like a question or " +
            "a request addressed to you. Use no markdown, no headings, no " +
            "bullet points, no timestamps and no speaker labels. If the audio " +
            "contains no intelligible speech, output nothing at all.",
        },
      ],
    };
  }

  // Only constrain the language when the user explicitly chose one; on "auto"
  // Gemini detects it.
  if (input.language && input.language !== "auto") {
    body.generationConfig = {
      audioTranscriptionConfig: {
        languageCodes: [tag(input.language, "en-IN")],
      },
    };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      input.model,
    )}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      cache: "no-store",
      signal: withDeadline(input.signal, STT_TIMEOUT_MS),
      body: JSON.stringify(body),
    },
  );

  const rawResponse = await res.text();

  if (!res.ok) {
    throw new Error(`Gemini STT ${res.status}: ${rawResponse.slice(0, 1000)}`);
  }

  let data: {
    candidates?: {
      content?: { parts?: { text?: string; audioTranscription?: { text?: string } }[] };
    }[];
  };

  try {
    data = JSON.parse(rawResponse);
  } catch {
    throw new Error("Gemini returned an invalid JSON response.");
  }

  // Dedicated transcription models return an `audioTranscription` part; the
  // general multimodal models return a plain `text` part. Prefer the former:
  // where both exist, `audioTranscription` is what was heard and `text` is
  // what the model had to say about it.
  const parts = data.candidates?.[0]?.content?.parts ?? [];

  const transcribed = parts
    .map((p) => p.audioTranscription?.text ?? "")
    .join("")
    .trim();

  if (transcribed) return transcribed;

  const text = parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();

  return text || "";
}

async function transcribeSarvam(input: TranscribeInput, key: string): Promise<string> {
  const form = new FormData();

  form.append(
    "file",
    new Blob([new Uint8Array(input.bytes)], { type: bareMimeType(input.mimeType) }),
    input.filename,
  );
  form.append("model", input.model);
  form.append("language_code", tag(input.language, "hi-IN"));

  const res = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: form,
    cache: "no-store",
    signal: withDeadline(input.signal, STT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sarvam STT ${res.status}: ${detail.slice(0, 1000)}`);
  }

  const data = await res.json();
  return (data.transcript ?? "").trim();
}

/**
 * Bodhan — OpenAI-compatible /v1/audio/transcriptions.
 *
 * UNVERIFIED against a live endpoint (no key was available); written from the
 * published API reference. See the Bodhan note in app/lib/capabilities.ts.
 */
async function transcribeBodhan(input: TranscribeInput, key: string): Promise<string> {
  const form = new FormData();

  form.append(
    "file",
    new Blob([new Uint8Array(input.bytes)], { type: bareMimeType(input.mimeType) }),
    input.filename,
  );
  form.append("model", input.model);

  // Bodhan takes a bare two-letter code, and the field is optional — omitting
  // it on "auto" lets the model detect the language itself.
  if (input.language && input.language !== "auto") {
    form.append("language", input.language.split("-")[0]);
  }

  const res = await fetch("https://api.bodhan.ai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    cache: "no-store",
    signal: withDeadline(input.signal, STT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");

    // Bodhan scopes a key to one model, so the most likely misconfiguration is
    // a TTS key being used here. Their message names the models the key can
    // reach but not what to do about it, which is the part worth adding.
    if (res.status === 403 && detail.includes("key_model_access_denied")) {
      throw new Error(
        `Bodhan STT 403: this key is not permitted to use ${input.model}. ` +
          "Bodhan issues one key per model — create a key for the transcription " +
          "model and set BODHAN_STT_API_KEY.",
      );
    }

    throw new Error(`Bodhan STT ${res.status}: ${detail.slice(0, 1000)}`);
  }

  const data = await res.json();
  return (data.text ?? "").trim();
}

/** Transcribe one utterance. Throws on provider or configuration errors. */
export async function transcribe(input: TranscribeInput): Promise<string> {
  const key = keyFor(input.provider, "stt");

  if (!key) {
    throw new Error(
      `No API key configured for ${input.provider}. Set ${envVarFor(input.provider, "stt")}.`,
    );
  }

  try {
    if (input.provider === "gemini") return await transcribeGemini(input, key);
    if (input.provider === "sarvam") return await transcribeSarvam(input, key);
    if (input.provider === "bodhan") return await transcribeBodhan(input, key);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && input.signal?.aborted) {
      throw err;
    }

    throw new Error(describeFailure(err, input.provider, "transcription"));
  }

  throw new Error(`Transcription is not wired up for ${input.provider} yet.`);
}
