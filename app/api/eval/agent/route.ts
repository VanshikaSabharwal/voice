/**
 * Voice-agent evaluation: end-to-end turn latency, broken down by leg.
 *
 * Reads the call history the engine already recorded rather than placing new
 * calls, so this endpoint costs nothing. Every turn a real call produced
 * carries sttMs / llmMs / toolMs / ttsMs (see TurnRecord), which is exactly
 * the breakdown needed — measuring it again would mean paying to learn what
 * was already written down.
 */

import { listCalls } from "../../../../lib/store/calls";

export const dynamic = "force-dynamic";

/** Median, so one cold turn does not stand in for the call. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : Math.round(sorted[mid]);
}

/**
 * Mean, used for the per-leg breakdown.
 *
 * Medians do not add up: each leg's median comes from a different turn, so
 * summing them does not reconstruct the median turn. Real data here showed
 * legs medianing to 255 ms against a median turn of 1899 ms — a stacked bar
 * built from those would show segments that visibly fail to fill the bar.
 *
 * Means are additive by construction, so the breakdown sums to the whole.
 * The median and p95 of the TOTAL are reported alongside, since those are the
 * honest summary of what a caller experiences.
 */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;

  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** 95th percentile — the turn a caller remembers is the slow one, not the median. */
function p95(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
}

export async function GET(request: Request) {
  const limit = Math.min(
    200,
    Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 50)),
  );

  const calls = await listCalls(limit);

  const byAgent = new Map<
    string,
    { agentName: string; stt: number[]; llm: number[]; tool: number[]; tts: number[]; total: number[]; turns: number; calls: number }
  >();

  for (const call of calls) {
    const entry = byAgent.get(call.agentId) ?? {
      agentName: call.agentName,
      stt: [],
      llm: [],
      tool: [],
      tts: [],
      total: [],
      turns: 0,
      calls: 0,
    };

    entry.calls++;

    for (const turn of call.turns) {
      /* Only assistant turns carry a full pipeline: a user turn is just the
         transcription, with no model or synthesis behind it. */
      if (turn.role !== "assistant") continue;

      const stt = turn.sttMs ?? 0;
      const llm = turn.llmMs ?? 0;
      const tool = turn.toolMs ?? 0;
      const tts = turn.ttsMs ?? 0;

      // A turn with no timings at all predates the instrumentation; counting
      // it as 0 ms would drag every average toward zero.
      if (stt + llm + tool + tts === 0) continue;

      entry.stt.push(stt);
      entry.llm.push(llm);
      entry.tool.push(tool);
      entry.tts.push(tts);
      entry.total.push(stt + llm + tool + tts);
      entry.turns++;
    }

    byAgent.set(call.agentId, entry);
  }

  const agents = [...byAgent.entries()]
    .filter(([, e]) => e.turns > 0)
    .map(([agentId, e]) => ({
      agentId,
      agentName: e.agentName,
      calls: e.calls,
      turns: e.turns,
      /* Means, so the four legs sum to `breakdown.total` and a stacked bar
         drawn from them is arithmetically honest. */
      breakdown: {
        stt: mean(e.stt),
        llm: mean(e.llm),
        tool: mean(e.tool),
        tts: mean(e.tts),
        total: mean(e.total),
      },
      /* The summary of a whole turn. Median is the typical experience; p95 is
         the one a caller actually complains about. */
      medianTotal: median(e.total),
      p95Total: p95(e.total),
    }))
    .sort((a, b) => (a.medianTotal ?? 0) - (b.medianTotal ?? 0));

  return Response.json({
    agents,
    callsExamined: calls.length,
    note:
      agents.length === 0
        ? "No timed turns yet. Place a call from the playground, then come back — this reads the recorded history rather than making new calls."
        : undefined,
  });
}
