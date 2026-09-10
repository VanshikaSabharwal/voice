/**
 * Word Error Rate — how far a transcript is from what was actually said.
 *
 * WER is the standard way to score a recogniser: the number of edits needed to
 * turn the hypothesis back into the reference, over the length of the
 * reference. Getting the edit count right needs global alignment rather than a
 * positional comparison, because dropping one word shifts every later word by
 * one; a positional diff would count that single omission as an error on the
 * whole remainder of the sentence.
 *
 *     WER = (substitutions + deletions + insertions) / reference words
 *
 * 0 is perfect. Values above 1 are possible when a recogniser hallucinates
 * more words than were spoken, which is exactly the failure worth seeing.
 *
 * The alignment here is Needleman-Wunsch over words. It is the same algorithm
 * used for reading assessment on the voice-evaluation branch, where it is
 * covered by a test suite; the scoring wrapper differs but the core is proven.
 */

export type EditKind = "correct" | "substitution" | "deletion" | "insertion";

export type WordEdit = {
  /** Index into the reference. -1 for insertions, which occupy no slot. */
  index: number;
  /** The word that was expected. Empty for insertions. */
  reference: string;
  /** The word the recogniser produced. Empty for deletions. */
  hypothesis: string;
  kind: EditKind;
};

export type WerResult = {
  /** substitutions + deletions + insertions, over reference length. */
  wer: number;
  /** 1 - wer, floored at 0, as a percentage. The friendlier direction. */
  accuracy: number;
  referenceWords: number;
  correct: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  edits: WordEdit[];
};

/* Scores chosen so one misrecognised word costs a single substitution rather
   than a deletion plus an insertion — otherwise every swapped word would be
   counted twice and WER would roughly double. */
const MATCH = 2;
const MISMATCH = -1;
const GAP = -2;

/**
 * Reduce a word to what should be compared.
 *
 * Case and punctuation are the transcriber's formatting choices, not
 * recognition errors: a model that returns "Hello," where the reference says
 * "hello" heard it correctly.
 *
 * Apostrophes are stripped entirely, so "it's" and "its" compare equal. This
 * is the one place this differs from the otherwise identical aligner used for
 * reading assessment, and deliberately so: a child who reads "its" for "it's"
 * has made a real mistake, but a recogniser that writes one for the other
 * heard the same sound and is only punctuating. Keeping them distinct would
 * charge providers for a difference no listener can hear, and providers
 * disagree about apostrophes constantly.
 */
export function normalize(word: string): string {
  return word
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, "")
    .replace(/'/g, "");
}

export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/**
 * Numbers are spoken as words but often written as digits, and every provider
 * picks a different side. Without this, a transcript that is perfectly correct
 * to the ear scores as an error on each number.
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

export function wordsMatch(reference: string, hypothesis: string): boolean {
  const a = normalize(reference);
  const b = normalize(hypothesis);

  if (!a || !b) return false;
  if (a === b) return true;

  return numberFormsMatch(a, b);
}

type Move = "diag" | "up" | "left";

/** Align a hypothesis against a reference, returning one edit per position. */
export function alignWords(
  referenceWords: string[],
  hypothesisWords: string[],
): WordEdit[] {
  const n = referenceWords.length;
  const m = hypothesisWords.length;

  if (n === 0) {
    return hypothesisWords.map((hypothesis) => ({
      index: -1,
      reference: "",
      hypothesis,
      kind: "insertion" as EditKind,
    }));
  }

  if (m === 0) {
    return referenceWords.map((reference, index) => ({
      index,
      reference,
      hypothesis: "",
      kind: "deletion" as EditKind,
    }));
  }

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
        (wordsMatch(referenceWords[i - 1], hypothesisWords[j - 1])
          ? MATCH
          : MISMATCH);
      const up = score[i - 1][j] + GAP; // reference word never produced
      const left = score[i][j - 1] + GAP; // produced word not in reference

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

  const edits: WordEdit[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    const move: Move = i === 0 ? "left" : j === 0 ? "up" : back[i][j];

    if (move === "diag") {
      const reference = referenceWords[i - 1];
      const hypothesis = hypothesisWords[j - 1];
      edits.push({
        index: i - 1,
        reference,
        hypothesis,
        kind: wordsMatch(reference, hypothesis) ? "correct" : "substitution",
      });
      i--;
      j--;
    } else if (move === "up") {
      edits.push({
        index: i - 1,
        reference: referenceWords[i - 1],
        hypothesis: "",
        kind: "deletion",
      });
      i--;
    } else {
      edits.push({
        index: -1,
        reference: "",
        hypothesis: hypothesisWords[j - 1],
        kind: "insertion",
      });
      j--;
    }
  }

  // Traceback walks backwards from the end of both sequences.
  return edits.reverse();
}

/** Score a transcript against what was actually said. */
export function computeWer(reference: string, hypothesis: string): WerResult {
  const referenceTokens = tokenize(reference);
  const edits = alignWords(referenceTokens, tokenize(hypothesis));

  let correct = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;

  for (const edit of edits) {
    if (edit.kind === "correct") correct++;
    else if (edit.kind === "substitution") substitutions++;
    else if (edit.kind === "deletion") deletions++;
    else insertions++;
  }

  const referenceWords = referenceTokens.length;

  /* An empty reference cannot yield a rate — dividing by zero would report
     Infinity for a test whose fixture is simply missing. Anything the
     recogniser produced against it is still counted as insertions. */
  const wer =
    referenceWords === 0
      ? insertions > 0
        ? 1
        : 0
      : (substitutions + deletions + insertions) / referenceWords;

  return {
    wer: Math.round(wer * 1000) / 1000,
    // Floored: a hallucinating model can exceed 100% error, and "-40%
    // accurate" reads as a bug rather than as very bad output.
    accuracy: Math.round(Math.max(0, 1 - wer) * 1000) / 10,
    referenceWords,
    correct,
    substitutions,
    deletions,
    insertions,
    edits,
  };
}
