"use client";

/**
 * Assigning assessments to students — the teacher's one power. Teachers cannot
 * create assessments or accounts; the API enforces that, this page reflects it.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Banner, Button, Card, Dropdown, Empty, PageHeader,
} from "../components/ui";
import { TrashIcon } from "../components/Icons";
import type { SafeUser } from "../../lib/reading/types";

type AssessmentRow = { id: string; title: string; bookTitle: string; pageCount: number };

type AssignmentRow = {
  id: string;
  studentName: string;
  assessmentTitle: string;
  progress: { completedPages: number; totalPages: number; complete: boolean } | null;
};

export default function TeacherHome() {
  const [students, setStudents] = useState<SafeUser[]>([]);
  const [assessments, setAssessments] = useState<AssessmentRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [assessmentId, setAssessmentId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [studentsRes, assessmentsRes, assignmentsRes] = await Promise.all([
        fetch("/api/users?role=student"),
        fetch("/api/assessments"),
        fetch("/api/assignments"),
      ]);

      const studentsData = await studentsRes.json();
      const assessmentsData = await assessmentsRes.json();
      const assignmentsData = await assignmentsRes.json();

      setStudents(studentsData.users ?? []);
      setAssessments(assessmentsData.assessments ?? []);
      setAssignments(assignmentsData.assignments ?? []);
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

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function assign(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assessmentId, studentIds: [...selected] }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not assign the assessment.");
        return;
      }

      /* Already-assigned students are silently skipped by the API rather than
         erroring, so report what actually happened. */
      const created = data.created?.length ?? 0;

      setNotice(
        created === 0
          ? "Those students already have this assessment."
          : `Assigned to ${created} ${created === 1 ? "student" : "students"}.`,
      );

      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function unassign(row: AssignmentRow) {
    if (!confirm(`Remove "${row.assessmentTitle}" from ${row.studentName}?`)) return;

    await fetch(`/api/assignments?id=${encodeURIComponent(row.id)}`, {
      method: "DELETE",
    });

    await load();
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="Assign Reading"
        subtitle="Choose an assessment and the students who should read it."
      />

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="success">{notice}</Banner>}

      {!loading && students.length === 0 && (
        <Banner kind="info">
          No students are linked to you yet. An administrator assigns students to
          teachers.
        </Banner>
      )}

      {students.length > 0 && assessments.length > 0 && (
        <Card className="mb-6">
          <form onSubmit={assign}>
            <Dropdown
              label="Assessment"
              value={assessmentId}
              onChange={setAssessmentId}
              options={[
                { value: "", label: "Select an assessment…" },
                ...assessments.map((a) => ({
                  value: a.id,
                  label: `${a.title} — ${a.bookTitle}`,
                })),
              ]}
            />

            <p className="mb-2 mt-4 text-xs font-medium text-[var(--text-muted)]">
              Students
            </p>

            <div className="flex flex-wrap gap-2">
              {students.map((student) => (
                <button
                  key={student.id}
                  type="button"
                  onClick={() => toggle(student.id)}
                  className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs transition ${
                    selected.has(student.id)
                      ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
                      : "border-[var(--border-strong)] text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                  }`}
                >
                  {student.name}
                </button>
              ))}
            </div>

            <div className="mt-4">
              <Button
                type="submit"
                disabled={busy || !assessmentId || selected.size === 0}
              >
                {busy ? "Assigning…" : `Assign to ${selected.size || "…"}`}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-subtle)]">
        Current assignments
      </h2>

      {loading ? (
        <Empty>Loading…</Empty>
      ) : assignments.length === 0 ? (
        <Empty>Nothing assigned yet.</Empty>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-[var(--border)]">
            {assignments.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.studentName}</p>
                  <p className="truncate text-[11px] text-[var(--text-subtle)]">
                    {row.assessmentTitle}
                    {row.progress && (
                      <>
                        {" · "}
                        {row.progress.completedPages}/{row.progress.totalPages} pages
                      </>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  {row.progress?.complete && (
                    <span className="rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--success)]">
                      Complete
                    </span>
                  )}

                  <button
                    onClick={() => unassign(row)}
                    aria-label="Remove assignment"
                    className="cursor-pointer text-[var(--text-subtle)] transition hover:text-[var(--danger)]"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
