"use client";

/**
 * What a run will do, shown before it does it.
 *
 * This is the cost gate: the Run button lives here, next to the number of
 * billed calls it will make, so the two cannot be seen apart.
 */

import { targetLabel } from "../../../lib/eval/types";
import type { RunPlan } from "../../../lib/eval/types";

export default function PlanBanner({
  plan,
  pricingNote,
  running,
  onRun,
}: {
  plan: RunPlan;
  pricingNote: string | null;
  running: boolean;
  onRun: () => void;
}) {
  const nothingToRun = plan.targets.length === 0;

  return (
    <div className="mt-6 rounded-xl border border-[var(--border)] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Before you run</p>

          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {plan.targets.length}{" "}
            {plan.targets.length === 1 ? "provider" : "providers"} ×{" "}
            {plan.runsPerTarget}{" "}
            {plan.runsPerTarget === 1 ? "repetition" : "repetitions"} ={" "}
            <strong className="text-[var(--foreground)]">
              {plan.totalCalls} billed API {plan.totalCalls === 1 ? "call" : "calls"}
            </strong>
          </p>

          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Estimated cost:{" "}
            {plan.estimatedCostUsd === null ? (
              <span className="text-[var(--warning)]">unknown</span>
            ) : (
              <strong className="text-[var(--foreground)]">
                ${plan.estimatedCostUsd.toFixed(4)}
              </strong>
            )}
          </p>
        </div>

        <button
          onClick={onRun}
          disabled={running || nothingToRun}
          className="cursor-pointer rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[var(--brand-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running
            ? "Running…"
            : `Run ${plan.totalCalls} call${plan.totalCalls === 1 ? "" : "s"}`}
        </button>
      </div>

      {pricingNote && (
        <p className="mt-3 rounded-lg bg-[var(--warning-soft)] px-3 py-2 text-[11px] text-[var(--warning)]">
          {pricingNote}
        </p>
      )}

      {plan.notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {plan.notes.map((note) => (
            <li key={note} className="text-[11px] text-[var(--text-subtle)]">
              — {note}
            </li>
          ))}
        </ul>
      )}

      {plan.unavailable.length > 0 && (
        <div className="mt-3 rounded-lg bg-[var(--surface-muted)] p-3">
          <p className="text-[11px] font-medium text-[var(--text-subtle)]">
            Not run, and not charged for
          </p>
          <ul className="mt-1 space-y-0.5">
            {plan.unavailable.map(({ target, reason }) => (
              <li key={targetLabel(target)} className="text-[11px] text-[var(--text-muted)]">
                {targetLabel(target)} — {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
