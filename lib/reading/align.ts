/**
 * Word alignment: what the page says vs. what the child actually read.
 *
 * The ASR gives us a plain transcript with no word timings (see
 * lib/agent/stt.ts), so per-word marking cannot come from the recogniser. It
 * does not have to: the page text is known ground truth, so aligning the
 * transcript against it recovers exactly which words were substituted,
 * skipped, or added.
 *
 * This is Needleman-Wunsch global alignment over words rather than characters.
 * A greedy or positional comparison breaks on the most common child reading
 * behaviour — skipping one word shifts every later word by one and would mark
 * the whole rest of the page wrong. Global alignment absorbs the shift and
 * reports a single omission, which is what a teacher would mark.
 */

import type { MarkKind, WordMark } from "./types";

/* Scores chosen so a substitution is preferred over an omission+insertion
   pair: mis-reading one word should read as one error, not two. */
const MATCH = 2;
const MISMATCH = -1;
const GAP = -2;

/**
 * Reduce a word to what should be compared.
 *
 * Punctuation and case are the page's business, not the reader's — a child who
 * says "cat" for "Cat," has read it correctly. Curly quotes are folded because
 * typed page text and ASR output disagree about them constantly.
 */
export function normalize(word: string): string {
  return word
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, "")
    .replace(/^'+|'+$/g, "");
}

/** Split text into comparable words, dropping anything that normalises away. */
export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/**
 * Numbers are read aloud as words ("7" -> "seven") but written as digits, and
 * the ASR returns whichever form it prefers. Without this a page of numbers
 * scores near zero regardless of how well it was read.
 */
const SMALL_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

function numberFormsMatch(a: string, b: string): boolean {
  const asWord = (t: string) => {
    const n = Number(t);
    return Number.isInteger(n) && n >= 0 && n <= 20 ? SMALL_NUMBERS[n] : t;
  };
  return asWord(a) === asWord(b);
}

/** Do these two words count as the same spoken word? */
export function wordsMatch(expected: string, spoken: string): boolean {
  const a = normalize(expected);
  const b = normalize(spoken);

  if (!a || !b) return false;
  if (a === b) return true;

  return numberFormsMatch(a, b);
}

/** Levenshtein distance — small words, so quadratic is fine. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = new Array(cols);

  for (let j = 0; j < cols; j++) dist[j] = j;

  for (let i = 1; i < rows; i++) {
    let prev = dist[0];
    dist[0] = i;

    for (let j = 1; j < cols; j++) {
      const tmp = dist[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[j] = Math.min(dist[j] + 1, dist[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }

  return dist[b.length];
}

/**
 * Looser match for live feedback. ASR often truncates ("runnin"), drops a
 * letter, or returns a close cousin — exact equality would leave a correctly
 * read word unmarked until the final score.
 */
export function wordsClose(expected: string, spoken: string): boolean {
  if (wordsMatch(expected, spoken)) return true;

  const a = normalize(expected);
  const b = normalize(spoken);

  if (!a || !b) return false;

  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);

  // Prefix / stem: "running" vs "runnin", "elephant" vs "elephan".
  if (shorter >= 3 && longer <= shorter + 2 && (a.startsWith(b) || b.startsWith(a))) {
    return true;
  }

  if (longer < 4) return false;

  const allowed = longer <= 5 ? 1 : 2;
  return editDistance(a, b) <= allowed;
}

type Move = "diag" | "up" | "left";

/**
 * Align spoken words against page words.
 *
 * Returns one mark per page word (correct / substituted / omitted) plus a mark
 * for every extra word the child inserted. Marks come back in page order, with
 * insertions sitting at the position they were spoken.
 */
export function alignWords(pageWords: string[], spokenWords: string[]): WordMark[] {
  const n = pageWords.length;
  const m = spokenWords.length;

  if (n === 0) {
    return spokenWords.map((spoken) => ({
      index: -1,
      expected: "",
      spoken,
      kind: "inserted" as MarkKind,
    }));
  }

  if (m === 0) {
    return pageWords.map((expected, index) => ({
      index,
      expected,
      spoken: "",
      kind: "omitted" as MarkKind,
    }));
  }

  /* (n+1) x (m+1) score matrix with a parallel traceback matrix. Page lengths
     are a few hundred words at most, so the quadratic cost is trivial. */
  const score: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  const back: Move[][] = Array.from({ length: n + 1 }, () =>
    new Array<Move>(m + 1).fill("diag"),
  );

  for (let i = 1; i <= n; i++) {
    score[i][0] = i * GAP;
    back[i][0] = "up";
  }
  for (let j = 1; j <= m; j++) {
    score[0][j] = j * GAP;
    back[0][j] = "left";
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag =
        score[i - 1][j - 1] +
        (wordsMatch(pageWords[i - 1], spokenWords[j - 1]) ? MATCH : MISMATCH);
      const up = score[i - 1][j] + GAP; // page word with nothing spoken
      const left = score[i][j - 1] + GAP; // spoken word not on the page

      if (diag >= up && diag >= left) {
        score[i][j] = diag;
        back[i][j] = "diag";
      } else if (up >= left) {
        score[i][j] = up;
        back[i][j] = "up";
      } else {
        score[i][j] = left;
        back[i][j] = "left";
      }
    }
  }

  const marks: WordMark[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    const move: Move = i === 0 ? "left" : j === 0 ? "up" : back[i][j];

    if (move === "diag") {
      const expected = pageWords[i - 1];
      const spoken = spokenWords[j - 1];
      marks.push({
        index: i - 1,
        expected,
        spoken,
        kind: wordsMatch(expected, spoken) ? "correct" : "substituted",
      });
      i--;
      j--;
    } else if (move === "up") {
      marks.push({
        index: i - 1,
        expected: pageWords[i - 1],
        spoken: "",
        kind: "omitted",
      });
      i--;
    } else {
      marks.push({
        index: -1,
        expected: "",
        spoken: spokenWords[j - 1],
        kind: "inserted",
      });
      j--;
    }
  }

  // Traceback walks backwards from the end of both sequences.
  return marks.reverse();
}

/**
 * How far ahead of the reading cursor a spoken word may still count as a
 * skip rather than a substitution. Wide enough for a missed "the"/"a";
 * narrow enough that matches cannot jump to a later paragraph.
 */
const LIVE_LOOKAHEAD = 5;

/**
 * After this many unmatched spoken words in a row, force a substitution so a
 * run of ASR noise cannot leave the cursor stuck forever.
 */
const LIVE_FORCE_ADVANCE = 2;

/**
 * Live feedback alignment while the child is still reading.
 *
 * Full Needleman-Wunsch against the whole page is wrong mid-read: a short
 * transcript of common words ("the", "and") will latch onto a later line and
 * paint green past where the child has actually got to. This walker stays
 * pinned to a cursor that only moves forward from the start of the page.
 *
 * Unmatched spoken words are treated as insertions (noise / filler) rather
 * than burning the next page word — that was the usual way a correct reading
 * fell behind the highlight. Near-misses from ASR still count as correct via
 * wordsClose().
 *
 * Final scoring still uses alignWords() on the complete transcript — that is
 * where global alignment belongs.
 */
export function alignLive(
  pageWords: string[],
  spokenWords: string[],
): WordMark[] {
  if (spokenWords.length === 0 || pageWords.length === 0) return [];

  const marks: WordMark[] = [];
  let cursor = 0;
  let unmatchedStreak = 0;

  for (const spoken of spokenWords) {
    if (cursor >= pageWords.length) {
      marks.push({
        index: -1,
        expected: "",
        spoken,
        kind: "inserted",
      });
      continue;
    }

    let found = -1;
    let close = false;

    for (
      let ahead = 0;
      ahead <= LIVE_LOOKAHEAD && cursor + ahead < pageWords.length;
      ahead++
    ) {
      const candidate = pageWords[cursor + ahead];

      if (wordsMatch(candidate, spoken)) {
        found = cursor + ahead;
        close = false;
        break;
      }

      if (found < 0 && wordsClose(candidate, spoken)) {
        found = cursor + ahead;
        close = true;
        // Keep scanning for an exact match a little further on.
      }
    }

    if (found >= 0) {
      while (cursor < found) {
        marks.push({
          index: cursor,
          expected: pageWords[cursor],
          spoken: "",
          kind: "omitted",
        });
        cursor++;
      }

      marks.push({
        index: cursor,
        expected: pageWords[cursor],
        spoken,
        // Near-misses still light green live; the final score uses exact
        // alignWords and can still mark a true misread.
        kind: "correct",
      });
      cursor++;
      unmatchedStreak = 0;
      continue;
    }

    // No nearby page word fits. Prefer insertion (do not advance) so filler
    // and ASR glitches do not consume the next real word. After a short
    // streak, force a substitution to resync.
    if (unmatchedStreak >= LIVE_FORCE_ADVANCE) {
      marks.push({
        index: cursor,
        expected: pageWords[cursor],
        spoken,
        kind: "substituted",
      });
      cursor++;
      unmatchedStreak = 0;
    } else {
      marks.push({
        index: -1,
        expected: "",
        spoken,
        kind: "inserted",
      });
      unmatchedStreak++;
    }
  }

  return marks;
}
