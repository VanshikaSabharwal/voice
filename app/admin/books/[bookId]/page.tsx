"use client";

/**
 * Pages of one book.
 *
 * The text field is mandatory even when a page image is uploaded: the image is
 * what the child looks at, but the text is the ground truth every spoken word
 * is aligned against, so a page without it cannot be scored.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Banner, Button, Card, Empty, PageHeader, TextArea,
} from "../../../components/ui";
import { TrashIcon } from "../../../components/Icons";
import type { Book, Page } from "../../../../lib/reading/types";

export default function BookPagesPage() {
  const params = useParams<{ bookId: string }>();
  const bookId = params.bookId;

  const [book, setBook] = useState<Book | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [booksRes, pagesRes] = await Promise.all([
        fetch("/api/books"),
        fetch(`/api/pages?bookId=${encodeURIComponent(bookId)}`),
      ]);

      const booksData = await booksRes.json();
      const pagesData = await pagesRes.json();

      setBook(booksData.books?.find((b: Book) => b.id === bookId) ?? null);
      setPages(pagesData.pages ?? []);
    } catch {
      setError("Could not load the book.");
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    /* Deferred to a microtask so the fetch is kicked off after render
       rather than synchronously inside the effect body, which would
       cascade renders. */
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

  async function upload(file: File) {
    setUploading(true);
    setError(null);

    try {
      const form = new FormData();
      form.append("file", file);

      const res = await fetch("/api/uploads", { method: "POST", body: form });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not upload the image.");
        return;
      }

      setImageUrl(data.url);
    } finally {
      setUploading(false);
    }
  }

  async function addPage(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, text, imageUrl }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not add the page.");
        return;
      }

      setText("");
      setImageUrl(null);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removePage(page: Page) {
    if (!confirm(`Delete page ${page.index + 1}?`)) return;

    await fetch(`/api/pages?id=${encodeURIComponent(page.id)}`, {
      method: "DELETE",
    });

    await load();
  }

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Link
        href="/admin/books"
        className="mb-3 inline-block text-xs text-[var(--text-muted)] hover:text-[var(--brand)]"
      >
        ← All books
      </Link>

      <PageHeader
        title={book?.title ?? "Book"}
        subtitle={book?.author ? `by ${book.author}` : undefined}
      />

      {error && <Banner kind="error">{error}</Banner>}

      <Card className="mb-6">
        <form onSubmit={addPage}>
          <TextArea
            label={`Page ${pages.length + 1} text`}
            value={text}
            onChange={setText}
            rows={4}
            placeholder="Type exactly what is printed on this page…"
            hint={`${wordCount} ${wordCount === 1 ? "word" : "words"} · this is what the child's reading is scored against`}
          />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload(file);
              }}
              className="text-xs text-[var(--text-muted)] file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-[var(--border-strong)] file:bg-white file:px-3 file:py-1.5 file:text-xs"
            />

            {uploading && (
              <span className="text-[11px] text-[var(--text-subtle)]">
                Uploading…
              </span>
            )}

            {imageUrl && (
              <span className="flex items-center gap-2 text-[11px] text-[var(--success)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt="Page preview"
                  className="h-10 w-10 rounded object-cover"
                />
                Image attached
              </span>
            )}
          </div>

          <div className="mt-4">
            <Button type="submit" disabled={busy || uploading || !text.trim()}>
              {busy ? "Adding…" : "Add page"}
            </Button>
          </div>
        </form>
      </Card>

      {loading ? (
        <Empty>Loading pages…</Empty>
      ) : pages.length === 0 ? (
        <Empty>No pages yet. Add the first one above.</Empty>
      ) : (
        <div className="space-y-3">
          {pages.map((page) => (
            <Card key={page.id} className="flex gap-4">
              {page.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={page.imageUrl}
                  alt={`Page ${page.index + 1}`}
                  className="h-20 w-20 shrink-0 rounded-lg object-cover"
                />
              )}

              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-[var(--text-subtle)]">
                  Page {page.index + 1} ·{" "}
                  {page.text.trim().split(/\s+/).length} words
                </p>
                <p className="mt-1 text-sm leading-relaxed">{page.text}</p>
              </div>

              <button
                onClick={() => removePage(page)}
                aria-label={`Delete page ${page.index + 1}`}
                className="h-fit cursor-pointer text-[var(--text-subtle)] transition hover:text-[var(--danger)]"
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
