"use client";

/** Pages of one assessment, with each page's best score so far. */

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, Empty, PageHeader } from "../../components/ui";

type PageRow = {
  id: string;
  number: number;
  text: string;
  imageUrl?: string;
  best: { accuracy: number; complete: boolean } | null;
};

export default function AssessmentPages() {
  const params = useParams<{ assessmentId: string }>();
  const assessmentId = params.assessmentId;

  const [title, setTitle] = useState("");
  const [pages, setPages] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/reading/assessment?id=${encodeURIComponent(assessmentId)}`)
      .then((r) => r.json())
      .then((data) => {
        setTitle(data.assessment?.bookTitle ?? "");
        setPages(data.pages ?? []);
      })
      .catch(() => setPages([]))
      .finally(() => setLoading(false));
  }, [assessmentId]);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link
        href="/student"
        className="mb-3 inline-block text-xs text-[var(--text-muted)] hover:text-[var(--brand)]"
      >
        ← My reading
      </Link>

      <PageHeader title={title} subtitle="Tap a page to read it out loud." />

      {loading ? (
        <Empty>Loading pages…</Empty>
      ) : pages.length === 0 ? (
        <Empty>This book has no pages yet.</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {pages.map((page) => (
            <Link
              key={page.id}
              href={`/student/${assessmentId}/${page.id}`}
            >
              <Card className="h-full transition hover:border-[var(--brand)]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">Page {page.number}</span>

                  {page.best && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        page.best.complete
                          ? "bg-[var(--success-soft)] text-[var(--success)]"
                          : "bg-[var(--warning-soft)] text-[var(--warning)]"
                      }`}
                    >
                      {page.best.complete ? "Done" : `${page.best.accuracy}%`}
                    </span>
                  )}
                </div>

                {page.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={page.imageUrl}
                    alt={`Page ${page.number}`}
                    className="mt-3 h-28 w-full rounded-lg object-cover"
                  />
                )}

                <p className="mt-2 line-clamp-2 text-[11px] text-[var(--text-subtle)]">
                  {page.text}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
