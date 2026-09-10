"use client";

/**
 * Results and marksheets, with the completed-students filter.
 *
 * Selecting a row loads that student's per-page attempts so the teacher can
 * see not just the score but which words were missed — the part that tells
 * them what to teach next.
 */

import { useCallback, useEffect, useState } from "react";
import { Banner, Card, Empty, PageHeader } from "../../components/ui";
import ReportCard from "../../components/ReportCard";
import { grade } from "../../../lib/reading/score";
import type { Attempt } from "../../../lib/reading/types";

type Row = {
  id: string;
  studentId: string;
  studentName: string;
  assessmentId: string;
  assessmentTitle: string;
  bookTitle?: string;
  passThreshold?: number;
  progress: {
    completedPages: number;
    totalPages: number;
    averageAccuracy: number;
    complete: boolean;
  } | null;
};

type Filter = "all" | "complete" | "in-progress";

export default function ResultsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const [open, setOpen] = useState<Row | null>(null);
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [loadingAttempts, setLoadingAttempts] = useState(false);

  useEffect(() => {
    fetch("/api/assignments")
      .then((r) => r.json())
      .then((data) => setRows(data.assignments ?? []))
      .catch(() => setError("Could not load results."))
      .finally(() => setLoading(false));
  }, []);

  const openMarksheet = useCallback(async (row: Row) => {
    setOpen(row);
    setAttempts(null);
    setLoadingAttempts(true);

    try {
      const res = await fetch(
        `/api/reading/attempts?assessmentId=${encodeURIComponent(row.assessmentId)}&studentId=${encodeURIComponent(row.studentId)}`,
      );
      const data = await res.json();

      if (!res.ok) setError(data.error ?? "Could not load the marksheet.");
      else setAttempts(data.attempts ?? []);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoadingAttempts(false);
    }
  }, []);

  const visible = rows.filter((row) => {
    if (filter === "complete") return row.progress?.complete;
    if (filter === "in-progress") return !row.progress?.complete;
    return true;
  });

  const counts = {
    all: rows.length,
    complete: rows.filter((r) => r.progress?.complete).length,
    "in-progress": rows.filter((r) => !r.progress?.complete).length,
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="Results"
        subtitle="Reading scores for the students you assigned."
      />

      {error && <Banner kind="error">{error}</Banner>}

      <div className="mb-4 flex flex-wrap gap-2">
        {(["all", "complete", "in-progress"] as Filter[]).map((option) => (
          <button
            key={option}
            onClick={() => setFilter(option)}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs capitalize transition ${
              filter === option
                ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
                : "border-[var(--border-strong)] text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
            }`}
          >
            {option.replace("-", " ")} ({counts[option]})
          </button>
        ))}
      </div>

      {loading ? (
        <Empty>Loading results…</Empty>
      ) : visible.length === 0 ? (
        <Empty>
          {filter === "complete"
            ? "No students have completed an assessment yet."
            : "Nothing to show."}
        </Empty>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-[var(--border)]">
            {visible.map((row) => {
              const accuracy = row.progress?.averageAccuracy ?? 0;
              const band = grade(accuracy);

              return (
                <li key={row.id}>
                  <button
                    onClick={() => openMarksheet(row)}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-[var(--surface-muted)]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {row.studentName}
                      </p>
                      <p className="truncate text-[11px] text-[var(--text-subtle)]">
                        {row.assessmentTitle}
                        {row.progress && (
                          <>
                            {" · "}
                            {row.progress.completedPages}/{row.progress.totalPages}{" "}
                            pages passed
                          </>
                        )}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      {row.progress && row.progress.averageAccuracy > 0 && (
                        <span
                          className={`text-sm font-semibold ${
                            band.tone === "success"
                              ? "text-[var(--success)]"
                              : band.tone === "warning"
                                ? "text-[var(--warning)]"
                                : "text-[var(--danger)]"
                          }`}
                        >
                          {accuracy}%
                        </span>
                      )}

                      {row.progress?.complete && (
                        <span className="rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--success)]">
                          Complete
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="my-8 w-full max-w-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {open.studentName}
                </h2>
                <p className="text-xs text-white/70">
                  {open.assessmentTitle}
                  {open.bookTitle ? ` · ${open.bookTitle}` : ""}
                </p>
              </div>

              <button
                onClick={() => setOpen(null)}
                className="cursor-pointer rounded-lg bg-white px-3 py-1.5 text-xs font-medium"
              >
                Close
              </button>
            </div>

            {loadingAttempts ? (
              <Card>Loading marksheet…</Card>
            ) : !attempts || attempts.length === 0 ? (
              <Card>This student has not read any pages yet.</Card>
            ) : (
              <div className="space-y-3">
                {attempts.map((attempt, i) => (
                  <ReportCard
                    key={attempt.id}
                    title={`Page ${i + 1}`}
                    score={attempt.score}
                    marks={attempt.marks}
                    passThreshold={open.passThreshold ?? 90}
                    complete={attempt.complete}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
