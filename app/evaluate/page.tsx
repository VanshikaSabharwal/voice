"use client";

/**
 * Component evaluation: compare providers for one layer at a time.
 *
 * The plan is fetched and shown on every change, and the Run button states
 * how many billed calls it will make. Nothing here starts a provider call
 * without a click on that button.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Modality } from "../lib/capabilities";
import type { EvalRun, RunPlan, Target } from "../../lib/eval/types";
import { targetId } from "../../lib/eval/types";
import ResultsTable from "../components/eval/ResultsTable";
import PlanBanner from "../components/eval/PlanBanner";

type CatalogModel = { id: string; label: string; hasPrice: boolean };

type CatalogProvider = {
  provider: string;
  label: string;
  available: boolean;
  reason?: string;
  models: CatalogModel[];
  voices: { id: string; label: string; modelIds: string[] | null }[];
};

type Catalog = { modality: Modality; providers: CatalogProvider[] }[];

const MODALITIES: { value: Modality; label: string; blurb: string }[] = [
  { value: "stt", label: "Speech to text", blurb: "Accuracy and latency of transcription" },
  { value: "tts", label: "Text to speech", blurb: "Time to first audio, and how intelligible it is" },
  { value: "llm", label: "Language model", blurb: "Response latency" },
];

const DEFAULT_TEXT = "How long do I have to return something I bought?";

export default function EvaluatePage() {
  const [catalog, setCatalog] = useState<Catalog>([]);
  const [modality, setModality] = useState<Modality>("stt");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState(DEFAULT_TEXT);
  const [runsPerTarget, setRunsPerTarget] = useState(3);

  const [plan, setPlan] = useState<RunPlan | null>(null);
  const [pricingNote, setPricingNote] = useState<string | null>(null);
  const [run, setRun] = useState<EvalRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/eval/catalog")
      .then((r) => r.json())
      .then((d) => setCatalog(d.modalities ?? []))
      .catch(() => setError("Could not load the provider catalog."));
  }, []);

  const providers = useMemo(
    () => catalog.find((c) => c.modality === modality)?.providers ?? [],
    [catalog, modality],
  );

  /** Every provider+model pair for the chosen modality. */
  const allTargets = useMemo<Target[]>(
    () =>
      providers.flatMap((p) =>
        p.models.map((m) => ({
          modality,
          provider: p.provider,
          model: m.id,
          voice: modality === "tts" ? p.voices[0]?.id : undefined,
        })),
      ),
    [providers, modality],
  );

  const chosen = useMemo(
    () => allTargets.filter((t) => selected.has(targetId(t))),
    [allTargets, selected],
  );

  const testCase = useMemo(
    () => ({ id: "adhoc", text, language: "en", label: text.slice(0, 60) }),
    [text],
  );

  /* Re-plan whenever the selection changes. Free to ask, and it keeps the
     stated cost in step with what the button would actually do. */
  useEffect(() => {
    let cancelled = false;

    /* Clearing is deferred rather than set synchronously in the effect body:
       a bare setState here cascades a render, and the planner is a fetch
       anyway so one tick costs nothing. */
    if (chosen.length === 0 || !text.trim()) {
      const id = setTimeout(() => {
        if (!cancelled) setPlan(null);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(id);
      };
    }

    fetch("/api/eval/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: chosen,
        testCase,
        runsPerTarget,
        synthesizeSttInput: true,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setPlan(d.plan ?? null);
        setPricingNote(d.pricingNote ?? null);
      })
      .catch(() => {
        if (!cancelled) setPlan(null);
      });

    return () => {
      cancelled = true;
    };
  }, [chosen, testCase, runsPerTarget, text]);

  const toggle = useCallback((target: Target) => {
    setSelected((current) => {
      const next = new Set(current);
      const id = targetId(target);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });
  }, []);

  // Switching layer invalidates the selection: targets are per modality.
  function changeModality(next: Modality) {
    setModality(next);
    setSelected(new Set());
    setRun(null);
  }

  async function start() {
    setRunning(true);
    setError(null);
    setRun(null);

    try {
      const res = await fetch("/api/eval/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets: chosen,
          testCase,
          runsPerTarget,
          // Only ever sent from this button, after the plan above was shown.
          confirm: true,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "The run failed.");
        return;
      }

      setRun(data.run);
      if (data.warning) setError(data.warning);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Evaluate</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Compare providers one layer at a time. Every run makes real,
          billed API calls.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <span className="rounded-lg border border-[var(--brand)] bg-[var(--brand-soft)] px-3 py-1.5 text-xs text-[var(--brand)]">
          Components
        </span>
        <Link
          href="/evaluate/agent"
          className="cursor-pointer rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-xs text-[var(--text-muted)] transition hover:bg-[var(--surface-muted)]"
        >
          Voice agent
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {MODALITIES.map((m) => (
          <button
            key={m.value}
            onClick={() => changeModality(m.value)}
            title={m.blurb}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs transition ${
              modality === m.value
                ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
                : "border-[var(--border-strong)] text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-white p-5">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
            {modality === "stt"
              ? "Utterance to transcribe"
              : modality === "tts"
                ? "Text to speak"
                : "Prompt"}
          </span>
          <textarea
            value={text}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            className="w-full resize-y rounded-lg border border-[var(--border-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
          />
          {modality === "stt" && (
            <span className="mt-1 block text-[11px] text-[var(--text-subtle)]">
              Spoken aloud first, then transcribed back and compared to this
              text. The synthesis is itself a billed call.
            </span>
          )}
        </label>

        <p className="mb-2 mt-4 text-xs font-medium text-[var(--text-muted)]">
          Providers
        </p>

        <div className="space-y-3">
          {providers.map((p) => (
            <div key={p.provider}>
              <p className="mb-1 text-[11px] font-medium text-[var(--text-subtle)]">
                {p.label}
                {!p.available && (
                  <span className="ml-2 text-[var(--warning)]">{p.reason}</span>
                )}
              </p>

              <div className="flex flex-wrap gap-2">
                {p.models.map((m) => {
                  const target: Target = {
                    modality,
                    provider: p.provider,
                    model: m.id,
                    voice: modality === "tts" ? p.voices[0]?.id : undefined,
                  };
                  const on = selected.has(targetId(target));

                  return (
                    <button
                      key={m.id}
                      disabled={!p.available}
                      onClick={() => toggle(target)}
                      className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
                        on
                          ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
                          : "border-[var(--border-strong)] text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                      }`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <label className="mt-4 flex items-center gap-2 text-xs text-[var(--text-muted)]">
          Repetitions
          <input
            type="number"
            min={1}
            max={10}
            value={runsPerTarget}
            onChange={(e) => setRunsPerTarget(Number(e.target.value))}
            className="w-16 rounded-lg border border-[var(--border-strong)] px-2 py-1 text-sm outline-none focus:border-[var(--brand)]"
          />
          <span className="text-[var(--text-subtle)]">
            median of this many, so one cold start does not decide the result
          </span>
        </label>
      </div>

      {plan && (
        <PlanBanner
          plan={plan}
          pricingNote={pricingNote}
          running={running}
          onRun={start}
        />
      )}

      {run && (
        <div className="mt-6">
          <ResultsTable run={run} />
        </div>
      )}

      {!plan && (
        <p className="mt-6 rounded-xl border border-dashed border-[var(--border-strong)] p-8 text-center text-sm text-[var(--text-muted)]">
          Choose one or more providers to see what a run would cost.
        </p>
      )}
    </div>
  );
}
