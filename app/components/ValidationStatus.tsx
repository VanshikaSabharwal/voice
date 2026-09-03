"use client";

import type { Finding, Section } from "../lib/validate";

/**
 * Configuration Status summary. Lists every finding, errors first, with
 * one-click fixes and a jump-to-section affordance.
 */
export default function ValidationStatus({
  findings,
  onJump,
  onApplyFix,
  probeRan,
}: {
  findings: Finding[];
  onJump: (section: Section) => void;
  onApplyFix: (fix: NonNullable<Finding["fix"]>) => void;
  probeRan: boolean;
}) {
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");

  const headline =
    errors.length > 0
      ? `${errors.length} error${errors.length > 1 ? "s" : ""} block saving`
      : warnings.length > 0
        ? `${warnings.length} warning${warnings.length > 1 ? "s" : ""}`
        : "Configuration is valid";

  const tone =
    errors.length > 0
      ? "border-[var(--danger)]/30 bg-[var(--danger-soft)]/40"
      : warnings.length > 0
        ? "border-[var(--warning)]/30 bg-[var(--warning-soft)]/40"
        : "border-[var(--success)]/30 bg-[var(--success-soft)]/40";

  return (
    <section className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden="true">
            {errors.length > 0 ? "✕" : warnings.length > 0 ? "⚠" : "✓"}
          </span>
          {headline}
        </h2>
        {findings.length === 0 && (
          <span className="text-[11px] text-[var(--text-muted)]">
            {probeRan ? "Checked with live connection test" : "Static checks only"}
          </span>
        )}
      </div>

      {findings.length > 0 && (
        <ul className="mt-3 space-y-2">
          {[...errors, ...warnings].map((f, i) => (
            <li
              key={`${f.id}-${i}`}
              className="flex flex-wrap items-start gap-2 rounded-lg bg-white/70 px-3 py-2"
            >
              <span
                className={`mt-0.5 text-[11px] ${
                  f.severity === "error"
                    ? "text-[var(--danger)]"
                    : "text-[var(--warning)]"
                }`}
                aria-hidden="true"
              >
                {f.severity === "error" ? "✕" : "⚠"}
              </span>

              <span className="min-w-0 flex-1 text-xs leading-relaxed">
                {f.message}
              </span>

              <span className="flex shrink-0 items-center gap-2">
                {f.fix && (
                  <button
                    onClick={() => onApplyFix(f.fix!)}
                    className="rounded-md border border-[var(--brand)] px-2 py-1 text-[11px] font-medium text-[var(--brand)] transition hover:bg-[var(--brand-soft)]"
                  >
                    {f.fix.label}
                  </button>
                )}
                <button
                  onClick={() => onJump(f.section)}
                  className="text-[11px] font-medium text-[var(--text-muted)] underline-offset-2 hover:underline"
                >
                  View
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {!probeRan && findings.length > 0 && (
        <p className="mt-3 text-[11px] text-[var(--text-muted)]">
          Credential and quota checks have not run. Use Test Connection in the
          sidebar to include them.
        </p>
      )}
    </section>
  );
}
