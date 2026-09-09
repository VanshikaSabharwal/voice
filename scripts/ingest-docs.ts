/**
 * Build the vector store from Markdown/text documents.
 *
 * Run: npm run ingest [docs-dir]      (default: ./docs)
 *
 * Ingest is the slow half of RAG and it happens once, offline — so this
 * favours clarity and resumability over speed. Query time is what has to stay
 * inside a phone call's budget, not this.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "../lib/env";

loadEnv();

import { embed, EMBED_MODEL, EMBED_DIM } from "../lib/rag/embed";
import { chunkDocument } from "../lib/rag/chunk";
import { STORE_PATH, type Chunk, type VectorFile } from "../lib/rag/store";

const DOCS_DIR = path.resolve(process.argv[2] ?? "docs");

/** Gemini's embed endpoint takes one input per request; this bounds concurrency. */
const CONCURRENCY = 8;

const EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/** Recurse so documents can be filed in subdirectories. */
async function collect(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collect(full)));
      continue;
    }

    if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }

  return files.sort();
}

/**
 * A readable document name, used as the spoken citation.
 *
 * "refund-policy.md" becomes "Refund Policy", which is what the agent should
 * say out loud rather than a filename.
 */
function titleOf(file: string): string {
  return path
    .basename(file, path.extname(file))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Embed with bounded concurrency, retrying the transient failures. */
async function embedAll(chunks: Chunk[]): Promise<Float32Array[]> {
  const vectors = new Array<Float32Array>(chunks.length);
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= chunks.length) return;

      for (let attempt = 0; ; attempt++) {
        try {
          vectors[i] = await embed(chunks[i].text, "RETRIEVAL_DOCUMENT");
          break;
        } catch (err) {
          // 429 and 5xx are worth retrying; anything else is a real error and
          // failing fast beats burning quota on a request that cannot succeed.
          const msg = err instanceof Error ? err.message : String(err);
          const retryable = /\b(429|5\d\d)\b/.test(msg) || /timed out/i.test(msg);

          if (!retryable || attempt >= 4) throw err;

          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }

      if (++done % 25 === 0 || done === chunks.length) {
        process.stdout.write(`\r  embedded ${done}/${chunks.length}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker),
  );

  process.stdout.write("\n");
  return vectors;
}

(async () => {
  let files: string[];

  try {
    files = await collect(DOCS_DIR);
  } catch {
    console.error(`\nNo such directory: ${DOCS_DIR}`);
    console.error("Create it and add .md or .txt files, or pass a path:\n");
    console.error("  npm run ingest -- path/to/docs\n");
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`\nNo .md or .txt files under ${DOCS_DIR}\n`);
    process.exit(1);
  }

  console.log(`\ningesting ${files.length} document(s) from ${DOCS_DIR}\n`);

  const chunks: Chunk[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const docChunks = chunkDocument(titleOf(file), text);

    chunks.push(...docChunks);
    console.log(`  ${path.relative(DOCS_DIR, file).padEnd(40)} ${docChunks.length} chunks`);
  }

  if (chunks.length === 0) {
    console.error("\nDocuments contained no text.\n");
    process.exit(1);
  }

  console.log(`\n${chunks.length} chunks -> ${EMBED_MODEL} (${EMBED_DIM}d)\n`);

  const t0 = Date.now();
  const vectors = await embedAll(chunks);

  // One flat Float32 buffer rather than nested JSON arrays: the file is ~4x
  // smaller and loads without parsing a million numbers.
  const flat = new Float32Array(chunks.length * EMBED_DIM);
  vectors.forEach((v, i) => flat.set(v, i * EMBED_DIM));

  const file: VectorFile = {
    model: EMBED_MODEL,
    dim: EMBED_DIM,
    createdAt: Date.now(),
    chunks,
    vectors: Buffer.from(flat.buffer).toString("base64"),
  };

  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(file));

  const mb = (Buffer.byteLength(JSON.stringify(file)) / 1024 / 1024).toFixed(1);

  console.log(
    `\nwrote ${STORE_PATH}` +
      `\n  ${chunks.length} chunks, ${mb} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
  );
})();
