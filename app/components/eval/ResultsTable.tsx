"use client";

/**
 * Results of one evaluation.
 *
 * Latency is the only thing drawn as bars. Quality and cost are different
 * measures on different scales, so plotting them together would mean two
 * y-scales on one figure — which invents a relationship that is not in the
 * data. They stay as columns beside the bar, where they can be read exactly
 * rather than estimated.
 *
 * One measure, one series: a sequential fill (more-is-darker within a single
 * hue) rather than a colour per provider, because the reader's job here is to
 * compare magnitude, not to tell entities apart.
 */

import type { EvalRun, TargetResult } from "../../../lib/eval/types";
import { targetLabel } from "../../../lib/eval/types";

/** Bars grow from a common baseline, so the scale is the slowest result. */
function scaleMax(results: TargetResult[]): number {
  const values = results
    .map((r) => r.medianMs)
    .filter((v): v is number => v !== null);

  return values.length > 0 ? Math.max(...values) : 1;
}

function fastest(results: TargetResult[]): number | null {
  const values = results
    .map((r) => r.medianMs)
    .filter((v): v is number => v !== null);

  return values.length > 0 ? Math.min(...values) : null;
}

export default function ResultsTable({ run }: { run: EvalRun }) {
  const max = scaleMax(run.results);
  const best = fastest(run.results);

  // Fastest first; unusable targets sink to the bottom rather than sorting as 0.
  const ordered = [...run.results].sort((a, b) => {
    if (a.medianMs === null) return 1;
    if (b.medianMs === null) return -1;
    return a.medianMs - b.medianMs;
  });

  const isTts = run.modality === "tts";
  const showQuality = run.modality !== "llm";

  return (
    <div className="rounded-xl border border-[var(--border)] bg-white p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Results</h2>
          <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
            Median of {run.runsPerTarget}{" "}
            {run.runsPerTarget === 1 ? "run" : "runs"} ·{" "}
            {isTts ? "time to first audio" : "round-trip latency"}
          </p>
        </div>

        {run.finishedAt && (
          <span className="text-[11px] text-[var(--text-subtle)]">
            took {Math.round((run.finishedAt - run.startedAt) / 1000)}s
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left">
              <th className="pb-2 pr-3 text-[11px] font-medium text-[var(--text-subtle)]">
                Provider
              </th>
              <th className="pb-2 pr-3 text-[11px] font-medium text-[var(--text-subtle)]">
                {isTts ? "First audio" : "Latency"}
              </th>
              {showQuality && (
                <th className="pb-2 pr-3 text-right text-[11px] font-medium text-[var(--text-subtle)]">
                  Accuracy
                </th>
              )}
              <th className="pb-2 text-right text-[11px] font-medium text-[var(--text-subtle)]">
                Cost
              </th>
            </tr>
          </thead>

          <tbody>
            {ordered.map((result) => {
              const ms = isTts ? result.medianFirstByteMs : result.medianMs;
              const width = ms === null ? 0 : Math.max(2, (ms / max) * 100);

              /* One hue, darker for slower: the fastest row is the lightest,
                 so scanning for "shortest and palest" gives the same answer
                 twice rather than needing a legend. */
              const intensity = ms === null ? 0 : 0.35 + (ms / max) * 0.55;

              return (
                <tr
                  key={targetLabel(result.target)}
                  className="border-b border-[var(--border)] last:border-0"
                >
                  <td className="py-2.5 pr-3 align-middle">
                    <span className="block text-xs font-medium">
                      {result.target.provider}
                    </span>
                    <span className="block text-[11px] text-[var(--text-subtle)]">
                      {result.target.model}
                    </span>
                  </td>

                  <td className="py-2.5 pr-3 align-middle">
                    {result.skipped ? (
                      <span className="text-[11px] text-[var(--warning)]">
                        {result.skipped}
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        {/* Bar: capped thickness, rounded data-end, square at
                            the baseline it grows from. */}
                        <span
                          className="h-2.5 shrink-0 rounded-r-[4px]"
                          style={{
                            width: `${width}%`,
                            minWidth: 4,
                            backgroundColor: `color-mix(in oklab, var(--brand) ${Math.round(intensity * 100)}%, var(--surface-muted))`,
                          }}
                          aria-hidden="true"
                        />
                        <span className="shrink-0 text-xs tabular-nums">
                          {ms} ms
                        </span>
                        {ms !== null && ms === best && (
                          <span className="shrink-0 rounded bg-[var(--success-soft)] px-1.5 py-px text-[10px] font-medium text-[var(--success)]">
                            fastest
                          </span>
                        )}
                      </span>
                    )}
                  </td>

                  {showQuality && (
                    <td className="py-2.5 pr-3 text-right align-middle">
                      {result.wer ? (
                        <span
                          className="text-xs tabular-nums"
                          title={`${result.wer.substitutions} wrong, ${result.wer.deletions} missed, ${result.wer.insertions} extra`}
                        >
                          {result.wer.accuracy}%
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--text-subtle)]">—</span>
                      )}
                    </td>
                  )}

                  <td className="py-2.5 text-right align-middle">
                    {result.costUsd === null ? (
                      // Never $0.00 for an unknown rate: a confident zero is
                      // the one reading that would actively mislead.
                      <span
                        className="text-xs text-[var(--text-subtle)]"
                        title="No price on file for this provider"
                      >
                        —
                      </span>
                    ) : (
                      <span className="text-xs tabular-nums">
                        ${result.costUsd.toFixed(4)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* What each provider actually returned. For STT this is the whole
          point — a number cannot show you that a model heard "cat" for "fox". */}
      {showQuality && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[11px] font-medium text-[var(--text-muted)]">
            What each one heard
          </summary>

          <div className="mt-2 space-y-2">
            <p className="rounded-lg bg-[var(--surface-muted)] p-2 text-[11px]">
              <span className="font-medium">Reference:</span> {run.testCase.text}
            </p>

            {ordered
              .filter((r) => r.samples.some((s) => s.output))
              .map((r) => (
                <p key={targetLabel(r.target)} className="text-[11px]">
                  <span className="font-medium">{r.target.provider}:</span>{" "}
                  <span className="text-[var(--text-muted)]">
                    {r.samples.find((s) => s.output)?.output}
                  </span>
                </p>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}
