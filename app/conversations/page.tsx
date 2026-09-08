"use client";

/**
 * Past calls and their transcripts.
 *
 * This is the primary tool for judging whether the agent is any good — without
 * it, evaluating a conversation means reading server logs. The per-stage
 * timings matter as much as the words: on a phone call, latency is a feature.
 */

import { useCallback, useEffect, useState } from "react";

type Turn = {
  role: "user" | "assistant";
  text: string;
  at: number;
  interrupted?: boolean;
  toolsUsed?: string[];
  sttMs?: number;
  llmMs?: number;
  ttsMs?: number;
};

type Call = {
  id: string;
  direction: "inbound" | "outbound";
  transport: string;
  agentName: string;
  to?: string;
  startedAt: number;
  endedAt?: number;
  status: "active" | "completed" | "failed";
  turns: Turn[];
  error?: string;
};

function duration(call: Call): string {
  if (!call.endedAt) return "in progress";

  const seconds = Math.round((call.endedAt - call.startedAt) / 1000);

  if (seconds < 60) return `${seconds}s`;

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ConversationsPage() {
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/calls?limit=50", { cache: "no-store" });
      const data = await res.json();

      setCalls(Array.isArray(data.calls) ? data.calls : []);
      setError(data.error ?? null);
    } catch {
      setCalls([]);
      setError("Could not load calls.");
    }
  }, []);

  // Fetch on mount, and whenever the tab is returned to — a call placed in
  // another tab should show up without a manual refresh.
  useEffect(() => {
    const controller = new AbortController();

    const run = (): void => {
      if (!controller.signal.aborted) void load();
    };

    run();
    window.addEventListener("focus", run);

    return () => {
      controller.abort();
      window.removeEventListener("focus", run);
    };
  }, [load]);

  const loading = calls === null;
  const rows = calls ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[var(--border)] bg-white px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold">Conversations</h1>
            <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
              Past voice calls and their transcripts
            </p>
          </div>

          <button
            onClick={() => void load()}
            className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-muted)] transition hover:bg-[var(--surface-muted)]"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-3">
          {error && (
            <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]">
              {error}
            </p>
          )}

          {loading && (
            <p className="py-8 text-center text-[11px] text-[var(--text-subtle)]">
              Loading…
            </p>
          )}

          {!loading && rows.length === 0 && !error && (
            <p className="py-8 text-center text-[11px] text-[var(--text-subtle)]">
              No calls yet. Place one from Call Test.
            </p>
          )}

          {rows.map((call) => {
            const expanded = open === call.id;

            return (
              <section
                key={call.id}
                className="overflow-hidden rounded-xl border border-[var(--border)] bg-white"
              >
                <button
                  onClick={() => setOpen(expanded ? null : call.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-[var(--surface-muted)]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">
                      {call.agentName}
                      <span className="ml-2 font-normal text-[var(--text-subtle)]">
                        {call.direction}
                        {call.to ? ` → ${call.to}` : ""}
                      </span>
                    </p>
                    <p className="mt-0.5 text-[10px] text-[var(--text-subtle)]">
                      {when(call.startedAt)} · {duration(call)} ·{" "}
                      {call.turns.length} turns
                    </p>
                  </div>

                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                      call.status === "failed"
                        ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                        : call.status === "active"
                          ? "bg-[var(--brand-soft)] text-[var(--brand)]"
                          : "bg-[var(--surface-muted)] text-[var(--text-muted)]"
                    }`}
                  >
                    {call.status}
                  </span>
                </button>

                {expanded && (
                  <div className="space-y-2 border-t border-[var(--border)] px-4 py-3">
                    {call.error && (
                      <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[10px] text-[var(--danger)]">
                        {call.error}
                      </p>
                    )}

                    {call.turns.length === 0 && (
                      <p className="py-4 text-center text-[11px] text-[var(--text-subtle)]">
                        Nothing was said on this call.
                      </p>
                    )}

                    {call.turns.map((turn, i) => (
                      <div
                        key={i}
                        className={`rounded-xl px-3 py-2 text-xs ${
                          turn.role === "user"
                            ? "ml-auto max-w-[85%] bg-[var(--brand)] text-white"
                            : "mr-auto max-w-[85%] border border-[var(--border)]"
                        }`}
                      >
                        <p>{turn.text}</p>

                        {(turn.interrupted ||
                          turn.toolsUsed?.length ||
                          turn.sttMs ||
                          turn.llmMs ||
                          turn.ttsMs) && (
                          <p
                            className={`mt-1 text-[10px] ${
                              turn.role === "user"
                                ? "text-white/70"
                                : "text-[var(--text-subtle)]"
                            }`}
                          >
                            {turn.interrupted && "interrupted · "}
                            {turn.toolsUsed?.length
                              ? `${turn.toolsUsed.join(", ")} · `
                              : ""}
                            {turn.sttMs ? `stt ${turn.sttMs}ms ` : ""}
                            {turn.llmMs ? `llm ${turn.llmMs}ms ` : ""}
                            {turn.ttsMs ? `tts ${turn.ttsMs}ms` : ""}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
