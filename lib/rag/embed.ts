/**
 * Text -> vector, via Gemini.
 *
 * One model is used for both ingest and query, which is not optional: vectors
 * from different models are not comparable, so changing EMBED_MODEL means
 * re-running the ingest script.
 *
 * Gemini distinguishes the two directions through `taskType`. Embedding a
 * question with RETRIEVAL_QUERY and a passage with RETRIEVAL_DOCUMENT places
 * them in the same space but accounts for the asymmetry between a short
 * question and the longer passage that answers it — a question and its answer
 * rarely share vocabulary, and this is what closes that gap.
 */

import { keyFor } from "../../app/lib/providers/env";
import { withDeadline } from "../agent/deadline";

export const EMBED_MODEL = "gemini-embedding-001";

/** Output dimensions. 768 is the quality/size sweet spot for this model. */
export const EMBED_DIM = 768;

/** A query embedding sits inside the turn budget, so it gets a tight ceiling. */
const EMBED_TIMEOUT_MS = 8000;

export type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

type EmbedResponse = { embedding?: { values?: number[] } };

/**
 * Embed one string.
 *
 * Returns a unit-length vector so callers can use a plain dot product instead
 * of full cosine similarity — the normalisation is done once here rather than
 * on every comparison at query time.
 */
/**
 * Recently embedded queries.
 *
 * Embedding costs a WAN round-trip (~600 ms measured), which lands squarely
 * inside the turn budget — so a repeated question should not pay it twice.
 * Support lines are repetitive by nature: the same handful of questions arrive
 * all day, and across calls, so this hits more often than it looks like it
 * would. Only queries are cached; document vectors live in the store.
 */
const QUERY_CACHE = new Map<string, Float32Array>();
const QUERY_CACHE_MAX = 256;

export async function embed(
  text: string,
  taskType: TaskType,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const cacheable = taskType === "RETRIEVAL_QUERY";
  const cacheKey = text.trim().toLowerCase();

  if (cacheable) {
    const hit = QUERY_CACHE.get(cacheKey);
    if (hit) return hit;
  }

  const key = keyFor("gemini");

  if (!key) {
    throw new Error("No GOOGLE_API_KEY configured; embeddings need one.");
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      cache: "no-store",
      signal: withDeadline(signal, EMBED_TIMEOUT_MS),
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBED_DIM,
      }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini embed ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data: EmbedResponse = await res.json();
  const values = data.embedding?.values;

  if (!values?.length) throw new Error("Gemini returned an empty embedding.");

  const vector = normalize(Float32Array.from(values));

  if (cacheable) {
    // Plain FIFO eviction: Map preserves insertion order, so the oldest key is
    // the first one iteration yields. Not LRU, but at this size the difference
    // does not justify tracking access times.
    if (QUERY_CACHE.size >= QUERY_CACHE_MAX) {
      QUERY_CACHE.delete(QUERY_CACHE.keys().next().value!);
    }
    QUERY_CACHE.set(cacheKey, vector);
  }

  return vector;
}

/**
 * Scale a vector to unit length, in place.
 *
 * Only meaningful for a non-zero vector; a zero vector is returned unchanged
 * rather than producing NaNs.
 */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];

  const mag = Math.sqrt(sum);
  if (mag === 0) return v;

  for (let i = 0; i < v.length; i++) v[i] /= mag;
  return v;
}

/**
 * Similarity between two unit vectors.
 *
 * This is cosine similarity, but since both sides are already normalised the
 * division drops out and it reduces to a dot product. Range is [-1, 1]; for
 * text embeddings anything above ~0.5 is a meaningful match.
 */
export function similarity(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
