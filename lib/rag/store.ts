/**
 * The vector store: chunks, their embeddings, and nearest-neighbour search.
 *
 * A flat array scanned linearly, not a vector database. For the scale this is
 * built for — tens of documents, low thousands of chunks — an exhaustive scan
 * of unit vectors is a few milliseconds, which is well inside a turn's budget
 * and beats any hosted index once its network hop is counted. An approximate
 * index only starts to pay above roughly 10^5 chunks.
 *
 * Loaded once and cached, because re-reading and re-parsing the file on every
 * question would dominate the search itself.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { EMBED_DIM, similarity } from "./embed";

export type Chunk = {
  /** Stable id: "<source>#<index>". */
  id: string;
  /** Display name of the document, spoken aloud by the agent. */
  source: string;
  /** Heading path within the document, when one was found. */
  heading?: string;
  text: string;
};

/** What the ingest script writes and this module reads. */
export type VectorFile = {
  model: string;
  dim: number;
  createdAt: number;
  chunks: Chunk[];
  /** Flat Float32 values, chunks.length * dim, base64-encoded. */
  vectors: string;
};

export type SearchHit = Chunk & { score: number };

const STORE_PATH = path.join(process.cwd(), ".data", "vectors.json");

/**
 * Score below which a chunk is treated as irrelevant.
 *
 * Calibrated against this model rather than chosen for roundness. Gemini
 * embeddings put genuine matches around 0.70 and unrelated text around 0.55 —
 * a narrow gap, because everything in one corpus shares a register. 0.62 sits
 * between them. Too low and an off-topic question ("do you hire interns")
 * retrieves the refund policy, which the model will then answer from; too high
 * and a legitimate but oddly-worded question retrieves nothing.
 *
 * Worth re-checking against real questions after ingesting real documents.
 */
const DEFAULT_MIN_SCORE = 0.62;

type Loaded = { chunks: Chunk[]; matrix: Float32Array; dim: number };

let cache: Loaded | null = null;
let loadFailed = false;

/**
 * Read the store from disk, once.
 *
 * A missing file is not an error: it means the ingest script has not been run,
 * and the agent should simply behave as though it has no documents rather than
 * failing the call. The failure is remembered so a missing file does not cause
 * a disk read on every single question.
 */
async function load(): Promise<Loaded | null> {
  if (cache) return cache;
  if (loadFailed) return null;

  let raw: string;

  try {
    raw = await readFile(STORE_PATH, "utf8");
  } catch {
    loadFailed = true;
    return null;
  }

  const file: VectorFile = JSON.parse(raw);
  const buf = Buffer.from(file.vectors, "base64");

  // Copy into an aligned ArrayBuffer: Buffer instances are views into a shared
  // pool at arbitrary byte offsets, and Float32Array requires 4-byte alignment.
  const aligned = new ArrayBuffer(buf.byteLength);
  new Uint8Array(aligned).set(buf);

  cache = {
    chunks: file.chunks,
    matrix: new Float32Array(aligned),
    dim: file.dim ?? EMBED_DIM,
  };

  return cache;
}

/** Drop the cache so the next search re-reads the file. */
export function invalidate(): void {
  cache = null;
  loadFailed = false;
}

/** True when an ingested store exists. */
export async function isReady(): Promise<boolean> {
  return (await load()) !== null;
}

/**
 * The `k` chunks closest to `queryVector`.
 *
 * `minScore` discards weak matches outright. Returning the best of a bad set
 * is worse than returning nothing here: the model treats retrieved text as
 * authoritative, so a passage about billing offered for a question about
 * refunds invites a confidently wrong answer. Better that the agent say it
 * does not know.
 */
export async function search(
  queryVector: Float32Array,
  k = 3,
  minScore = DEFAULT_MIN_SCORE,
): Promise<SearchHit[]> {
  const store = await load();
  if (!store) return [];

  const { chunks, matrix, dim } = store;
  const hits: SearchHit[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const score = similarity(queryVector, matrix.subarray(i * dim, (i + 1) * dim));
    if (score >= minScore) hits.push({ ...chunks[i], score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

export { STORE_PATH };
