/**
 * Domain types for the reading assessment platform.
 *
 * The shape here is deliberately flat and id-referenced rather than nested:
 * every entity is stored as its own document/array so a page edit does not
 * rewrite a whole book, and an attempt can be read without loading the
 * assessment it belongs to.
 */

export type Role = "admin" | "teacher" | "student";

export type User = {
  id: string;
  role: Role;
  name: string;
  email: string;
  /** scrypt hash as `salt:derivedKey`, both hex. Never sent to a client. */
  passwordHash: string;
  /** For students: the teacher they belong to. Unset for admins. */
  teacherId?: string;
  createdAt: number;
};

/** A user with the hash stripped — the only shape that may leave the server. */
export type SafeUser = Omit<User, "passwordHash">;

export type Book = {
  id: string;
  title: string;
  author?: string;
  /** Cover image path under /uploads, if one was uploaded. */
  coverUrl?: string;
  createdAt: number;
};

export type Page = {
  id: string;
  bookId: string;
  /** 0-based position within the book; determines reading order. */
  index: number;
  /** Ground truth the child's speech is scored against. */
  text: string;
  /** Scanned/illustrated page image under /uploads, if uploaded. */
  imageUrl?: string;
};

export type Assessment = {
  id: string;
  title: string;
  bookId: string;
  /** Page ids included, in reading order. Empty means the whole book. */
  pageIds: string[];
  /** Percent of words that must be read correctly to pass a page. */
  passThreshold: number;
  createdAt: number;
  createdBy: string;
};

export type Assignment = {
  id: string;
  assessmentId: string;
  studentId: string;
  assignedBy: string;
  assignedAt: number;
};

/** How one spoken word compared to the page. */
export type MarkKind = "correct" | "substituted" | "omitted" | "inserted";

export type WordMark = {
  /** Index into the page's word list. -1 for insertions, which have no slot. */
  index: number;
  /** The word as written on the page. Empty for insertions. */
  expected: string;
  /** What the child actually said. Empty for omissions. */
  spoken: string;
  kind: MarkKind;
};

export type PageScore = {
  totalWords: number;
  correct: number;
  substituted: number;
  omitted: number;
  inserted: number;
  /** correct / totalWords, as a percentage rounded to one decimal. */
  accuracy: number;
  /** Correct words per minute, the standard fluency measure. */
  wpm: number;
};

export type Attempt = {
  id: string;
  assessmentId: string;
  studentId: string;
  pageId: string;
  startedAt: number;
  completedAt?: number;
  /** Seconds of actual reading, used for words-per-minute. */
  durationSec: number;
  /** Everything the ASR returned, joined across chunks. */
  transcript: string;
  marks: WordMark[];
  score: PageScore;
  /** accuracy >= the assessment's passThreshold. */
  complete: boolean;
};
