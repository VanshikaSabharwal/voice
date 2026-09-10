/**
 * Recording and reading back scored attempts.
 *
 * Scoring happens HERE, from the page text and transcript, never from a score
 * the client sends. The browser aligns the same transcript for live feedback,
 * but a mark that decides whether a child passed cannot be client-controlled.
 */

import { guarded, requireRole } from "../../../../lib/auth/guard";
import { scoreReading } from "../../../../lib/reading/score";
import {
  assessments,
  assignments,
  attempts,
  bestAttempts,
  newId,
  pages,
  users,
} from "../../../../lib/store/reading";
import type { Attempt } from "../../../../lib/reading/types";

export const dynamic = "force-dynamic";

export const GET = guarded(async (request: Request) => {
  const session = await requireRole("admin", "teacher", "student");
  const params = new URL(request.url).searchParams;

  const assessmentId = params.get("assessmentId");
  const requestedStudent = params.get("studentId");

  if (!assessmentId) {
    return Response.json({ error: "assessmentId is required." }, { status: 400 });
  }

  /* A student can only read their own attempts. A teacher must own the
     student, checked against the roster rather than a client-supplied id. */
  let studentId = requestedStudent;

  if (session.role === "student") {
    studentId = session.userId;
  } else if (session.role === "teacher") {
    if (!studentId) {
      return Response.json({ error: "studentId is required." }, { status: 400 });
    }

    const student = await users.get(studentId);

    if (!student || student.teacherId !== session.userId) {
      return Response.json(
        { error: "That student is not on your roster." },
        { status: 403 },
      );
    }
  }

  if (!studentId) {
    return Response.json({ error: "studentId is required." }, { status: 400 });
  }

  const best = await bestAttempts(assessmentId, studentId);

  return Response.json({ attempts: [...best.values()] });
});

export const POST = guarded(async (request: Request) => {
  const session = await requireRole("student");

  let body: {
    assessmentId?: string;
    pageId?: string;
    transcript?: string;
    durationSec?: number;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { assessmentId, pageId, transcript, durationSec } = body;

  if (!assessmentId || !pageId) {
    return Response.json(
      { error: "assessmentId and pageId are required." },
      { status: 400 },
    );
  }

  const assessment = await assessments.get(assessmentId);
  if (!assessment) {
    return Response.json({ error: "No such assessment." }, { status: 404 });
  }

  // Reading an assessment nobody assigned to you should not create a record.
  const assigned = await assignments.find({
    assessmentId,
    studentId: session.userId,
  });

  if (!assigned) {
    return Response.json(
      { error: "That assessment is not assigned to you." },
      { status: 403 },
    );
  }

  const page = await pages.get(pageId);
  if (!page || page.bookId !== assessment.bookId) {
    return Response.json(
      { error: "That page is not part of this assessment." },
      { status: 400 },
    );
  }

  const duration = Math.max(0, durationSec ?? 0);

  const { marks, score, complete } = scoreReading(
    page.text,
    transcript ?? "",
    duration,
    assessment.passThreshold,
  );

  const attempt: Attempt = {
    id: newId(),
    assessmentId,
    studentId: session.userId,
    pageId,
    startedAt: Date.now() - Math.round(duration * 1000),
    completedAt: Date.now(),
    durationSec: duration,
    transcript: (transcript ?? "").trim(),
    marks,
    score,
    complete,
  };

  if (!(await attempts.put(attempt))) {
    return Response.json(
      { error: "Could not save the attempt. Storage is not writable." },
      { status: 500 },
    );
  }

  return Response.json({ attempt });
});
