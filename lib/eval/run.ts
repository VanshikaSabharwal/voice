/**
 * Executing an evaluation.
 *
 * THIS IS THE ONLY MODULE HERE THAT CALLS PROVIDERS, and every call it makes
 * is billed to the operator's own accounts. Nothing in this file runs on its
 * own: `execute` is called from a route handler that a person triggered, after
 * they were shown a plan. There is no polling, no warm-up, and no retry — a
 * retry would double a bill to improve a number nobody asked for.
 *
 * Measurement follows the approach already proven in scripts/verify-latency.ts:
 * repeat a few times and take the median, because one cold start dominates a
 * mean and a single sample is mostly noise.
 */

import { transcribe } from "../agent/stt";
import { runAgent } from "../agent/llm";
import { speak } from "../agent/tts";
import { decodeMulaw, SAMPLE_RATE } from "../audio/mulaw";
import { concatPcm, emitWav } from "../audio/resample";
import { DEFAULT_CONFIG, type AgentConfig } from "../../app/lib/types";
import { computeWer } from "./wer";
import { estimateCost } from "./pricing";
import { availability } from "./plan";
import type { EvalRun, Sample, Target, TestCase } from "./types";

/** One provider call may not exceed this. Keeps a hung request from hanging a run. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * The three provider calls, as an injectable dependency.
 *
 * Passing them in rather than importing them directly draws the billing
 * boundary in one visible place: everything that can charge the operator money
 * enters through this object. It is also what lets the test suite exercise the
 * scheduling, timing and aggregation logic against stubs, which ESM's
 * getter-only exports would otherwise make impossible without a mocking
 * framework.
 */
export type Providers = {
  transcribe: typeof transcribe;
  speak: typeof speak;
  runAgent: typeof runAgent;
};

export const LIVE_PROVIDERS: Providers = { transcribe, speak, runAgent };

function median(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/** Build a config with one layer swapped to the target under test. */
function configFor(target: Target, testCase: TestCase): AgentConfig {
  const cfg: AgentConfig = {
    ...DEFAULT_CONFIG,
    stt: { ...DEFAULT_CONFIG.stt },
    llm: { ...DEFAULT_CONFIG.llm },
    tts: { ...DEFAULT_CONFIG.tts },
  };

  if (target.modality === "stt") {
    cfg.stt = {
      provider: target.provider,
      model: target.model,
      language: testCase.language,
    };
  } else if (target.modality === "llm") {
    cfg.llm = { ...cfg.llm, provider: target.provider, model: target.model };
  } else {
    cfg.tts = {
      ...cfg.tts,
      provider: target.provider,
      model: target.model,
      voice: target.voice ?? cfg.tts.voice,
    };
  }

  return cfg;
}

/** Collect a TTS stream, timing the first chunk separately. */
async function synthesize(
  providers: Providers,
  cfg: AgentConfig,
  text: string,
): Promise<{ wav: Buffer; firstByteMs: number; totalMs: number }> {
  const started = Date.now();
  let firstByteMs = 0;

  const frames: Uint8Array[] = [];

  for await (const frame of providers.speak(
    cfg,
    text,
    AbortSignal.timeout(CALL_TIMEOUT_MS),
  )) {
    // Time to first audio is what a caller actually perceives as latency;
    // total duration is mostly a function of how long the sentence is.
    if (frames.length === 0) firstByteMs = Date.now() - started;
    frames.push(frame);
  }

  return {
    wav: emitWav(concatPcm(frames.map(decodeMulaw)), SAMPLE_RATE),
    firstByteMs,
    totalMs: Date.now() - started,
  };
}

export type ExecuteOptions = {
  targets: Target[];
  testCase: TestCase;
  runsPerTarget: number;
  /**
   * Audio for STT evaluation. When absent, STT targets synthesize their own
   * input, which costs an extra billed TTS call per repetition.
   */
  sttFixture?: { wav: Buffer; transcript: string };
  /** Reports progress so a long run is not a blank screen. */
  onProgress?: (done: number, total: number, label: string) => void;
  /** Defaults to the real, billed providers. Overridden only by tests. */
  providers?: Providers;
};

/** Measure one STT target. */
async function evaluateStt(
  providers: Providers,
  target: Target,
  testCase: TestCase,
  runs: number,
  fixture: { wav: Buffer; transcript: string } | undefined,
  cfg: AgentConfig,
): Promise<{ samples: Sample[]; audioSeconds: number }> {
  const samples: Sample[] = [];

  /* Synthesize once and reuse it across repetitions rather than per run: the
     recogniser is what is being measured, and re-synthesizing identical audio
     would bill a TTS call per repetition to no benefit. */
  let audio = fixture?.wav;
  let audioSeconds = 0;

  if (!audio) {
    const spoken = await synthesize(providers, cfg, testCase.text);
    audio = spoken.wav;
  }

  // 16-bit mono PCM at SAMPLE_RATE, minus a 44-byte WAV header.
  audioSeconds = Math.max(0, (audio.length - 44) / 2 / SAMPLE_RATE);

  for (let i = 0; i < runs; i++) {
    const started = Date.now();

    try {
      const text = await providers.transcribe({
        bytes: audio,
        mimeType: "audio/wav",
        filename: "utterance.wav",
        provider: target.provider,
        model: target.model,
        language: testCase.language,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });

      samples.push({ ms: Date.now() - started, output: text });
    } catch (err) {
      samples.push({
        ms: 0,
        error: err instanceof Error ? err.message.slice(0, 200) : "failed",
      });
    }
  }

  return { samples, audioSeconds };
}

/** Measure one TTS target, scoring quality by transcribing the audio back. */
async function evaluateTts(
  providers: Providers,
  target: Target,
  testCase: TestCase,
  runs: number,
  cfg: AgentConfig,
  scoreQuality: boolean,
): Promise<{ samples: Sample[] }> {
  const samples: Sample[] = [];

  for (let i = 0; i < runs; i++) {
    try {
      const spoken = await synthesize(providers, cfg, testCase.text);

      /* Round-trip scoring only on the first repetition. The audio is
         identical each time, so transcribing every one would bill an STT call
         per repetition for a number that cannot change. */
      let output: string | undefined;

      if (scoreQuality && i === 0) {
        output = await providers.transcribe({
          bytes: spoken.wav,
          mimeType: "audio/wav",
          filename: "spoken.wav",
          provider: DEFAULT_CONFIG.stt.provider,
          model: DEFAULT_CONFIG.stt.model,
          language: testCase.language,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
      }

      samples.push({
        ms: spoken.totalMs,
        firstByteMs: spoken.firstByteMs,
        output,
      });
    } catch (err) {
      samples.push({
        ms: 0,
        error: err instanceof Error ? err.message.slice(0, 200) : "failed",
      });
    }
  }

  return { samples };
}

/** Measure one LLM target. */
async function evaluateLlm(
  providers: Providers,
  testCase: TestCase,
  runs: number,
  cfg: AgentConfig,
): Promise<{ samples: Sample[] }> {
  const samples: Sample[] = [];

  for (let i = 0; i < runs; i++) {
    const started = Date.now();

    try {
      const result = await providers.runAgent(
        cfg,
        [{ role: "user", content: testCase.text }],
        AbortSignal.timeout(CALL_TIMEOUT_MS),
      );

      samples.push({ ms: Date.now() - started, output: result.text });
    } catch (err) {
      samples.push({
        ms: 0,
        error: err instanceof Error ? err.message.slice(0, 200) : "failed",
      });
    }
  }

  return { samples };
}

/**
 * Run an evaluation. Every call this makes is billed.
 *
 * Individual target failures are captured rather than thrown, so one dead
 * provider does not discard the measurements already paid for.
 */
export async function execute(options: ExecuteOptions): Promise<EvalRun> {
  const { targets, testCase, runsPerTarget } = options;
  const providers = options.providers ?? LIVE_PROVIDERS;

  const run: EvalRun = {
    id: crypto.randomUUID(),
    label: testCase.label,
    modality: targets[0]?.modality ?? "stt",
    testCase,
    runsPerTarget,
    startedAt: Date.now(),
    results: [],
  };

  let done = 0;

  for (const target of targets) {
    const label = `${target.provider}/${target.model}`;
    options.onProgress?.(done, targets.length, label);

    const check = availability(target);

    if (!check.ok) {
      run.results.push({
        target,
        samples: [],
        medianMs: null,
        medianFirstByteMs: null,
        succeeded: 0,
        attempted: 0,
        wer: null,
        costUsd: null,
        skipped: check.reason,
      });
      done++;
      continue;
    }

    const cfg = configFor(target, testCase);

    let samples: Sample[] = [];
    let audioSeconds = 0;
    let failure: string | undefined;

    try {
      if (target.modality === "stt") {
        const out = await evaluateStt(
          providers,
          target,
          testCase,
          runsPerTarget,
          options.sttFixture,
          cfg,
        );
        samples = out.samples;
        audioSeconds = out.audioSeconds;
      } else if (target.modality === "tts") {
        samples = (
          await evaluateTts(providers, target, testCase, runsPerTarget, cfg, true)
        ).samples;
      } else {
        samples = (await evaluateLlm(providers, testCase, runsPerTarget, cfg))
          .samples;
      }
    } catch (err) {
      // Thrown before any sample — synthesis for an STT target, usually.
      failure = err instanceof Error ? err.message.slice(0, 200) : "failed";
    }

    const ok = samples.filter((s) => !s.error);

    /* Quality is scored against the reference text for STT, and for TTS
       against what the round-trip transcription heard. LLM output has no
       single correct answer, so it carries no WER. */
    const reference =
      target.modality === "stt"
        ? (options.sttFixture?.transcript ?? testCase.text)
        : testCase.text;

    const hypothesis = ok.find((s) => s.output)?.output;

    const wer =
      target.modality !== "llm" && hypothesis !== undefined
        ? computeWer(reference, hypothesis)
        : null;

    const cost = estimateCost(
      target.modality,
      target.provider,
      target.model,
      target.modality === "stt"
        ? { audioSeconds }
        : target.modality === "tts"
          ? { characters: testCase.text.length }
          : {
              inputTokens: Math.ceil(testCase.text.length / 4),
              outputTokens: Math.ceil((hypothesis?.length ?? 0) / 4),
            },
    );

    run.results.push({
      target,
      samples,
      medianMs: median(ok.map((s) => s.ms)),
      medianFirstByteMs: median(
        ok.filter((s) => s.firstByteMs !== undefined).map((s) => s.firstByteMs!),
      ),
      succeeded: ok.length,
      attempted: samples.length,
      wer,
      // Multiplied by repetitions: the run paid for each one.
      costUsd: cost ? cost.usd * runsPerTarget : null,
      costBasis: cost?.basis,
      skipped:
        failure ??
        (samples.length > 0 && ok.length === 0
          ? (samples[0].error ?? "every attempt failed")
          : undefined),
    });

    done++;
    options.onProgress?.(done, targets.length, label);
  }

  run.finishedAt = Date.now();
  return run;
}
