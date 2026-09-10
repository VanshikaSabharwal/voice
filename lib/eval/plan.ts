/**
 * Working out what a run will do, before it does it.
 *
 * This module makes NO provider calls. It exists so the cost of an evaluation
 * is visible while it is still avoidable — every request an eval fires is
 * billed to the user's own accounts, so "run and find out" is not an
 * acceptable interaction.
 */

import { keyFor, envVarFor } from "../../app/lib/providers/env";
import { estimateCost, priceFor } from "./pricing";
import type { RunPlan, Target, TestCase } from "./types";

/**
 * Whether a target can run at all.
 *
 * A missing key is reported as unavailable rather than attempted and failed:
 * a failed attempt looks like a slow provider in the results, which is exactly
 * the wrong conclusion.
 */
export function availability(target: Target): { ok: boolean; reason?: string } {
  if (!keyFor(target.provider, target.modality)) {
    const envVar = envVarFor(target.provider, target.modality);

    // An unrecognised provider has no env var to name, and "set undefined" is
    // worse than saying plainly that we do not know the provider.
    return {
      ok: false,
      reason: envVar
        ? `No API key — set ${envVar}`
        : `Unknown provider "${target.provider}" for ${target.modality}`,
    };
  }

  return { ok: true };
}

/**
 * Calls one target costs per repetition.
 *
 * STT is the awkward one: it needs audio, and audio has to be synthesized
 * first, so evaluating a recogniser also bills a TTS request. Hiding that
 * would understate the cost of an STT run by half.
 */
function callsPerRun(target: Target, needsSynthesis: boolean): number {
  if (target.modality === "stt") return needsSynthesis ? 2 : 1;

  // TTS quality is scored by transcribing the audio back, which is a second
  // billed call on top of the synthesis itself.
  if (target.modality === "tts") return 2;

  return 1;
}

export type PlanInput = {
  targets: Target[];
  testCase: TestCase;
  runsPerTarget: number;
  /**
   * True when STT evaluation must synthesize its own audio. False when a
   * fixture recording is supplied, which removes the TTS call entirely — and
   * is the cheaper, more repeatable way to evaluate a recogniser.
   */
  synthesizeSttInput: boolean;
};

export function planRun(input: PlanInput): RunPlan {
  const available: Target[] = [];
  const unavailable: { target: Target; reason: string }[] = [];

  for (const target of input.targets) {
    const check = availability(target);

    if (check.ok) available.push(target);
    else unavailable.push({ target, reason: check.reason! });
  }

  let totalCalls = 0;
  let cost = 0;
  let anyUnknown = false;

  const characters = input.testCase.text.length;

  /* Audio length is estimated from the text, since no audio exists yet.
     ~14 characters per second is a normal speaking rate; this is only used to
     size an STT bill, and is labelled as an estimate wherever it is shown. */
  const audioSeconds = Math.max(1, characters / 14);

  for (const target of available) {
    totalCalls +=
      callsPerRun(target, input.synthesizeSttInput) * input.runsPerTarget;

    const usage =
      target.modality === "stt"
        ? { audioSeconds }
        : target.modality === "tts"
          ? { characters }
          : /* A token is roughly four characters of English. Rough is fine
               here: it sizes a bill, it does not settle one. */
            {
              inputTokens: Math.ceil(characters / 4),
              outputTokens: 150,
            };

    const estimate = estimateCost(
      target.modality,
      target.provider,
      target.model,
      usage,
    );

    if (estimate) cost += estimate.usd * input.runsPerTarget;
    else anyUnknown = true;
  }

  const notes: string[] = [];

  if (anyUnknown) {
    notes.push(
      "Some providers have no price recorded, so the total is unknown rather than partial.",
    );
  }

  if (input.synthesizeSttInput && available.some((t) => t.modality === "stt")) {
    notes.push(
      "Evaluating STT synthesizes a test utterance first, which is itself a billed TTS call. Supplying a fixture recording avoids it.",
    );
  }

  if (available.some((t) => t.modality === "tts")) {
    notes.push(
      "Scoring TTS quality transcribes the audio back, which bills one STT call per synthesis.",
    );
  }

  return {
    targets: available,
    runsPerTarget: input.runsPerTarget,
    totalCalls,
    unavailable,
    // Unknown beats a confident understatement: a partial sum reads as the
    // whole bill.
    estimatedCostUsd: anyUnknown ? null : Math.round(cost * 10000) / 10000,
    notes,
  };
}

/** Whether any price at all is on file, for a "prices not set up" hint. */
export function hasAnyPricing(targets: Target[]): boolean {
  return targets.some((t) => priceFor(t.modality, t.provider, t.model)?.usd != null);
}
