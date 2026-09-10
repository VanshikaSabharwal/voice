/**
 * Shapes for the evaluation platform.
 *
 * A "run" is one user-triggered evaluation: a set of targets (provider+model
 * pairs) measured against a test case, repeated a few times. Every provider
 * call belongs to a run, so nothing bills without a run behind it.
 */

import type { Modality } from "../../app/lib/capabilities";
import type { WerResult } from "./wer";

/** One provider+model combination under test. */
export type Target = {
  modality: Modality;
  provider: string;
  model: string;
  /** TTS only. */
  voice?: string;
};

export function targetId(target: Target): string {
  return [target.modality, target.provider, target.model, target.voice]
    .filter(Boolean)
    .join(":");
}

export function targetLabel(target: Target): string {
  return target.voice
    ? `${target.provider} / ${target.model} / ${target.voice}`
    : `${target.provider} / ${target.model}`;
}

/** Input for one measurement. */
export type TestCase = {
  id: string;
  /** What is spoken or asked. For STT this is also the WER reference. */
  text: string;
  language: string;
  label: string;
};

/** One timed attempt against one target. */
export type Sample = {
  /** Wall-clock milliseconds. 0 when the attempt failed. */
  ms: number;
  /** TTS only: milliseconds until the first audio chunk arrived. */
  firstByteMs?: number;
  /** What the provider returned, when it is text. */
  output?: string;
  /** Present when the attempt failed; `ms` is meaningless then. */
  error?: string;
};

export type TargetResult = {
  target: Target;
  samples: Sample[];
  /** Median of successful samples, in milliseconds. */
  medianMs: number | null;
  /** Median time to first audio, TTS only. */
  medianFirstByteMs: number | null;
  /** How many attempts succeeded. */
  succeeded: number;
  attempted: number;
  /** STT and TTS round-trip only. */
  wer: WerResult | null;
  /** Null when the rate is unknown; never zero as a stand-in. */
  costUsd: number | null;
  costBasis?: string;
  /** Set when every attempt failed, or the target was skipped outright. */
  skipped?: string;
};

export type EvalRun = {
  id: string;
  label: string;
  modality: Modality;
  testCase: TestCase;
  runsPerTarget: number;
  startedAt: number;
  finishedAt?: number;
  results: TargetResult[];
  /** Set if the run itself failed rather than an individual target. */
  error?: string;
};

/**
 * What a run will do before it does it.
 *
 * Shown to the user for confirmation, because every one of these is a billed
 * request against their own provider accounts.
 */
export type RunPlan = {
  targets: Target[];
  runsPerTarget: number;
  /** Provider calls this run will make, including any synthesis it needs. */
  totalCalls: number;
  /** Targets that cannot run, and why — missing keys, usually. */
  unavailable: { target: Target; reason: string }[];
  /** Null when any target's rate is unknown, so no false precision is shown. */
  estimatedCostUsd: number | null;
  notes: string[];
};
