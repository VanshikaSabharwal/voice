/**
 * Reading the text off a page image.
 *
 * A page's text is the ground truth every spoken word is aligned against, so
 * a page without it scores 0% however well the child reads. Typing it by hand
 * for a scanned book is tedious enough that it would not happen, so this pulls
 * it off the image instead — and then shows it for correction, because an
 * extraction mistake becomes a word the child is marked wrong for saying
 * correctly.
 *
 * Uses Gemini's vision input through the same inline-data mechanism
 * lib/agent/stt.ts uses for audio. One billed call, made only when an
 * administrator asks for it.
 */

import { envVarFor, keyFor } from "../../app/lib/providers/env";
import { withDeadline } from "../agent/deadline";

/** Generous relative to a voice turn: this is a person waiting on one upload. */
const EXTRACT_TIMEOUT_MS = 30_000;

/**
 * Vision model used for extraction.
 *
 * Deliberately not the configured STT model: that setting chooses a
 * *transcription* model, several of which are audio-only and would fail on an
 * image. READING_OCR_MODEL overrides it.
 */
function model(): string {
  return process.env.READING_OCR_MODEL?.trim() || "gemini-3.6-flash";
}

/**
 * What to ask for when the operator gives no instruction of their own.
 *
 * Every clause here exists because its absence corrupts the score: a returned
 * "I can see a page that says..." preamble becomes words the child never
 * reads and is marked down for omitting, and a transcribed page number does
 * the same.
 */
const DEFAULT_INSTRUCTION =
  "Transcribe the text a child would read aloud from this page.";

const RULES = [
  "Return ONLY the text itself, with no preamble, quotes, commentary or explanation.",
  "Do not include page numbers, headers, footers, or captions printed under illustrations.",
  "Preserve the original wording and spelling exactly; do not correct, translate or simplify.",
  "Keep line and sentence order as printed.",
  "If the page has no readable text at all, return exactly: NO_TEXT",
].join("\n");

export type ExtractInput = {
  bytes: Buffer;
  mimeType: string;
  /** Optional operator instruction, e.g. "only the story, skip the caption". */
  instruction?: string;
};

export type ExtractResult = {
  text: string;
  /** True when the model reported no readable text rather than failing. */
  empty: boolean;
};

export async function extractPageText(
  input: ExtractInput,
): Promise<ExtractResult> {
  const key = keyFor("gemini", "llm");

  if (!key) {
    throw new Error(
      `Reading text from an image needs a Gemini key. Set ${envVarFor("gemini", "llm")}.`,
    );
  }

  const instruction = input.instruction?.trim() || DEFAULT_INSTRUCTION;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model(),
    )}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      cache: "no-store",
      signal: withDeadline(undefined, EXTRACT_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              // Browsers report e.g. "image/jpeg"; strip any parameters the
              // way the audio path does.
              {
                inlineData: {
                  mimeType: input.mimeType.split(";")[0] || "image/jpeg",
                  data: input.bytes.toString("base64"),
                },
              },
              { text: `${instruction}\n\n${RULES}` },
            ],
          },
        ],
        generationConfig: {
          // Transcription, not composition: creativity here invents words the
          // page does not contain.
          temperature: 0,
        },
      }),
    },
  );

  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`Gemini vision ${res.status}: ${raw.slice(0, 500)}`);
  }

  let data: {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Gemini returned an invalid response.");
  }

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();

  if (!text || text === "NO_TEXT") return { text: "", empty: true };

  /* Models sometimes wrap a transcription in a code fence despite being asked
     not to. Left in, the backticks become words on the page. */
  const unfenced = text
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();

  return { text: unfenced, empty: unfenced.length === 0 };
}
