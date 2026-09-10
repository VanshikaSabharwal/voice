"use client";

/**
 * The report card for one page of reading.
 *
 * Shows the page as the child read it — every word coloured by how it was
 * scored — rather than only summary numbers, because the words a child missed
 * are what a teacher acts on. The numbers say how well; the marked text says
 * what to practise.
 */

import type { PageScore, WordMark } from "../../lib/reading/types";
import { grade } from "../../lib/reading/score";

const TONE = {
  success: {
    text: "text-[var(--success)]",
    bg: "bg-[var(--success-soft)]",
  },
  warning: {
    text: "text-[var(--warning)]",
    bg: "bg-[var(--warning-soft)]",
  },
  danger: {
    text: "text-[var(--danger)]",
    bg: "bg-[var(--danger-soft)]",
  },
} as const;

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg bg-[var(--surface-muted)] p-3">
      <p className="text-[11px] font-medium text-[var(--text-subtle)]">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {hint && <p className="text-[11px] text-[var(--text-subtle)]">{hint}</p>}
    </div>
  );
}

/** The page text with each word coloured by its mark. */
export function MarkedText({ marks }: { marks: WordMark[] }) {
  return (
    <p className="flex flex-wrap gap-x-1.5 gap-y-1 text-base leading-relaxed">
      {marks.map((mark, i) => {
        if (mark.kind === "correct") {
          return (
            <span key={i} className="text-[var(--foreground)]">
              {mark.expected}
            </span>
          );
        }

        if (mark.kind === "substituted") {
          return (
            <span
              key={i}
              title={`Read as "${mark.spoken}"`}
              className="rounded bg-[var(--warning-soft)] px-1 text-[var(--warning)] underline decoration-wavy underline-offset-4"
            >
              {mark.expected}
            </span>
          );
        }

        if (mark.kind === "omitted") {
          return (
            <span
              key={i}
              title="Skipped"
              className="rounded bg-[var(--danger-soft)] px-1 text-[var(--danger)] line-through"
            >
              {mark.expected}
            </span>
          );
        }

        // Insertions are not on the page, so they are shown in brackets at the
        // point they were spoken rather than styled as page text.
        return (
          <span
            key={i}
            title="Extra word"
            className="rounded bg-[var(--surface-muted)] px-1 text-[var(--text-subtle)] italic"
          >
            +{mark.spoken}
          </span>
        );
      })}
    </p>
  );
}

export function Legend() {
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-[var(--text-subtle)]">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-[var(--warning-soft)]" />
        Misread
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-[var(--danger-soft)]" />
        Skipped
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-[var(--surface-muted)]" />
        Extra word
      </span>
    </div>
  );
}

export default function ReportCard({
  score,
  marks,
  passThreshold,
  complete,
  title,
}: {
  score: PageScore;
  marks: WordMark[];
  passThreshold: number;
  complete: boolean;
  title?: string;
}) {
  const band = grade(score.accuracy);
  const tone = TONE[band.tone];

  return (
    <div className="rounded-xl border border-[var(--border)] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {title && <p className="text-sm font-semibold">{title}</p>}
          <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
            Pass mark {passThreshold}% word accuracy
          </p>
        </div>

        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${tone.bg} ${tone.text}`}
        >
          {complete ? "Complete" : "Not yet passed"} · {band.label}
        </span>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className={`text-4xl font-semibold ${tone.text}`}>
          {score.accuracy}%
        </span>
        <span className="text-sm text-[var(--text-muted)]">word accuracy</span>
      </div>

      {/* A bar with the pass mark drawn on it, so "how close was it" is
          readable at a glance rather than needing arithmetic. */}
      <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-muted)]">
        <div
          className={`h-full rounded-full ${
            complete ? "bg-[var(--success)]" : "bg-[var(--warning)]"
          }`}
          style={{ width: `${Math.min(100, score.accuracy)}%` }}
        />
        <span
          className="absolute inset-y-0 w-px bg-[var(--text-subtle)]"
          style={{ left: `${passThreshold}%` }}
          aria-hidden="true"
        />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Correct"
          value={`${score.correct}`}
          hint={`of ${score.totalWords} words`}
        />
        <Stat label="Misread" value={`${score.substituted}`} />
        <Stat label="Skipped" value={`${score.omitted}`} />
        <Stat label="Fluency" value={`${score.wpm}`} hint="correct wpm" />
      </div>

      {marks.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-[11px] font-medium text-[var(--text-subtle)]">
            How it was read
          </p>
          <MarkedText marks={marks} />
          <div className="mt-3">
            <Legend />
          </div>
        </div>
      )}
    </div>
  );
}
