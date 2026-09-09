/**
 * Per-call latency statistics.
 *
 * Median tells you how the call usually felt; p95 tells you how bad the worst
 * turns were, and on a phone call that is the number that decides whether the
 * caller thought the line had dropped. A platform can lead on median and still
 * produce a two-second pause every few turns, which is what people actually
 * remember — so both are reported, never just the average.
 *
 * The mean is deliberately absent. One 8-second turn drags it far enough to
 * misrepresent every other turn in the call.
 */

/**
 * The subset of a turn this module needs.
 *
 * Declared structurally rather than imported from session.ts so the browser
 * can compute the same statistics: importing the session type would drag the
 * whole engine into the client bundle for the sake of four optional numbers.
 * TurnRecord satisfies this shape.
 */
type TimedTurn = {
  role: "user" | "assistant";
  sttMs?: number;
  llmMs?: number;
  toolMs?: number;
  ttsMs?: number;
};

/** Silence past which a caller starts to assume the call has dropped. */
export const DROPPED_CALL_MS = 2000;

export type StageStats = {
  count: number;
  median: number;
  p95: number;
  min: number;
  max: number;
};

export type CallStats = {
  /** Assistant turns that carried timings. */
  turns: number;
  stt?: StageStats;
  llm?: StageStats;
  /** Tool/RAG retrieval time. Absent when no turn called a tool. */
  tool?: StageStats;
  tts?: StageStats;
  /** STT + LLM + TTS per turn: what the caller actually waited through. */
  turnTotal?: StageStats;
  /** Turns whose total crossed DROPPED_CALL_MS. */
  slowTurns: number;
};

/**
 * Nearest-rank percentile.
 *
 * With the handful of turns a phone call produces, interpolating between
 * neighbours invents precision that is not there. Nearest-rank returns a value
 * that actually occurred, which is easier to reason about: "p95 = 2143ms"
 * means some real turn took 2143ms.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;

  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

function summarize(values: number[]): StageStats | undefined {
  if (values.length === 0) return undefined;

  const sorted = [...values].sort((a, b) => a - b);

  return {
    count: sorted.length,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * Compute stats over a call's turns.
 *
 * Only assistant turns carry timings, and an interrupted turn is included:
 * the caller waited through that latency whether or not they let the reply
 * finish, so excluding it would flatter the numbers.
 */
export function callStats(turns: TimedTurn[]): CallStats {
  const stt: number[] = [];
  const llm: number[] = [];
  const tool: number[] = [];
  const tts: number[] = [];
  const totals: number[] = [];

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;

    // A turn with no timings at all is a greeting or a fallback line, not a
    // measured round trip.
    if (turn.sttMs === undefined && turn.llmMs === undefined && turn.ttsMs === undefined) {
      continue;
    }

    if (turn.sttMs !== undefined) stt.push(turn.sttMs);
    if (turn.llmMs !== undefined) llm.push(turn.llmMs);
    // Only turns that actually called a tool; averaging in zeros for the rest
    // would understate how slow retrieval is when it does run.
    if (turn.toolMs !== undefined) tool.push(turn.toolMs);
    if (turn.ttsMs !== undefined) tts.push(turn.ttsMs);

    totals.push(
      (turn.sttMs ?? 0) + (turn.llmMs ?? 0) + (turn.toolMs ?? 0) + (turn.ttsMs ?? 0),
    );
  }

  return {
    turns: totals.length,
    stt: summarize(stt),
    llm: summarize(llm),
    tool: summarize(tool),
    tts: summarize(tts),
    turnTotal: summarize(totals),
    slowTurns: totals.filter((t) => t >= DROPPED_CALL_MS).length,
  };
}

/** One aligned row, or null when a stage was never measured. */
function row(label: string, s: StageStats | undefined): string | null {
  if (!s) return null;

  return (
    `    ${label.padEnd(6)}` +
    ` median ${String(s.median).padStart(5)}ms` +
    `   p95 ${String(s.p95).padStart(5)}ms` +
    `   range ${s.min}-${s.max}ms` +
    `   n=${s.count}`
  );
}

/**
 * Render stats for the server log, printed when a call ends.
 *
 * Returns an empty string for a call with no measured turns — a caller who
 * hung up during the greeting should not produce a block of zeroes.
 */
export function formatCallStats(stats: CallStats): string {
  if (stats.turns === 0) return "";

  const lines = [
    row("stt", stats.stt),
    row("llm", stats.llm),
    row("tool", stats.tool),
    row("tts", stats.tts),
    row("turn", stats.turnTotal),
  ].filter((l): l is string => l !== null);

  if (stats.slowTurns > 0) {
    lines.push(
      `    ${stats.slowTurns} of ${stats.turns} turn(s) over ${DROPPED_CALL_MS}ms` +
        ` — long enough for a caller to think the line dropped`,
    );
  }

  return lines.join("\n");
}
