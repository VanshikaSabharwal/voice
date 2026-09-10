"use client";

/** Books and their pages. The page text is what reading is scored against. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Banner, Button, Card, Empty, Input, PageHeader,
} from "../../components/ui";
import { BookIcon, TrashIcon } from "../../components/Icons";
import type { Book } from "../../../lib/reading/types";

type BookRow = Book & { pageCount: number };

export default function BooksPage() {
  const [books, setBooks] = useState<BookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/books");
      const data = await res.json();

      if (!res.ok) setError(data.error ?? "Could not load books.");
      else setBooks(data.books);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    /* Deferred to a microtask so the fetch is kicked off after render
       rather than synchronously inside the effect body, which would
       cascade renders. */
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, author }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not create the book.");
        return;
      }

      setTitle("");
      setAuthor("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(book: BookRow) {
    if (
      !confirm(
        `Delete "${book.title}"? Its pages, assessments and results are removed too.`,
      )
    ) {
      return;
    }

    await fetch(`/api/books?id=${encodeURIComponent(book.id)}`, {
      method: "DELETE",
    });

    await load();
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="Books"
        subtitle="Add a book, then add its pages for children to read."
      />

      {error && <Banner kind="error">{error}</Banner>}

      <Card className="mb-6">
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-3">
          <Input label="Title" value={title} onChange={setTitle} required />
          <Input label="Author" value={author} onChange={setAuthor} />
          <div className="flex items-end">
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add book"}
            </Button>
          </div>
        </form>
      </Card>

      {loading ? (
        <Empty>Loading books…</Empty>
      ) : books.length === 0 ? (
        <Empty>No books yet. Add one above to get started.</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {books.map((book) => (
            <Card key={book.id} className="flex items-start justify-between gap-3">
              <Link href={`/admin/books/${book.id}`} className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <BookIcon className="h-4 w-4 shrink-0 text-[var(--brand)]" />
                  <span className="truncate text-sm font-medium">{book.title}</span>
                </span>
                <span className="mt-1 block text-[11px] text-[var(--text-subtle)]">
                  {book.author ? `${book.author} · ` : ""}
                  {book.pageCount} {book.pageCount === 1 ? "page" : "pages"}
                </span>
              </Link>

              <button
                onClick={() => remove(book)}
                aria-label={`Delete ${book.title}`}
                className="cursor-pointer text-[var(--text-subtle)] transition hover:text-[var(--danger)]"
              >
                <TrashIcon />
              </button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
