"use client";

/** A child's assigned books. Tapping one opens its pages. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Empty, PageHeader } from "../components/ui";
import { BookIcon } from "../components/Icons";

type Row = {
  id: string;
  assessmentId: string;
  assessmentTitle: string;
  bookTitle?: string;
  progress: {
    completedPages: number;
    totalPages: number;
    complete: boolean;
  } | null;
};

export default function StudentHome() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/assignments")
      .then((r) => r.json())
      .then((data) => setRows(data.assignments ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="My Reading" subtitle="Pick a book and read it out loud." />

      {loading ? (
        <Empty>Loading…</Empty>
      ) : rows.length === 0 ? (
        <Empty>Nothing to read yet. Your teacher will assign something soon.</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map((row) => {
            const done = row.progress?.completedPages ?? 0;
            const total = row.progress?.totalPages ?? 0;
            const percent = total === 0 ? 0 : (done / total) * 100;

            return (
              <Link key={row.id} href={`/student/${row.assessmentId}`}>
                <Card className="h-full transition hover:border-[var(--brand)]">
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand)]">
                      <BookIcon className="h-5 w-5" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {row.bookTitle ?? row.assessmentTitle}
                      </p>
                      <p className="truncate text-[11px] text-[var(--text-subtle)]">
                        {row.assessmentTitle}
                      </p>
                    </div>

                    {row.progress?.complete && (
                      <span className="shrink-0 rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--success)]">
                        Done
                      </span>
                    )}
                  </div>

                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                    <div
                      className="h-full rounded-full bg-[var(--brand)]"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] text-[var(--text-subtle)]">
                    {done} of {total} pages
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
