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
import { normalize, tokenize, wordsClose, wordsMatch } from "./align";

/**
 * How far ahead a *fuzzy* match may pull the cursor.
 *
 * Kept short: within a few words of the frontier a near-miss is much more
 * likely to be the child's actual next word than a coincidence, so a loose
 * match is safe. Beyond this the bar rises — see LIVE_RESYNC_WINDOW.
 */
const LIVE_LOOKAHEAD = 5;

/**
 * How far ahead an *exact* match may pull the cursor, to recover from a skip.
 *
 * A child who jumps a line leaves a gap far wider than LIVE_LOOKAHEAD. With
 * only the near window the cursor could never reach the resumption point, so
 * every subsequent word missed and the page scored near zero however well the
 * rest was read. Scanning further, but demanding an exact match to jump that
 * far, lets the cursor re-find the child without inviting coincidental
 * matches on common words.
 */
const LIVE_RESYNC_WINDOW = 40;

/**
 * How many exactly-matching words in a row confirm a long jump.
 *
 * One exact hit far ahead can be coincidence — "the" occurs everywhere. Two
 * adjacent page words matching two adjacent spoken words is strong evidence
 * the child really has resumed there, and is what a line skip looks like.
 */
const LIVE_RESYNC_CONFIRM = 2;

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

/** Longest run of page words a merged token may stand for. */
const MERGE_MAX_WORDS = 3;

/**
 * How many page words a single spoken token accounts for, or 0.
 *
 * At speed the recogniser emits "wentalice" for "went Alice" — the child read
 * both words correctly, but neither matches the token on its own, so without
 * this both are scored as errors. Concatenating consecutive page words and
 * comparing against the token recovers the pair.
 *
 * Only exact concatenations count. A fuzzy compare here would let a long token
 * swallow page words the child never said, which is a far worse error than
 * missing a merge.
 */
function matchMergedPair(
  pageWords: string[],
  cursor: number,
  spokenWord: string,
): number {
  const spoken = normalize(spokenWord);

  /* One page word is the normal case, handled by the caller; a merge is two or
     more, and must be meaningfully longer than either part alone. */
  if (spoken.length < 4) return 0;

  let joined = "";

  for (let n = 0; n < MERGE_MAX_WORDS && cursor + n < pageWords.length; n++) {
    joined += normalize(pageWords[cursor + n]);

    if (n === 0) continue;
    if (joined === spoken) return n + 1;
    if (joined.length > spoken.length) break;
  }

  return 0;
}

/**
 * Find where a child has resumed after skipping ahead, or -1.
 *
 * Scans past the near lookahead for an exact match confirmed by the following
 * spoken words. Requiring the run keeps common words from dragging the cursor
 * across the page: "the" alone proves nothing, "the world she" is the child.
 *
 * Returns the page index the spoken word belongs at.
 */
function findResync(
  pageWords: string[],
  cursor: number,
  spokenWord: string,
  upcoming: string[],
): number {
  const limit = Math.min(pageWords.length, cursor + LIVE_RESYNC_WINDOW);

  /* Start beyond the near window; anything inside it was already considered
     (and rejected) by the fuzzy pass. */
  for (let i = cursor + LIVE_LOOKAHEAD + 1; i < limit; i++) {
    if (!wordsMatch(pageWords[i], spokenWord)) continue;

    /* How many of the next spoken words continue to match from here? */
    let confirmed = 1;

    for (let k = 0; k < upcoming.length && i + 1 + k < pageWords.length; k++) {
      if (!wordsMatch(pageWords[i + 1 + k], upcoming[k])) break;
      confirmed++;
      if (confirmed >= LIVE_RESYNC_CONFIRM) break;
    }

    if (confirmed >= LIVE_RESYNC_CONFIRM) return i;

    /* A lone match near the very end of the page has no room left to be
       confirmed; accept it rather than stranding the final words. */
    if (i + 1 >= pageWords.length && upcoming.length === 0) return i;
  }

  return -1;
}

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
  /** Words spoken after this one, used to confirm a long resync jump. */
  upcoming: string[] = [],
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

  /* Fast speech runs words together and the recogniser returns one token where
     the page has two ("went Alice" -> "wentalice"). Both page words were read
     correctly, so credit both rather than marking the pair omitted. Checked
     before the single-word match so the merged reading wins over a fuzzy
     single hit. */
  if (found < 0 || found > cursor) {
    const merged = matchMergedPair(pageWords, cursor, spokenWord);

    if (merged > 0) {
      for (let i = 0; i < merged; i++) {
        produced.push({
          index: cursor + i,
          expected: pageWords[cursor + i],
          spoken: spokenWord,
          kind: "correct",
        });
      }

      return { cursor: cursor + merged, unmatchedStreak: 0, produced };
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

  /* Nothing near the frontier. Before giving up and drifting, look much
     further ahead for the child having resumed after a skipped line —
     demanding an exact match, confirmed by the words that follow it, so a
     long jump needs real evidence rather than one common word landing. */
  const resync = findResync(pageWords, cursor, spokenWord, upcoming);

  if (resync >= 0) {
    while (cursor < resync) {
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
      kind: "correct",
    });

    return { cursor: cursor + 1, unmatchedStreak: 0, produced };
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

/**
 * How many distinct interim hypotheses to retain for recovery.
 *
 * Interims are the recogniser's own earlier guesses at the phrase in progress.
 * A word it heard and then dropped from the final ("tired of reading" ->
 * "get of reading") usually survives in one of them, so keeping a bounded
 * window of them lets an omission be re-checked against what was actually
 * heard — without a second, billable pass over the audio.
 *
 * Bounded because a long page produces a great many interims and only the
 * recent ones can plausibly cover the word under question.
 */
const INTERIM_MEMORY = 60;

export type IncrementalAligner = {
  /** A finalized ASR segment. Authoritative — commits its words permanently. */
  commit(text: string): void;
  /** The latest interim hypothesis. Paints an immediate, throwaway preview. */
  preview(text: string): void;
  /** Committed marks plus the provisional preview past the frontier. */
  snapshot(): LiveMarks;
  /** The committed words, joined — exactly what should be scored. */
  transcript(): string;
  /**
   * Re-check omissions against retained interim hypotheses.
   *
   * Call once at the end of a page. A page word marked omitted that appears in
   * an interim the recogniser emitted is reclassified correct: the child did
   * say it, the final just lost it. Returns how many words were recovered.
   *
   * This also rewrites the committed transcript, because the server rescores
   * from that transcript — recovering a word in the marks alone would make the
   * green words and the grade disagree.
   */
  recoverFromInterims(): number;
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

  /* Every distinct interim the recogniser offered, most recent last. Retained
     only so omissions can be re-checked against them at the end of the page;
     they never influence the committed cursor. */
  const heard: string[][] = [];

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

      for (let w = 0; w < fresh.length; w++) {
        const written = fresh[w];
        const result = step(
          pageWords,
          cursor,
          unmatchedStreak,
          written,
          fresh.slice(w + 1, w + 1 + LIVE_RESYNC_CONFIRM),
        );
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

      /* Retain the hypothesis before it is trimmed below: recovery wants what
         the recogniser actually heard, overlap included. */
      if (provisional.length > 0) {
        heard.push(provisional.slice());
        if (heard.length > INTERIM_MEMORY) heard.shift();
      }

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

    recoverFromInterims(): number {
      if (heard.length === 0) return 0;

      let recovered = 0;

      for (const [index, mark] of byIndex) {
        if (mark.kind !== "omitted") continue;

        /* Only rescue a word the child demonstrably read *around*. An omission
           with no neighbour read is a genuinely skipped stretch — a line the
           child jumped — and a stray interim must not resurrect it. */
        const before = byIndex.get(index - 1);
        const after = byIndex.get(index + 1);

        const readNeighbour =
          (before && before.kind !== "omitted") ||
          (after && after.kind !== "omitted");

        if (!readNeighbour) continue;

        const expected = pageWords[index];

        /* Did any retained hypothesis contain this word? wordsMatch rather than
           equality so the recogniser's casing and punctuation do not matter. */
        const wasHeard = heard.some((hypothesis) =>
          hypothesis.some((word) => wordsMatch(expected, word)),
        );

        if (!wasHeard) continue;

        byIndex.set(index, {
          index,
          expected,
          spoken: expected,
          kind: "correct",
        });

        recovered++;
      }

      /* The server rescores from the transcript, so a recovered word has to
         appear there too, in its page position — otherwise the marks say
         correct and the grade says omitted. Rebuilding from the marks keeps
         the two definitions of "what was read" identical. */
      if (recovered > 0) {
        const rebuilt: string[] = [];

        for (let i = 0; i < pageWords.length; i++) {
          const mark = byIndex.get(i);
          if (!mark || mark.kind === "omitted") continue;
          rebuilt.push(mark.spoken || mark.expected);
        }

        spoken = rebuilt;
      }

      return recovered;
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