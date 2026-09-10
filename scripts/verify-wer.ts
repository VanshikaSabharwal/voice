/**
 * Word Error Rate checks. Pure computation — no provider calls, no API keys,
 * no cost. Run: npm run verify:wer
 */

import { computeWer } from "../lib/eval/wer";

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;

  if (!ok) failures++;

  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${g}\n        want ${w}`}`,
  );
}

const REF = "the quick brown fox jumps over the lazy dog";

console.log("Word Error Rate\n");

// Perfect transcription.
let r = computeWer(REF, REF);
check("perfect: wer", r.wer, 0);
check("perfect: accuracy", r.accuracy, 100);

// One substitution out of nine words.
r = computeWer(REF, "the quick brown cat jumps over the lazy dog");
check("1 substitution: wer", r.wer, 0.111);
check("1 substitution: count", r.substitutions, 1);

/* The case that justifies global alignment: one dropped word must cost one
   deletion, not an error on every word after it. */
r = computeWer(REF, "the quick fox jumps over the lazy dog");
check("1 deletion: deletions", r.deletions, 1);
check("1 deletion: substitutions stay 0", r.substitutions, 0);
check("1 deletion: correct", r.correct, 8);
check("1 deletion: which word", r.edits.find((e) => e.kind === "deletion")?.reference, "brown");

// An extra word the speaker never said.
r = computeWer(REF, "the quick brown fox quickly jumps over the lazy dog");
check("1 insertion: insertions", r.insertions, 1);
check("1 insertion: correct", r.correct, 9);

// Formatting is not a recognition error.
r = computeWer("Hello, world! It's fine.", "hello world its fine");
check("punctuation and case ignored", r.wer, 0);

/* Contractions: a recogniser writing "its" for "it's" heard the same sound.
   This is where WER deliberately diverges from reading assessment, where the
   same swap is a genuine error by the reader. */
r = computeWer("it's fine and they're here", "its fine and theyre here");
check("contractions ignored", r.wer, 0);

// Digits versus spoken numbers.
r = computeWer("call me at 7 today", "call me at seven today");
check("number forms match", r.wer, 0);

// Nothing recognised at all: every reference word is a deletion.
r = computeWer(REF, "");
check("silence: wer", r.wer, 1);
check("silence: accuracy floored at 0", r.accuracy, 0);
check("silence: deletions", r.deletions, 9);

/* A hallucinating recogniser can exceed 100% error. The rate must show that
   rather than being clamped, while accuracy stays readable at 0. */
r = computeWer("yes", "yes and then he went to the store and bought milk");
check("hallucination: wer above 1", r.wer > 1, true);
check("hallucination: accuracy floored", r.accuracy, 0);

// A missing fixture must not produce Infinity.
r = computeWer("", "some output");
check("empty reference: finite", Number.isFinite(r.wer), true);
check("empty reference: wer", r.wer, 1);
check("empty reference and empty hypothesis", computeWer("", "").wer, 0);

// Every reference position accounted for exactly once.
r = computeWer(REF, "a quick brown dog leapt over the lazy dog today");
const covered = r.edits.filter((e) => e.kind !== "insertion").map((e) => e.index);
check("invariant: each reference index once", covered, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
check("invariant: counts sum to reference length", r.correct + r.substitutions + r.deletions, r.referenceWords);

console.log(
  failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED`,
);

process.exit(failures === 0 ? 0 : 1);
