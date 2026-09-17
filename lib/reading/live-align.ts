/**
 * Incremental aligner for streaming ASR partials.
 *
 * The previous live path (alignLive) re-ran over the accumulated transcript on
 * every chunk arrival, so earlier words could be relabelled as the transcript
 * grew — which is how a correctly read word failed to stay green. This one
 * keeps a single forward-moving cursor and never revises a word it has marked.
 *
 * Streaming recognisers (Gemini Live) emit two kinds of result:
 *
 *   - interim events: a growing, provisional hypothesis for the phrase in
 *     progress. Used ONLY to paint an immediate preview past the reading
 *     frontier — the words a child sees light up are provisional, mirrored
 *     from what the recogniser currently thinks it heard.
 *   - final events: an authoritative segment, emitted when the recogniser ends
 *     a phrase. These are the only words ever COMMITTED: they advance the
 *     pinned cursor, become permanent page marks, and are what get submitted
 *     for the authoritative server score.
 *
 * So the pipeline is: preview greens instantly (UI latency), commit only the
 * stable words (accuracy), and the report card is computed from exactly what
 * was committed — the green words and the score can't disagree.
 */

import type { MarkKind, WordMark } from "./types";
import { tokenize, wordsClose, wordsMatch } from "./align";

/** How far ahead the cursor may jump for a spoken word to count as a skip. */
const LIVE_LOOKAHEAD = 5;

/** After this many unmatched spoken words, force a substitution to resync. */
const LIVE_FORCE_ADVANCE = 2;

/** How the page looks at one moment while the child is reading. */
export type LiveMarks = {
  /** Marks per page-word index; words past the reading frontier are absent. */
  byIndex: ReadonlyMap<number, WordMark>;
  /** Insertions in the order they were spoken. */
  insertions: readonly WordMark[];
  /** Number of page words the reading frontier has consumed. */
  reached: number;
};

/**
 * The walker that consumes one spoken word against the page. Returns marks it
 * produced (page words crossed, and an optional insertion) so callers can
 * record them in their own structures.
 */
function step(
  pageWords: string[],
  cursor: number,
  unmatchedStreak: number,
  spokenWord: string,
): { cursor: number; unmatchedStreak: number; produced: WordMark[] } {
  const produced: WordMark[] = [];

  if (cursor >= pageWords.length) {
    produced.push({
      index: -1,
      expected: "",
      spoken: spokenWord,
      kind: "inserted",
    });
    return { cursor, unmatchedStreak, produced };
  }

  let found = -1;
  let close = false;

  for (
    let ahead = 0;
    ahead <= LIVE_LOOKAHEAD && cursor + ahead < pageWords.length;
    ahead++
  ) {
    const candidate = pageWords[cursor + ahead];

    if (wordsMatch(candidate, spokenWord)) {
      found = cursor + ahead;
      close = false;
      break;
    }

    if (found < 0 && wordsClose(candidate, spokenWord)) {
      found = cursor + ahead;
      close = true;
    }
  }

  if (found >= 0) {
    while (cursor < found) {
      produced.push({
        index: cursor,
        expected: pageWords[cursor],
        spoken: "",
        kind: "omitted",
      });
      cursor++;
    }

    produced.push({
      index: cursor,
      expected: pageWords[cursor],
      spoken: spokenWord,
      kind: close ? "substituted" : "correct",
    });
    cursor++;
    return { cursor, unmatchedStreak: 0, produced };
  }

  if (unmatchedStreak >= LIVE_FORCE_ADVANCE) {
    produced.push({
      index: cursor,
      expected: pageWords[cursor],
      spoken: spokenWord,
      kind: "substituted",
    });
    return { cursor: cursor + 1, unmatchedStreak: 0, produced };
  }

  produced.push({
    index: -1,
    expected: "",
    spoken: spokenWord,
    kind: "inserted",
  });
  return { cursor, unmatchedStreak: unmatchedStreak + 1, produced };
}

/** Advance a derived preview cursor (not the committed one) over a word. */
function previewStep(pageWords: string[], cursor: number, spokenWord: string): number {
  const out = step(pageWords, cursor, 0, spokenWord);
  return out.cursor;
}

export type IncrementalAligner = {
  /** A finalized ASR segment. Authoritative — commits its words permanently. */
  commit(text: string): void;
  /** The latest interim hypothesis. Paints an immediate, throwaway preview. */
  preview(text: string): void;
  /** Committed marks plus the provisional preview past the frontier. */
  snapshot(): LiveMarks;
  /** The committed words, joined — exactly what should be scored. */
  transcript(): string;
};

export function createIncrementalAligner(pageWords: string[]): IncrementalAligner {
  /* Committed spoken words, in order, from finals only. Drives the score. */
  let spoken: string[] = [];

  /* The page words consumed by committed words. Marks are written once and
     never overwritten. */
  let cursor = 0;
  const byIndex = new Map<number, WordMark>();
  const insertions: WordMark[] = [];

  let unmatchedStreak = 0;

  /* The current provisional hypothesis, painted but not committed. */
  let provisional: string[] = [];

  return {
    commit(text: string): void {
      const words = tokenize(text);
      if (words.length === 0) return;

      /* Discard any preview-only state; a committed segment is authoritative
         for everything up to this point. */
      provisional = [];

      /* A final occasionally repeats the exact last committed word (segment
         boundaries drawn at a word boundary). Skip that single overlap. */
      const start = spoken[spoken.length - 1] === words[0] ? 1 : 0;

      const fresh = words.slice(start);
      spoken = spoken.concat(fresh);

      for (const written of fresh) {
        const result = step(pageWords, cursor, unmatchedStreak, written);
        cursor = result.cursor;
        unmatchedStreak = result.unmatchedStreak;

        for (const mark of result.produced) {
          if (mark.index >= 0) byIndex.set(mark.index, mark);
          else insertions.push(mark);
        }
      }
    },

    preview(text: string): void {
      provisional = tokenize(text);

      if (provisional.length > 0 && provisional[0] === spoken[spoken.length - 1]) {
        /* The recogniser keeps the last committed word in its running
           hypothesis; don't let the preview re-consume it. */
        provisional = provisional.slice(1);
      }
    },

    snapshot(): LiveMarks {
      const merged = new Map<number, WordMark>(byIndex);
      let frontier = cursor;

      for (const word of provisional) {
        frontier = previewStep(pageWords, frontier, word);
      }

      /* Overlay the provisional preview, but never on top of committed marks:
         committed beats tentative. */
      let probe = cursor;

      for (const word of provisional) {
        if (probe >= pageWords.length) break;
        const before = probe;
        probe = previewStep(pageWords, probe, word);

        for (let i = before; i < probe && i < pageWords.length; i++) {
          if (!merged.has(i)) {
            const kind: MarkKind =
              wordsClose(pageWords[i], word) ? "correct" : "substituted";
            merged.set(i, { index: i, expected: pageWords[i], spoken: word, kind });
          }
        }
      }

      return { byIndex: merged, insertions, reached: frontier };
    },

    transcript(): string {
      return spoken.join(" ");
    },
  };
}

/** Create a fresh preview (non-committing) alignment state for tests/tools. */
export function previewMarks(
  pageWords: string[],
  words: string[],
): { byIndex: Map<number, WordMark>; reached: number } {
  const byIndex = new Map<number, WordMark>();
  let cursor = 0;

  for (const word of words) {
    const result = step(pageWords, cursor, 0, word);
    cursor = result.cursor;
    for (const mark of result.produced) {
      if (mark.index >= 0) byIndex.set(mark.index, mark);
    }
  }

  return { byIndex, reached: cursor };
}