/**
 * Storage for the reading assessment platform.
 *
 * Each entity gets its own collection so records can be queried and written
 * independently — editing one page must not rewrite its whole book, and an
 * attempt must be readable without loading the assessment around it.
 */

import { randomUUID } from "node:crypto";
import { Collection } from "./collection";
import { hashPassword } from "../auth/password";
import type {
  Assessment,
  Assignment,
  Attempt,
  Book,
  Page,
  SafeUser,
  User,
} from "../reading/types";

export const users = new Collection<User>("users");
export const books = new Collection<Book>("books");
export const pages = new Collection<Page>("pages");
export const assessments = new Collection<Assessment>("assessments");
export const assignments = new Collection<Assignment>("assignments");
export const attempts = new Collection<Attempt>("attempts");

export function newId(): string {
  return randomUUID();
}

/** Strip the password hash. Anything sent to a client goes through this. */
export function toSafeUser(user: User): SafeUser {
  const { passwordHash, ...safe } = user;
  void passwordHash;
  return safe;
}

/** Emails are the login key, so they are matched case-insensitively. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(email: string): Promise<User | null> {
  return users.find({ email: normalizeEmail(email) });
}

export const SEED_ADMIN_EMAIL = "admin@example.com";
const SEED_ADMIN_PASSWORD = "password";

/**
 * Create the default admin if no admin exists.
 *
 * Runs on demand from the login route rather than at import time: module
 * side effects run during `next build` too, where the database may be
 * unreachable and a failed seed would break the build.
 *
 * Only seeds when there is no admin at all, so changing the seeded password
 * is not undone on the next start.
 */
export async function seedAdmin(): Promise<void> {
  const existing = await users.find({ role: "admin" });

  if (existing) return;

  await users.put({
    id: newId(),
    role: "admin",
    name: "Administrator",
    email: SEED_ADMIN_EMAIL,
    passwordHash: await hashPassword(SEED_ADMIN_PASSWORD),
    createdAt: Date.now(),
  });

  console.log(`[reading] seeded admin ${SEED_ADMIN_EMAIL}`);
}

/** Pages of a book in reading order. */
export async function pagesOfBook(bookId: string): Promise<Page[]> {
  const list = await pages.list({ bookId });
  return list.sort((a, b) => a.index - b.index);
}

/**
 * The pages an assessment covers, in order.
 *
 * An empty `pageIds` means the whole book, which keeps "assess this book" from
 * needing every page id enumerated at creation time and staying correct when
 * pages are added later.
 */
export async function pagesOfAssessment(assessment: Assessment): Promise<Page[]> {
  const all = await pagesOfBook(assessment.bookId);

  if (assessment.pageIds.length === 0) return all;

  const wanted = new Set(assessment.pageIds);
  return all.filter((page) => wanted.has(page.id));
}

/**
 * The best attempt per page for one student on one assessment.
 *
 * A child may read a page several times; the report card should reflect their
 * best performance, which is also what decides completion.
 */
export async function bestAttempts(
  assessmentId: string,
  studentId: string,
): Promise<Map<string, Attempt>> {
  const all = await attempts.list({ assessmentId, studentId });
  const best = new Map<string, Attempt>();

  for (const attempt of all) {
    const current = best.get(attempt.pageId);

    if (!current || attempt.score.accuracy > current.score.accuracy) {
      best.set(attempt.pageId, attempt);
    }
  }

  return best;
}

export type AssessmentProgress = {
  totalPages: number;
  completedPages: number;
  /** Mean accuracy across pages actually attempted; 0 if none. */
  averageAccuracy: number;
  /** Every page of the assessment passed. */
  complete: boolean;
};

/** Roll a student's attempts up into assessment-level progress. */
export async function progressFor(
  assessment: Assessment,
  studentId: string,
): Promise<AssessmentProgress> {
  const pageList = await pagesOfAssessment(assessment);
  const best = await bestAttempts(assessment.id, studentId);

  let completedPages = 0;
  let accuracySum = 0;
  let attempted = 0;

  for (const page of pageList) {
    const attempt = best.get(page.id);

    if (!attempt) continue;

    attempted++;
    accuracySum += attempt.score.accuracy;
    if (attempt.complete) completedPages++;
  }

  return {
    totalPages: pageList.length,
    completedPages,
    averageAccuracy:
      attempted === 0 ? 0 : Math.round((accuracySum / attempted) * 10) / 10,
    complete: pageList.length > 0 && completedPages === pageList.length,
  };
}

/**
 * Remove a book and everything hanging off it.
 *
 * Without this a deleted book leaves pages, assessments and assignments
 * pointing at nothing, and the student page would render blank rows.
 */
export async function deleteBookCascade(bookId: string): Promise<void> {
  const related = await assessments.list({ bookId });

  for (const assessment of related) {
    await assignments.removeWhere({ assessmentId: assessment.id });
    await attempts.removeWhere({ assessmentId: assessment.id });
    await assessments.remove(assessment.id);
  }

  await pages.removeWhere({ bookId });
  await books.remove(bookId);
}

/** Remove a user and the records that only make sense with them. */
export async function deleteUserCascade(userId: string): Promise<void> {
  await assignments.removeWhere({ studentId: userId });
  await attempts.removeWhere({ studentId: userId });

  // A deleted teacher's students stay, unlinked, rather than being deleted
  // along with them — losing a class because one teacher left would be an
  // unpleasant surprise.
  const students = await users.list({ teacherId: userId });

  for (const student of students) {
    await users.patch(student.id, { teacherId: undefined });
  }

  await users.remove(userId);
}
