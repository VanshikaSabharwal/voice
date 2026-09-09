/**
 * Splitting documents into retrievable pieces.
 *
 * Chunk size is a voice decision, not a storage one. The agent is told to
 * answer in under 40 words, so a 500-token passage is mostly discarded — and
 * every token retrieved is a token the model reads before it can start
 * speaking. Small chunks also sharpen retrieval: one paragraph about refund
 * windows embeds to something much closer to "how long do I have to return
 * this" than a whole policy page does.
 *
 * Markdown headings are the split points wherever they exist, because a
 * heading is an author's own statement of where one topic ends and the next
 * begins. Long sections fall back to paragraph packing.
 */

import type { Chunk } from "./store";

/**
 * Target size in characters, roughly 120-180 tokens of English.
 *
 * A section under this is kept whole even if that leaves it short — splitting
 * a coherent paragraph costs more than an uneven chunk does.
 */
const TARGET_CHARS = 700;

/** Hard ceiling; beyond this a section is packed into several chunks. */
const MAX_CHARS = 1000;

/** Below this a fragment is merged forward rather than stored alone. */
const MIN_CHARS = 120;

type Section = { heading?: string; body: string };

/**
 * Split on ATX headings (`#`..`######`), keeping each heading with the text
 * beneath it. Text before the first heading becomes an untitled section.
 */
function splitByHeadings(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];

  let heading: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) sections.push({ heading, body });
    buffer = [];
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);

    if (m) {
      flush();
      heading = m[2].trim();
      continue;
    }

    buffer.push(line);
  }

  flush();
  return sections;
}

/**
 * Pack paragraphs up to TARGET_CHARS.
 *
 * A paragraph longer than MAX_CHARS on its own is split on sentence
 * boundaries; only if a single sentence still exceeds the ceiling is it cut
 * mid-text, which is rare enough in prose documents to accept.
 */
function packParagraphs(body: string): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    if (para.length > MAX_CHARS) {
      push();

      let sentence = "";

      for (const s of para.split(/(?<=[.!?])\s+/)) {
        if (sentence.length + s.length > TARGET_CHARS && sentence) {
          out.push(sentence.trim());
          sentence = "";
        }
        sentence += (sentence ? " " : "") + s;
      }

      if (sentence.trim()) out.push(sentence.trim());
      continue;
    }

    if (current.length + para.length > TARGET_CHARS && current) push();

    current += (current ? "\n\n" : "") + para;
  }

  push();
  return out;
}

/**
 * Turn one document into chunks.
 *
 * `source` is carried onto every chunk because the agent cites it out loud —
 * "according to the refund policy" — and a caller cannot see a footnote.
 */
export function chunkDocument(source: string, markdown: string): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of splitByHeadings(markdown)) {
    for (const text of packParagraphs(section.body)) {
      chunks.push({
        id: "",
        source,
        heading: section.heading,
        // Prefixing the heading gives the embedding the topic even when the
        // paragraph itself never names it — a passage under "Refunds" that
        // says only "within 30 days of delivery" is otherwise unfindable.
        text: section.heading ? `${section.heading}\n\n${text}` : text,
      });
    }
  }

  // Merge stragglers forward so a trailing one-liner does not become its own
  // chunk, where it would compete with real passages on score.
  const merged: Chunk[] = [];

  for (const chunk of chunks) {
    const prev = merged[merged.length - 1];

    if (
      prev &&
      chunk.text.length < MIN_CHARS &&
      prev.source === chunk.source &&
      prev.text.length + chunk.text.length <= MAX_CHARS
    ) {
      prev.text += `\n\n${chunk.text}`;
      continue;
    }

    merged.push(chunk);
  }

  return merged.map((c, i) => ({ ...c, id: `${source}#${i}` }));
}
