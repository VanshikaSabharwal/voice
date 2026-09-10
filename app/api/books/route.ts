/**
 * Books. Admins write; teachers and students read, since both need titles to
 * render assessments and the reading UI.
 */

import { guarded, requireRole } from "../../../lib/auth/guard";
import {
  books,
  deleteBookCascade,
  newId,
  pagesOfBook,
} from "../../../lib/store/reading";
import type { Book } from "../../../lib/reading/types";

export const dynamic = "force-dynamic";

export const GET = guarded(async () => {
  await requireRole("admin", "teacher", "student");

  const list = await books.list();

  /* Page counts come along because every list view shows them, and fetching
     them per-book from the client would be a request per row. */
  const withCounts = await Promise.all(
    list.map(async (book) => ({
      ...book,
      pageCount: (await pagesOfBook(book.id)).length,
    })),
  );

  return Response.json({
    books: withCounts.sort((a, b) => b.createdAt - a.createdAt),
  });
});

export const POST = guarded(async (request: Request) => {
  await requireRole("admin");

  let body: { title?: string; author?: string; coverUrl?: string };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.title?.trim()) {
    return Response.json({ error: "A title is required." }, { status: 400 });
  }

  const book: Book = {
    id: newId(),
    title: body.title.trim(),
    author: body.author?.trim() || undefined,
    coverUrl: body.coverUrl || undefined,
    createdAt: Date.now(),
  };

  if (!(await books.put(book))) {
    return Response.json(
      { error: "Could not save the book. Storage is not writable." },
      { status: 500 },
    );
  }

  return Response.json({ book });
});

export const PATCH = guarded(async (request: Request) => {
  await requireRole("admin");

  let body: { id?: string; title?: string; author?: string; coverUrl?: string };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.id) return Response.json({ error: "id is required." }, { status: 400 });

  const changes: Partial<Book> = {};
  if (body.title?.trim()) changes.title = body.title.trim();
  if (body.author !== undefined) changes.author = body.author.trim() || undefined;
  if (body.coverUrl !== undefined) changes.coverUrl = body.coverUrl || undefined;

  const updated = await books.patch(body.id, changes);

  if (!updated) return Response.json({ error: "No such book." }, { status: 404 });

  return Response.json({ book: updated });
});

export const DELETE = guarded(async (request: Request) => {
  await requireRole("admin");

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required." }, { status: 400 });

  // Cascades to pages, assessments, assignments and attempts — see
  // deleteBookCascade for why each is included.
  await deleteBookCascade(id);

  return Response.json({ ok: true });
});
