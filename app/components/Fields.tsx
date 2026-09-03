"use client";

import type { Finding } from "../lib/validate";

/** Inline error/warning messages rendered beneath a field. */
function FindingList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;

  return (
    <span className="mt-1.5 block space-y-1">
      {findings.map((f, i) => (
        <span
          key={`${f.id}-${i}`}
          className={`flex items-start gap-1.5 text-[11px] leading-snug ${
            f.severity === "error"
              ? "text-[var(--danger)]"
              : "text-[var(--warning)]"
          }`}
        >
          <span aria-hidden="true">{f.severity === "error" ? "✕" : "⚠"}</span>
          <span>{f.message}</span>
        </span>
      ))}
    </span>
  );
}

export function Field({
  label,
  children,
  className = "",
  findings = [],
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  findings?: Finding[];
}) {
  return (
    <label className={`block ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      <FindingList findings={findings} />
    </label>
  );
}

export function Select({
  value,
  onChange,
  options,
  invalidValues,
  disabledValues,
  status,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** Marked with a warning glyph but still selectable. */
  invalidValues?: Set<string>;
  /** Rendered unselectable. */
  disabledValues?: Set<string>;
  status?: "error" | "warning";
}) {
  const ring =
    status === "error"
      ? " border-[var(--danger)] ring-1 ring-[var(--danger)]/20"
      : status === "warning"
        ? " border-[var(--warning)] ring-1 ring-[var(--warning)]/20"
        : "";

  return (
    <select
      className={`field-select${ring}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => {
        const disabled = disabledValues?.has(o.value) ?? false;
        const invalid = invalidValues?.has(o.value) ?? false;
        // Incompatible options stay visible and marked rather than being
        // filtered out, so users can see why a choice is discouraged.
        const prefix = disabled ? "✕ " : invalid ? "⚠ " : "";
        return (
          <option key={o.value} value={o.value} disabled={disabled}>
            {prefix}
            {o.label}
          </option>
        );
      })}
    </select>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string | number;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      className="field-input"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Slider with the min/max/current triple rendered above the track, as in the mockup. */
export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
        <span className="text-xs font-semibold tabular-nums">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <div className="mt-1 flex justify-between text-[10px] text-[var(--text-subtle)]">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

export type SectionCardStatus = "ok" | "warning" | "error" | "unknown";

const STATUS_CHIP: Record<
  SectionCardStatus,
  { cls: string; dot: string; label: string }
> = {
  ok: { cls: "chip-connected", dot: "bg-[var(--success)]", label: "Compatible" },
  warning: { cls: "chip-warning", dot: "bg-[var(--warning)]", label: "Warning" },
  error: { cls: "chip-error", dot: "bg-[var(--danger)]", label: "Error" },
  unknown: { cls: "chip-neutral", dot: "bg-[var(--text-subtle)]", label: "Not checked" },
};

export function SectionCard({
  title,
  icon,
  status,
  statusLabel,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  status?: SectionCardStatus;
  statusLabel?: string;
  children: React.ReactNode;
}) {
  const chip = status ? STATUS_CHIP[status] : null;

  return (
    <section className="card">
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {icon && (
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--brand-soft)] text-[var(--brand)]">
              {icon}
            </span>
          )}
          {title}
        </h2>
        {chip && (
          <span className={chip.cls}>
            <span className={`h-1.5 w-1.5 rounded-full ${chip.dot}`} />
            {statusLabel ?? chip.label}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition
          ${checked ? "bg-[var(--brand)]" : "bg-[var(--border-strong)]"}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform
            ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`}
        />
      </button>
    </div>
  );
}
