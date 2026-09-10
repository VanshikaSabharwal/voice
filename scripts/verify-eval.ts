/**
 * Evaluation runner checks, against a FAKE provider layer.
 *
 * Run: npm run verify:eval
 *
 * The runner takes its three billed calls as an injected dependency, so this
 * passes stand-ins and exercises the real scheduling, timing, aggregation and
 * cost logic without making a single billed request.
 *
 * What it cannot check is whether the live providers behave as their adapters
 * expect — only a real run shows that, and a real run costs money, so it stays
 * a deliberate choice.
 */

import { loadEnv } from "../lib/env";

loadEnv();

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;

  if (!ok) failures++;

  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${g}\n        want ${w}`}`,
  );
}

import { execute, type Providers } from "../lib/eval/run";
import { planRun } from "../lib/eval/plan";

/* Fake latencies, distinct per provider so the median arithmetic can be
   checked against known numbers. */
const LATENCY: Record<string, number> = { sarvam: 30, gemini: 60, bodhan: 90 };

let sttCalls = 0;
let ttsCalls = 0;
let llmCalls = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stand-ins for the three billed calls. */
let stub: Providers = {
  transcribe: async (input) => {
    sttCalls++;
    await sleep(LATENCY[input.provider] ?? 40);
    // One word wrong, to give WER something non-zero to report.
    return "the quick brown cat jumps over the lazy dog";
  },

  speak: (cfg) => {
    ttsCalls++;
    return (async function* () {
      await sleep(LATENCY[cfg.tts.provider] ?? 40);
      // 400 frames ~ half a second of 8 kHz mu-law.
      for (let i = 0; i < 400; i++) yield new Uint8Array(160).fill(0xff);
    })();
  },

  runAgent: async (cfg) => {
    llmCalls++;
    await sleep(LATENCY[cfg.llm.provider] ?? 40);
    return { text: "A reply.", toolsUsed: [], toolMs: 0 };
  },
};

const REFERENCE = "the quick brown fox jumps over the lazy dog";

const testCase = {
  id: "t1",
  text: REFERENCE,
  language: "en",
  label: "pangram",
};

async function main(): Promise<void> {
  console.log("Evaluation runner (stubbed providers — no cost)\n");

  // --- STT, with a fixture so no synthesis is needed -----------------------
  sttCalls = ttsCalls = llmCalls = 0;

  const sttRun = await execute({
    targets: [
      { modality: "stt", provider: "sarvam", model: "saaras:v3" },
      { modality: "stt", provider: "gemini", model: "gemini-3.5-transcribe" },
    ],
    testCase,
    runsPerTarget: 3,
    providers: stub,
    sttFixture: { wav: Buffer.alloc(44 + 16000), transcript: REFERENCE },
  });

  check("stt: one result per target", sttRun.results.length, 2);
  check("stt: 2 targets x 3 runs = 6 calls", sttCalls, 6);
  check("stt: fixture means no synthesis", ttsCalls, 0);
  check("stt: all attempts succeeded", sttRun.results.every((r) => r.succeeded === 3), true);
  check(
    "stt: WER scored against the reference",
    sttRun.results[0].wer?.substitutions,
    1,
  );
  check("stt: cost unknown, not zero", sttRun.results[0].costUsd, null);
  check("stt: run is timed", typeof sttRun.finishedAt, "number");

  /* Medians must separate the providers rather than blur them — the whole
     point of the comparison. */
  const sarvam = sttRun.results[0].medianMs ?? 0;
  const gemini = sttRun.results[1].medianMs ?? 0;
  check("stt: faster provider reports lower median", sarvam < gemini, true);

  // --- STT without a fixture must synthesize, once, not per run ------------
  sttCalls = ttsCalls = 0;

  await execute({
    targets: [{ modality: "stt", provider: "sarvam", model: "saaras:v3" }],
    testCase,
    runsPerTarget: 4,
    providers: stub,
  });

  check("stt: synthesis happens once per target", ttsCalls, 1);
  check("stt: transcription happens per run", sttCalls, 4);

  // --- TTS ----------------------------------------------------------------
  sttCalls = ttsCalls = 0;

  const ttsRun = await execute({
    targets: [
      { modality: "tts", provider: "cartesia", model: "sonic-2", voice: "Sophie" },
    ],
    testCase,
    runsPerTarget: 3,
    providers: stub,
  });

  check("tts: synthesized per run", ttsCalls, 3);
  check("tts: round-trip transcribed once, not per run", sttCalls, 1);
  check("tts: time-to-first-audio recorded", ttsRun.results[0].medianFirstByteMs !== null, true);
  check("tts: quality scored via round trip", ttsRun.results[0].wer !== null, true);

  // --- LLM ----------------------------------------------------------------
  llmCalls = 0;

  const llmRun = await execute({
    targets: [{ modality: "llm", provider: "groq", model: "openai/gpt-oss-20b" }],
    testCase,
    runsPerTarget: 2,
    providers: stub,
  });

  check("llm: called per run", llmCalls, 2);
  check("llm: no WER for free-form output", llmRun.results[0].wer, null);

  // --- A provider that fails -----------------------------------------------
  stub = {
    ...stub,
    transcribe: async () => {
      throw new Error("provider exploded");
    },
  };

  const failRun = await execute({
    targets: [{ modality: "stt", provider: "sarvam", model: "saaras:v3" }],
    testCase,
    runsPerTarget: 2,
    providers: stub,
    sttFixture: { wav: Buffer.alloc(44 + 16000), transcript: REFERENCE },
  });

  check("failure: recorded, not thrown", failRun.results.length, 1);
  check("failure: no successes", failRun.results[0].succeeded, 0);
  check("failure: median is null, not 0", failRun.results[0].medianMs, null);
  check("failure: reason surfaced", failRun.results[0].skipped?.includes("exploded"), true);

  // --- A target with no key is skipped before any call ---------------------
  sttCalls = 0;

  const skipRun = await execute({
    targets: [{ modality: "stt", provider: "nonexistent", model: "x" }],
    testCase,
    runsPerTarget: 3,
    providers: stub,
    sttFixture: { wav: Buffer.alloc(44 + 16000), transcript: REFERENCE },
  });

  check("unavailable: attempted nothing", skipRun.results[0].attempted, 0);
  check("unavailable: no provider call made", sttCalls, 0);
  check("unavailable: says why", typeof skipRun.results[0].skipped, "string");

  // --- The plan must agree with what the run actually does -----------------
  const plan = planRun({
    targets: [
      { modality: "tts", provider: "cartesia", model: "sonic-2", voice: "Sophie" },
    ],
    testCase,
    runsPerTarget: 3,
    synthesizeSttInput: false,
  });

  // Planned as worst case (2 calls per run); the run economises the round trip
  // to one. The plan must never UNDERSTATE what will be spent.
  check("plan does not understate the bill", plan.totalCalls >= 3 + 1, true);

  console.log(
    failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

main();
