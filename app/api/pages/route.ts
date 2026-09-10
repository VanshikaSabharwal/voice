/**
 * Book pages. The `text` field is the ground truth every reading attempt is
 * scored against, so it is required even when a page image is uploaded.
 */

import { guarded, requireRole } from "../../../lib/auth/guard";
import { attempts, newId, pages, pagesOfBook } from "../../../lib/store/reading";
import type { Page } from "../../../lib/reading/types";

export const dynamic = "force-dynamic";

export const GET = guarded(async (request: Request) => {
  await requireRole("admin", "teacher", "student");

  const bookId = new URL(request.url).searchParams.get("bookId");

  if (!bookId) {
    return Response.json({ error: "bookId is required." }, { status: 400 });
  }

  return Response.json({ pages: await pagesOfBook(bookId) });
});

export const POST = guarded(async (request: Request) => {
  await requireRole("admin");

  let body: { bookId?: string; text?: string; imageUrl?: string; index?: number };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { bookId, text, imageUrl } = body;

  if (!bookId) return Response.json({ error: "bookId is required." }, { status: 400 });

  if (!text?.trim()) {
    return Response.json(
      { error: "Page text is required — it is what the reading is scored against." },
      { status: 400 },
    );
  }

  /* Default to the end of the book so adding pages in order needs no index
     bookkeeping from the client. */
  const existing = await pagesOfBook(bookId);
  const index = body.index ?? existing.length;

  const page: Page = {
    id: newId(),
    bookId,
    index,
    text: text.trim(),
    imageUrl: imageUrl || undefined,
  };

  if (!(await pages.put(page))) {
    return Response.json(
      { error: "Could not save the page. Storage is not writable." },
      { status: 500 },
    );
  }

  return Response.json({ page });
});

export const PATCH = guarded(async (request: Request) => {
  await requireRole("admin");

  let body: { id?: string; text?: string; imageUrl?: string; index?: number };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.id) return Response.json({ error: "id is required." }, { status: 400 });

  const changes: Partial<Page> = {};

  if (body.text !== undefined) {
    if (!body.text.trim()) {
      return Response.json({ error: "Page text cannot be empty." }, { status: 400 });
    }
    changes.text = body.text.trim();
  }

  if (body.imageUrl !== undefined) changes.imageUrl = body.imageUrl || undefined;
  if (body.index !== undefined) changes.index = body.index;

  const updated = await pages.patch(body.id, changes);

  if (!updated) return Response.json({ error: "No such page." }, { status: 404 });

  return Response.json({ page: updated });
});

export const DELETE = guarded(async (request: Request) => {
  await requireRole("admin");

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required." }, { status: 400 });

  const page = await pages.get(id);
  if (!page) return Response.json({ error: "No such page." }, { status: 404 });

  await pages.remove(id);

  // Attempts against a deleted page can never be re-read or re-scored, and
  // would render as blank rows on the marksheet.
  await attempts.removeWhere({ pageId: id });

  /* Close the gap left in the ordering, so page numbers shown to a child stay
     consecutive rather than jumping from 2 to 4. */
  const remaining = await pagesOfBook(page.bookId);

  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].index !== i) {
      await pages.patch(remaining[i].id, { index: i });
    }
  }

  return Response.json({ ok: true });
});
