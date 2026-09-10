/**
 * Assigning students to assessments — the teacher's role in the system.
 *
 * GET returns progress alongside each assignment, which is what powers the
 * teacher's "completed only" filter and the marksheet.
 */

import { guarded, requireRole } from "../../../lib/auth/guard";
import {
  assessments,
  assignments,
  books,
  newId,
  progressFor,
  users,
} from "../../../lib/store/reading";
import type { Assignment } from "../../../lib/reading/types";

export const dynamic = "force-dynamic";

export const GET = guarded(async (request: Request) => {
  const session = await requireRole("admin", "teacher", "student");
  const params = new URL(request.url).searchParams;

  const filter: Partial<Assignment> = {};

  const assessmentId = params.get("assessmentId");
  if (assessmentId) filter.assessmentId = assessmentId;

  /* A student may only ever see their own assignments, whatever they ask for;
     a teacher sees only what they assigned. Both are enforced here rather than
     trusting a studentId query parameter, which the client controls. */
  if (session.role === "student") {
    filter.studentId = session.userId;
  } else {
    if (session.role === "teacher") filter.assignedBy = session.userId;

    const studentId = params.get("studentId");
    if (studentId) filter.studentId = studentId;
  }

  const list = await assignments.list(filter);

  const assessmentById = new Map((await assessments.list()).map((a) => [a.id, a]));
  const bookTitles = new Map((await books.list()).map((b) => [b.id, b.title]));
  const studentNames = new Map(
    (await users.list({ role: "student" })).map((u) => [u.id, u.name]),
  );

  const enriched = await Promise.all(
    list.map(async (assignment) => {
      const assessment = assessmentById.get(assignment.assessmentId);

      return {
        ...assignment,
        studentName: studentNames.get(assignment.studentId) ?? "Unknown student",
        assessmentTitle: assessment?.title ?? "Unknown assessment",
        bookTitle: assessment ? bookTitles.get(assessment.bookId) : undefined,
        passThreshold: assessment?.passThreshold,
        progress: assessment
          ? await progressFor(assessment, assignment.studentId)
          : null,
      };
    }),
  );

  return Response.json({
    assignments: enriched.sort((a, b) => b.assignedAt - a.assignedAt),
  });
});

export const POST = guarded(async (request: Request) => {
  const session = await requireRole("admin", "teacher");

  let body: { assessmentId?: string; studentIds?: string[] };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { assessmentId, studentIds } = body;

  if (!assessmentId || !(await assessments.get(assessmentId))) {
    return Response.json(
      { error: "A valid assessment is required." },
      { status: 400 },
    );
  }

  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    return Response.json(
      { error: "Select at least one student." },
      { status: 400 },
    );
  }

  const created: Assignment[] = [];
  const skipped: string[] = [];

  for (const studentId of studentIds) {
    const student = await users.get(studentId);

    if (!student || student.role !== "student") {
      skipped.push(studentId);
      continue;
    }

    // A teacher may only assign their own students.
    if (session.role === "teacher" && student.teacherId !== session.userId) {
      skipped.push(studentId);
      continue;
    }

    // Assigning the same assessment twice would show the child a duplicate row.
    if (await assignments.find({ assessmentId, studentId })) continue;

    const assignment: Assignment = {
      id: newId(),
      assessmentId,
      studentId,
      assignedBy: session.userId,
      assignedAt: Date.now(),
    };

    if (await assignments.put(assignment)) created.push(assignment);
  }

  return Response.json({ created, skipped });
});

export const DELETE = guarded(async (request: Request) => {
  const session = await requireRole("admin", "teacher");

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required." }, { status: 400 });

  const assignment = await assignments.get(id);
  if (!assignment) return Response.json({ error: "No such assignment." }, { status: 404 });

  if (session.role === "teacher" && assignment.assignedBy !== session.userId) {
    return Response.json(
      { error: "You can only remove assignments you made." },
      { status: 403 },
    );
  }

  await assignments.remove(id);

  /* Attempts are kept: unassigning should not destroy a child's recorded
     reading history, which the teacher may still need for reporting. */

  return Response.json({ ok: true });
});
