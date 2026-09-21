/**
 * Turning alignment marks into a report card.
 *
 * Kept separate from align.ts so the scoring rules — what counts as accuracy,
 * what fluency means, where the pass line sits — can be read and changed in
 * one place without touching the alignment algorithm.
 */

import { alignWords, tokenize } from "./align";
import type { PageScore, WordMark } from "./types";

/** Default pass line; assessments may override it per-assessment. */
export const DEFAULT_PASS_THRESHOLD = 90;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Score a set of marks.
 *
 * Accuracy is correct words over words *on the page*, so skipping words hurts
 * exactly as much as misreading them — a child who reads three words of a
 * thirty-word page cannot score 100%. Insertions are counted and reported but
 * deliberately kept out of the denominator: they are a fluency signal
 * (repeating, self-correcting), not a failure to read what was written.
 */
export function scoreMarks(marks: WordMark[], durationSec: number): PageScore {
  let correct = 0;
  let substituted = 0;
  let omitted = 0;
  let inserted = 0;

  for (const mark of marks) {
    if (mark.kind === "correct") correct++;
    else if (mark.kind === "substituted") substituted++;
    else if (mark.kind === "omitted") omitted++;
    else inserted++;
  }

  const totalWords = correct + substituted + omitted;
  const accuracy = totalWords === 0 ? 0 : round1((correct / totalWords) * 100);

  /* Correct words per minute, the standard fluency measure. Guarded against a
     near-zero duration, which would otherwise report a wild number for a
     recording that barely started. */
  const wpm = durationSec < 1 ? 0 : Math.round((correct / durationSec) * 60);

  return { totalWords, correct, substituted, omitted, inserted, accuracy, wpm };
}

/**
 * How many read words after a run of omissions count as genuinely resuming.
 *
 * Mirrors LIVE_RESYNC_CONFIRM in live-align: the aligner needs two confirming
 * words to trust a forward jump, so undoing one takes the same evidence.
 */
const TRAILING_RESUME_WORDS = 2;

/**
 * Drop omissions trailing the last word the child actually read.
 *
 * A stray fragment at the end of a recording — a trailing word, noise, a
 * hallucinated tail — that matches a word further down the page makes the
 * aligner read a forward jump and backfill the gap as omissions. Nothing was
 * skipped; the child simply stopped.
 *
 * Deliberately NOT applied to scoring: accuracy is correct-over-page-words, so
 * an unfinished page must still score low. This only affects which words are
 * reported as miscues, so the teacher sees the words the child got wrong
 * rather than the ones they never reached.
 */
function dropTrailingOmissions(marks: WordMark[]): WordMark[] {
  const byIndex = new Map<number, WordMark>();

  for (const mark of marks) {
    if (mark.index >= 0) byIndex.set(mark.index, mark);
  }

  let highest = -1;

  for (const index of byIndex.keys()) {
    if (index > highest) highest = index;
  }

  if (highest < 0) return marks;

  let tail = highest;

  while (tail >= 0 && byIndex.get(tail)?.kind !== "omitted") tail--;

  if (tail < 0 || tail === highest) return marks;

  /* A genuine mid-page skip is followed by sustained reading; a stray final
     fragment strands one or two words at the end. */
  if (highest - tail >= TRAILING_RESUME_WORDS) return marks;

  let last = tail;

  while (last >= 0 && byIndex.get(last)?.kind === "omitted") last--;

  if (last < 0) return marks;

  return marks.filter((mark) => mark.index < 0 || mark.index <= last);
}

/** Align a transcript against page text and score it in one step. */
export function scoreReading(
  pageText: string,
  transcript: string,
  durationSec: number,
  passThreshold: number = DEFAULT_PASS_THRESHOLD,
): { marks: WordMark[]; score: PageScore; complete: boolean } {
  /* Scored from the unfiltered marks: an unread tail is still unread, and
     accuracy is correct-over-page-words by design. The filtering below only
     changes how those words are labelled, never how many there are. */
  const marks = alignWords(tokenize(pageText), tokenize(transcript));
  const score = scoreMarks(marks, durationSec);

  return { marks, score, complete: score.accuracy >= passThreshold };
}

/**
 * The words a teacher should look at: every word that was not read correctly,
 * in page order, deduplicated by page position.
 */
export function miscuedWords(marks: WordMark[]): WordMark[] {
  return dropTrailingOmissions(marks).filter((m) => m.kind !== "correct");
}

/** A coarse band for the report card, so a number gets a plain-language label. */
export function grade(accuracy: number): {
  label: string;
  tone: "success" | "warning" | "danger";
} {
  if (accuracy >= 95) return { label: "Independent", tone: "success" };
  if (accuracy >= 90) return { label: "Proficient", tone: "success" };
  if (accuracy >= 75) return { label: "Instructional", tone: "warning" };
  return { label: "Needs support", tone: "danger" };
}
