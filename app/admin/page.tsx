"use client";

/** Admin landing: counts, and the order the setup steps happen in. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, PageHeader } from "../components/ui";
import {
  BookIcon, ClipboardIcon, UsersIcon,
} from "../components/Icons";

type Counts = {
  books: number;
  assessments: number;
  teachers: number;
  students: number;
};

export default function AdminHome() {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch("/api/books").then((r) => r.json()),
      fetch("/api/assessments").then((r) => r.json()),
      fetch("/api/users").then((r) => r.json()),
    ])
      .then(([books, assessments, users]) => {
        if (cancelled) return;

        const list = users.users ?? [];

        setCounts({
          books: books.books?.length ?? 0,
          assessments: assessments.assessments?.length ?? 0,
          teachers: list.filter((u: { role: string }) => u.role === "teacher").length,
          students: list.filter((u: { role: string }) => u.role === "student").length,
        });
      })
      .catch(() => {
        // The cards render dashes; the sections below still work.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const cards = [
    {
      href: "/admin/books",
      label: "Books",
      value: counts?.books,
      Icon: BookIcon,
      hint: "Add books and their pages",
    },
    {
      href: "/admin/assessments",
      label: "Assessments",
      value: counts?.assessments,
      Icon: ClipboardIcon,
      hint: "Define what gets read",
    },
    {
      href: "/admin/users",
      label: "Teachers",
      value: counts?.teachers,
      Icon: UsersIcon,
      hint: "They assign the reading",
    },
    {
      href: "/admin/users",
      label: "Students",
      value: counts?.students,
      Icon: UsersIcon,
      hint: "They do the reading",
    },
  ];

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="Overview"
        subtitle="Set up books and assessments, then let teachers assign them."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <Link key={card.label} href={card.href}>
            <Card className="h-full transition hover:border-[var(--brand)]">
              <card.Icon className="h-5 w-5 text-[var(--brand)]" />
              <p className="mt-3 text-2xl font-semibold">
                {card.value ?? "—"}
              </p>
              <p className="text-sm font-medium">{card.label}</p>
              <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
                {card.hint}
              </p>
            </Card>
          </Link>
        ))}
      </div>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold">Getting started</h2>
        <ol className="mt-3 space-y-2 text-sm text-[var(--text-muted)]">
          <li>
            <span className="font-medium text-[var(--foreground)]">1.</span> Add a
            book and type its pages — the text is what each child&rsquo;s reading
            is scored against.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">2.</span>{" "}
            Create an assessment over those pages and set the pass mark.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">3.</span> Add
            teachers and students, linking each student to a teacher.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">4.</span>{" "}
            Teachers assign the assessment; students read it aloud.
          </li>
        </ol>
      </Card>
    </div>
  );
}
