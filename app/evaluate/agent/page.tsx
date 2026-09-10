"use client";

/**
 * Voice-agent evaluation: where a turn's time actually goes.
 *
 * Built from recorded calls, so opening this page costs nothing. The stacked
 * bar is part-to-whole — the question is which leg dominates a turn, and a
 * stack answers that directly while still showing the total.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

type Agent = {
  agentId: string;
  agentName: string;
  calls: number;
  turns: number;
  /** Means, so the legs sum to the total. */
  breakdown: {
    stt: number | null;
    llm: number | null;
    tool: number | null;
    tts: number | null;
    total: number | null;
  };
  medianTotal: number | null;
  p95Total: number | null;
};

/* One hue per leg: these are four distinct things, not four magnitudes of one
   thing, so identity is the colour's job here. Four is the point at which
   direct labels stop being optional, hence the legend plus the per-leg table. */
const LEGS = [
  { key: "stt", label: "Speech to text", color: "var(--brand)" },
  { key: "llm", label: "Model", color: "#0ea5e9" },
  { key: "tool", label: "Tools", color: "#f59e0b" },
  { key: "tts", label: "Text to speech", color: "#8b5cf6" },
] as const;

export default function AgentEvalPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/eval/agent")
      .then((r) => r.json())
      .then((d) => {
        setAgents(d.agents ?? []);
        setNote(d.note ?? null);
      })
      .catch(() => setNote("Could not load call history."))
      .finally(() => setLoading(false));
  }, []);

  const slowest = Math.max(1, ...agents.map((a) => a.breakdown.total ?? 0));

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Voice agent</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Where a turn&rsquo;s time goes, measured from calls already placed.
          Reading this page makes no API calls.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        <Link
          href="/evaluate"
          className="cursor-pointer rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-xs text-[var(--text-muted)] transition hover:bg-[var(--surface-muted)]"
        >
          Components
        </Link>
        <span className="rounded-lg border border-[var(--brand)] bg-[var(--brand-soft)] px-3 py-1.5 text-xs text-[var(--brand)]">
          Voice agent
        </span>
      </div>

      {loading ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-8 text-center text-sm text-[var(--text-muted)]">
          Loading…
        </p>
      ) : note ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-8 text-center text-sm text-[var(--text-muted)]">
          {note}
        </p>
      ) : (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-white p-5">
            <div className="mb-4 flex flex-wrap items-center gap-4">
              {LEGS.map((leg) => (
                <span
                  key={leg.key}
                  className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: leg.color }}
                  />
                  {leg.label}
                </span>
              ))}
            </div>

            <div className="space-y-4">
              {agents.map((agent) => (
                <div key={agent.agentId}>
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-medium">{agent.agentName}</span>
                    <span className="text-[11px] text-[var(--text-subtle)]">
                      {agent.medianTotal} ms median · {agent.p95Total} ms p95 ·{" "}
                      {agent.turns} turns over {agent.calls}{" "}
                      {agent.calls === 1 ? "call" : "calls"}
                    </span>
                  </div>

                  {/* Stacked: the legs sum to the turn, and a 2px surface gap
                      keeps touching segments legible. */}
                  <div className="flex h-3 gap-[2px]">
                    {LEGS.map((leg) => {
                      const ms = agent.breakdown[leg.key] ?? 0;
                      if (ms === 0) return null;

                      return (
                        <span
                          key={leg.key}
                          title={`${leg.label}: ${ms} ms`}
                          className="h-full first:rounded-l-[4px] last:rounded-r-[4px]"
                          style={{
                            width: `${(ms / slowest) * 100}%`,
                            backgroundColor: leg.color,
                          }}
                        />
                      );
                    })}
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-3">
                    {LEGS.map((leg) => (
                      <span
                        key={leg.key}
                        className="text-[11px] tabular-nums text-[var(--text-subtle)]"
                      >
                        {leg.label} {agent.breakdown[leg.key] ?? 0} ms
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p className="mt-3 text-[11px] text-[var(--text-subtle)]">
            Bars show the mean time in each leg, which is what makes them sum
            to the whole turn — leg medians come from different turns and would
            not add up. The median and p95 beside each name describe the whole
            turn: the typical one, and the slow one a caller actually notices.
          </p>
        </>
      )}
    </div>
  );
}
