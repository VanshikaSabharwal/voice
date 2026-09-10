/**
 * Reading assessments. Admins create them; teachers read them in order to
 * assign students, which is the only assessment power a teacher has.
 */

import { guarded, requireRole } from "../../../lib/auth/guard";
import { DEFAULT_PASS_THRESHOLD } from "../../../lib/reading/score";
import {
  assessments,
  assignments,
  attempts,
  books,
  newId,
  pagesOfAssessment,
} from "../../../lib/store/reading";
import type { Assessment } from "../../../lib/reading/types";

export const dynamic = "force-dynamic";

export const GET = guarded(async () => {
  await requireRole("admin", "teacher");

  const list = await assessments.list();
  const titles = new Map((await books.list()).map((b) => [b.id, b.title]));

  /* Book title and page count are joined here because every list view needs
     both, and resolving them client-side would be two extra requests per row. */
  const enriched = await Promise.all(
    list.map(async (assessment) => ({
      ...assessment,
      bookTitle: titles.get(assessment.bookId) ?? "Unknown book",
      pageCount: (await pagesOfAssessment(assessment)).length,
    })),
  );

  return Response.json({
    assessments: enriched.sort((a, b) => b.createdAt - a.createdAt),
  });
});

export const POST = guarded(async (request: Request) => {
  const session = await requireRole("admin");

  let body: {
    title?: string;
    bookId?: string;
    pageIds?: string[];
    passThreshold?: number;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { title, bookId, pageIds, passThreshold } = body;

  if (!title?.trim()) {
    return Response.json({ error: "A title is required." }, { status: 400 });
  }

  if (!bookId || !(await books.get(bookId))) {
    return Response.json({ error: "A valid book is required." }, { status: 400 });
  }

  const threshold = passThreshold ?? DEFAULT_PASS_THRESHOLD;

  if (threshold < 1 || threshold > 100) {
    return Response.json(
      { error: "The pass threshold must be between 1 and 100." },
      { status: 400 },
    );
  }

  const assessment: Assessment = {
    id: newId(),
    title: title.trim(),
    bookId,
    // Empty means every page, including pages added later — see
    // pagesOfAssessment.
    pageIds: Array.isArray(pageIds) ? pageIds : [],
    passThreshold: threshold,
    createdAt: Date.now(),
    createdBy: session.userId,
  };

  if (!(await assessments.put(assessment))) {
    return Response.json(
      { error: "Could not save the assessment. Storage is not writable." },
      { status: 500 },
    );
  }

  return Response.json({ assessment });
});

export const PATCH = guarded(async (request: Request) => {
  await requireRole("admin");

  let body: {
    id?: string;
    title?: string;
    pageIds?: string[];
    passThreshold?: number;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.id) return Response.json({ error: "id is required." }, { status: 400 });

  const changes: Partial<Assessment> = {};

  if (body.title?.trim()) changes.title = body.title.trim();
  if (Array.isArray(body.pageIds)) changes.pageIds = body.pageIds;

  if (body.passThreshold !== undefined) {
    if (body.passThreshold < 1 || body.passThreshold > 100) {
      return Response.json(
        { error: "The pass threshold must be between 1 and 100." },
        { status: 400 },
      );
    }
    changes.passThreshold = body.passThreshold;
  }

  const updated = await assessments.patch(body.id, changes);

  if (!updated) return Response.json({ error: "No such assessment." }, { status: 404 });

  return Response.json({ assessment: updated });
});

export const DELETE = guarded(async (request: Request) => {
  await requireRole("admin");

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required." }, { status: 400 });

  await assignments.removeWhere({ assessmentId: id });
  await attempts.removeWhere({ assessmentId: id });
  await assessments.remove(id);

  return Response.json({ ok: true });
});
