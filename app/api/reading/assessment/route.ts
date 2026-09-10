/**
 * Everything the reading screen needs for one assessment: its pages, and the
 * student's best attempt on each so completed pages show as done.
 */

import { guarded, requireRole } from "../../../../lib/auth/guard";
import {
  assessments,
  assignments,
  bestAttempts,
  books,
  pagesOfAssessment,
  users,
} from "../../../../lib/store/reading";

export const dynamic = "force-dynamic";

export const GET = guarded(async (request: Request) => {
  const session = await requireRole("student", "teacher", "admin");
  const params = new URL(request.url).searchParams;

  const id = params.get("id");

  if (!id) return Response.json({ error: "id is required." }, { status: 400 });

  const assessment = await assessments.get(id);

  if (!assessment) {
    return Response.json({ error: "No such assessment." }, { status: 404 });
  }

  /* Students see only what was assigned to them. Staff may inspect any
     assessment, which is how a teacher previews what a child will read. */
  let studentId = session.userId;

  if (session.role === "student") {
    const assigned = await assignments.find({
      assessmentId: id,
      studentId: session.userId,
    });

    if (!assigned) {
      return Response.json(
        { error: "That assessment is not assigned to you." },
        { status: 403 },
      );
    }
  } else {
    const requested = params.get("studentId");

    if (requested && (await users.get(requested))) studentId = requested;
  }

  const pages = await pagesOfAssessment(assessment);
  const best = await bestAttempts(id, studentId);

  const book = await books.get(assessment.bookId);

  return Response.json({
    assessment: {
      id: assessment.id,
      title: assessment.title,
      passThreshold: assessment.passThreshold,
      bookTitle: book?.title ?? "Unknown book",
    },
    pages: pages.map((page, i) => {
      const attempt = best.get(page.id);

      return {
        id: page.id,
        number: i + 1,
        text: page.text,
        imageUrl: page.imageUrl,
        best: attempt
          ? { accuracy: attempt.score.accuracy, complete: attempt.complete }
          : null,
      };
    }),
  });
});
