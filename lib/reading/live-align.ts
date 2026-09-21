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

/**
 * Longest repeated run a segment boundary may re-emit.
 *
 * Bounded so a genuine repetition — a page that really does say "very, very
 * slowly" — cannot be swallowed whole as overlap.
 */
const LIVE_MAX_OVERLAP = 4;

/**
 * How many of a final's leading words merely repeat what is already committed.
 *
 * The recogniser draws segment boundaries wherever it likes, and re-emits the
 * words either side of the cut: "...getting up" then "up and picking". Feeding
 * that "up" through the walker again makes it an unmatched word, and after
 * LIVE_FORCE_ADVANCE of those the cursor stalls — every later word on the page
 * then goes unmarked, however well it was read.
 *
 * Compares with wordsMatch rather than equality: a final re-cases and
 * re-punctuates its overlap ("up" -> "Up,"), which a raw === misses entirely.
 */
function overlapWith(committed: string[], words: string[]): number {
  const most = Math.min(LIVE_MAX_OVERLAP, committed.length, words.length);

  /* Longest first: a two-word overlap also matches at length one, and taking
     the short answer would leave the second duplicate to stall the cursor. */
  for (let n = most; n >= 1; n--) {
    let same = true;

    for (let i = 0; i < n; i++) {
      if (!wordsMatch(committed[committed.length - n + i], words[i])) {
        same = false;
        break;
      }
    }

    if (same) return n;
  }

  return 0;
}

/**
 * Longest run of consecutive omissions that may still be recovered.
 *
 * A handful of dropped function words is the recogniser faltering; a dozen in
 * a row is a line the child skipped, and must stay omitted however many
 * interims happen to mention those words elsewhere on the page.
 */
const LIVE_MAX_RECOVERABLE_RUN = 4;

/**
 * Was the run of omissions containing `index` read on both sides?
 *
 * Walks out to the ends of the run and checks that a word was actually read
 * either side of it. A run that reaches the start or the end of the page is
 * bracketed by that edge: a page opening with a word the recogniser missed has
 * nothing before it to have been read.
 */
function runIsBracketed(
  byIndex: ReadonlyMap<number, WordMark>,
  index: number,
): boolean {
  const omitted = (i: number): boolean => byIndex.get(i)?.kind === "omitted";

  let first = index;
  while (omitted(first - 1)) first--;

  let last = index;
  while (omitted(last + 1)) last++;

  if (last - first + 1 > LIVE_MAX_RECOVERABLE_RUN) return false;

  /* A mark that is absent is past the reading frontier — not yet read rather
     than read, so it cannot vouch for the run. The page edges are the
     exception: nothing precedes the first word, so nothing needs to. */
  const before = byIndex.get(first - 1);
  const after = byIndex.get(last + 1);

  const readBefore =
    first === 0 || (before !== undefined && before.kind !== "omitted");
  const readAfter = after !== undefined && after.kind !== "omitted";

  return readBefore && readAfter;
}

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
function previewStep(
  pageWords: string[],
  cursor: number,
  spokenWord: string,
): number {
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
  /**
   * Discard a run of omissions trailing the last word actually read.
   *
   * Call once at the end of a page, after recoverFromInterims(). A stray final
   * fragment that matches further down the page makes the aligner backfill the
   * gap as omissions; once the audio has stopped, that jump is known to be an
   * artifact. Returns how many words were returned to unread.
   */
  dropTrailingOmissions(): number;
};

export function createIncrementalAligner(
  pageWords: string[],
): IncrementalAligner {
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

      const fresh = words.slice(overlapWith(spoken, words));
      spoken = spoken.concat(fresh);

      for (let w = 0; w < fresh.length; w++) {
        const written = fresh[w];

        /* A child sounding a word out says it twice — "get... getting" — and
           the recogniser faithfully reports both. The page word behind the
           cursor is already marked, so the echo can only be an unmatched word
           that pushes the cursor toward stalling. Drop it, but only while the
           page itself does not repeat the word there: "very very" must still
           consume two page words. */
        const echoesLast =
          w > 0 &&
          wordsMatch(fresh[w - 1], written) &&
          !(
            cursor < pageWords.length && wordsMatch(pageWords[cursor], written)
          );

        if (echoesLast) continue;

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

      /* Rescue anything this segment just wrote off. Recovery used to run once
         at the end of the page, which repaired the score but left the child
         looking at a red word for the rest of their reading — the one place
         the feedback actually matters. It only ever rewrites omissions, so
         running it per segment costs nothing and converges to the same marks. */
      recover();
    },

    preview(text: string): void {
      provisional = tokenize(text);

      /* Retain the hypothesis before it is trimmed below: recovery wants what
         the recogniser actually heard, overlap included. */
      if (provisional.length > 0) {
        heard.push(provisional.slice());
        if (heard.length > INTERIM_MEMORY) heard.shift();
      }

      if (
        provisional.length > 0 &&
        provisional[0] === spoken[spoken.length - 1]
      ) {
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
          if (merged.has(i)) continue;

          /* Grade the preview exactly as step() will grade the commit: an
             exact hit is correct, a near miss is a substitution. Marking a
             near miss "correct" here made every fuzzy match flash green and
             then turn yellow the moment its final landed — a guaranteed
             flicker, not a race.

             Words the cursor merely crossed are not this spoken word at all;
             they are pending, so they stay unpainted rather than borrow it. */
          let kind: MarkKind;

          if (wordsMatch(pageWords[i], word)) kind = "correct";
          else if (wordsClose(pageWords[i], word)) kind = "substituted";
          else continue;

          merged.set(i, {
            index: i,
            expected: pageWords[i],
            spoken: word,
            kind,
          });
        }
      }

      return { byIndex: merged, insertions, reached: frontier };
    },

    transcript(): string {
      return spoken.join(" ");
    },

    recoverFromInterims: recover,

    dropTrailingOmissions: dropTrailing,
  };

  /**
   * Undo a forward jump that only a stray final fragment justified.
   *
   * The aligner cannot tell "jumped ahead" from "stopped reading" while audio
   * is still arriving, so a last fragment — a trailing word, a noise burst, a
   * hallucinated tail — that happens to match a word further down the page
   * reads as a skip, and every word in between is backfilled as omitted. The
   * child stops after a line and watches the rest of the page turn red.
   *
   * What separates the two, once the audio has stopped, is what follows the
   * jump. A child who really skipped a line goes on reading, so the landing
   * word is followed by a run of more read words. An artifact is one word
   * stranded at the end with nothing after it. So: find the final run of
   * omissions, and if everything after it amounts to less than a real
   * resumption, drop that run and the stranded word with it.
   */
  function dropTrailing(): number {
    /* The last word with any mark at all; the tail to judge starts after the
       omissions that precede it. */
    let highest = -1;

    for (const index of byIndex.keys()) {
      if (index > highest) highest = index;
    }

    if (highest < 0) return 0;

    /* Walk back over the read words at the end to find where the final run of
       omissions stops. */
    let tail = highest;

    while (tail >= 0 && byIndex.get(tail)?.kind !== "omitted") tail--;

    /* No omissions at all, or nothing read after them: nothing to undo. */
    if (tail < 0 || tail === highest) return 0;

    /* Words read after the final omission run. A genuine resync is confirmed
       by sustained reading; a stray fragment leaves one or two stranded. */
    const after = highest - tail;

    if (after >= LIVE_RESYNC_CONFIRM) return 0;

    /* The last word genuinely read, before the doubtful jump. */
    let last = tail;

    while (last >= 0 && byIndex.get(last)?.kind === "omitted") last--;

    /* Nothing was read before it either: leave the marks alone rather than
       blanking the page, which would hide a genuine all-omitted result. */
    if (last < 0) return 0;

    let dropped = 0;

    for (const index of [...byIndex.keys()]) {
      if (index > last) {
        byIndex.delete(index);
        dropped++;
      }
    }

    /* The frontier is what the page paints as "attempted"; leaving it past the
       last word read would keep the tail looking visited. */
    if (dropped > 0) cursor = last + 1;

    return dropped;
  }

  /**
   * Re-check omissions against the retained interim hypotheses.
   *
   * Runs after every committed segment and again when the page ends; it only
   * ever rewrites omissions, so the repeated passes converge rather than
   * compound.
   */
  function recover(): number {
    if (heard.length === 0) return 0;

    let recovered = 0;

    for (const [index, mark] of byIndex) {
      if (mark.kind !== "omitted") continue;

      /* Only rescue a word the child demonstrably read *around*: a stretch
           read on neither side is a line the child jumped, and no stray interim
           may resurrect it.

           Bracket the whole run of omissions, not just this word. The
           recogniser drops short function words in clusters — "of", "up" and
           "and" go together — and testing immediate neighbours meant every
           word in such a run had an omitted neighbour, so the commonest
           droppage was the one case that could never be recovered. */
      if (!runIsBracketed(byIndex, index)) continue;

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
  }
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
