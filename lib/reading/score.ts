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

/** Align a transcript against page text and score it in one step. */
export function scoreReading(
  pageText: string,
  transcript: string,
  durationSec: number,
  passThreshold: number = DEFAULT_PASS_THRESHOLD,
): { marks: WordMark[]; score: PageScore; complete: boolean } {
  const marks = alignWords(tokenize(pageText), tokenize(transcript));
  const score = scoreMarks(marks, durationSec);

  return { marks, score, complete: score.accuracy >= passThreshold };
}

/**
 * The words a teacher should look at: every word that was not read correctly,
 * in page order, deduplicated by page position.
 */
export function miscuedWords(marks: WordMark[]): WordMark[] {
  return marks.filter((m) => m.kind !== "correct");
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
