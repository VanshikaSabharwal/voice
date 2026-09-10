"use client";

/**
 * Reading assessments: a book, the pages it covers, and the pass mark.
 * Admins create them here; teachers assign them from their own section.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Banner, Button, Card, Dropdown, Empty, Input, PageHeader,
} from "../../components/ui";
import { TrashIcon } from "../../components/Icons";
import { DEFAULT_PASS_THRESHOLD } from "../../../lib/reading/score";
import type { Assessment, Book, Page } from "../../../lib/reading/types";

type AssessmentRow = Assessment & { bookTitle: string; pageCount: number };

export default function AssessmentsPage() {
  const [rows, setRows] = useState<AssessmentRow[]>([]);
  const [books, setBooks] = useState<(Book & { pageCount: number })[]>([]);
  const [pagesByBook, setPagesByBook] = useState<Record<string, Page[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [bookId, setBookId] = useState("");
  const [threshold, setThreshold] = useState(String(DEFAULT_PASS_THRESHOLD));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [assessmentsRes, booksRes] = await Promise.all([
        fetch("/api/assessments"),
        fetch("/api/books"),
      ]);

      const assessmentsData = await assessmentsRes.json();
      const booksData = await booksRes.json();

      setRows(assessmentsData.assessments ?? []);
      setBooks(booksData.books ?? []);
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

  /* Pages load per selected book so the page picker can offer a real choice.
     They are stored against the book they belong to, and the visible list is
     derived below — so clearing the selection needs no state update here, and
     re-picking a book already fetched shows its pages immediately. */
  useEffect(() => {
    if (!bookId) return;

    let cancelled = false;

    fetch(`/api/pages?bookId=${encodeURIComponent(bookId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setPagesByBook((current) => ({
            ...current,
            [bookId]: data.pages ?? [],
          }));
        }
      })
      .catch(() => {
        // The picker stays empty; the form still submits every page.
      });

    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const pages = bookId ? (pagesByBook[bookId] ?? []) : [];

  function togglePage(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/assessments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          bookId,
          // Empty means every page, now and any added later.
          pageIds: [...selected],
          passThreshold: Number(threshold),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not create the assessment.");
        return;
      }

      setTitle("");
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: AssessmentRow) {
    if (
      !confirm(`Delete "${row.title}"? Assignments and results are removed too.`)
    ) {
      return;
    }

    await fetch(`/api/assessments?id=${encodeURIComponent(row.id)}`, {
      method: "DELETE",
    });

    await load();
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="Reading Assessments"
        subtitle="Teachers assign these to their students."
      />

      {error && <Banner kind="error">{error}</Banner>}

      {books.length === 0 && !loading ? (
        <Banner kind="info">
          Add a book with at least one page before creating an assessment.
        </Banner>
      ) : (
        <Card className="mb-6">
          <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
            <Input label="Title" value={title} onChange={setTitle} required />

            <Dropdown
              label="Book"
              value={bookId}
              onChange={(next) => {
                // Page ids belong to the previous book; carrying them over
                // would submit pages that are not in the chosen one.
                setBookId(next);
                setSelected(new Set());
              }}
              options={[
                { value: "", label: "Select a book…" },
                ...books.map((b) => ({
                  value: b.id,
                  label: `${b.title} (${b.pageCount} pages)`,
                })),
              ]}
            />

            <Input
              label="Pass mark (% word accuracy)"
              type="number"
              value={threshold}
              onChange={setThreshold}
            />

            {pages.length > 0 && (
              <div className="sm:col-span-2">
                <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">
                  Pages{" "}
                  <span className="text-[var(--text-subtle)]">
                    — leave all unchecked to include every page
                  </span>
                </p>

                <div className="flex flex-wrap gap-2">
                  {pages.map((page) => (
                    <button
                      key={page.id}
                      type="button"
                      onClick={() => togglePage(page.id)}
                      className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs transition ${
                        selected.has(page.id)
                          ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
                          : "border-[var(--border-strong)] text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                      }`}
                    >
                      Page {page.index + 1}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy || !bookId || !title.trim()}>
                {busy ? "Creating…" : "Create assessment"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {loading ? (
        <Empty>Loading assessments…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No assessments yet.</Empty>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Card key={row.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.title}</p>
                <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
                  {row.bookTitle} · {row.pageCount}{" "}
                  {row.pageCount === 1 ? "page" : "pages"} · pass at{" "}
                  {row.passThreshold}%
                </p>
              </div>

              <button
                onClick={() => remove(row)}
                aria-label={`Delete ${row.title}`}
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
