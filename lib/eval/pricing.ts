/**
 * What each provider charges.
 *
 * Cost is the third axis of an evaluation: a provider that is 100 ms faster
 * and four times the price is not obviously the better choice, and that
 * tradeoff cannot be seen without a number attached.
 *
 * These are LIST prices transcribed from public pricing pages, and they go
 * stale — vendors change them without notice, and negotiated or free-tier
 * rates differ. Anything not confirmed is left `null`, which the UI renders as
 * "unknown" rather than as free. A wrong number here is worse than a missing
 * one, because it silently skews every comparison.
 *
 * Each entry carries the date it was checked so staleness is visible rather
 * than assumed.
 */

import type { Modality } from "../../app/lib/capabilities";

/** How a provider meters the thing being billed. */
export type PricingUnit =
  /** Per minute of audio processed. Typical for STT. */
  | "per_audio_minute"
  /** Per million characters synthesized. Typical for TTS. */
  | "per_million_chars"
  /** Per million tokens, priced separately for input and output. Typical for LLM. */
  | "per_million_tokens";

export type Price = {
  unit: PricingUnit;
  /** Cost per unit in USD. For token pricing this is the input rate. */
  usd: number | null;
  /** Output-token rate in USD, LLM only. */
  usdOutput?: number | null;
  /** ISO date the figure was last confirmed against the vendor's page. */
  checked: string;
  /** Why a figure is missing, or anything that qualifies it. */
  note?: string;
};

type PricingTable = Record<string, Record<string, Price>>;

/*
 * Rates below were not verified against live vendor pages during
 * implementation, because doing so is not something code can attest to. They
 * are therefore all recorded as unknown rather than guessed: see
 * `MISSING_PRICING_NOTE`. Fill them in from each provider's pricing page and
 * set `checked` to the date you did.
 */
const UNKNOWN = (unit: PricingUnit, note: string): Price => ({
  unit,
  usd: null,
  checked: "never",
  note,
});

const FILL_IN = "Not filled in — see lib/eval/pricing.ts";

export const PRICING: Record<Modality, PricingTable> = {
  stt: {
    gemini: {
      "gemini-3.5-transcribe": UNKNOWN("per_audio_minute", FILL_IN),
      "gemini-3.6-flash": UNKNOWN("per_audio_minute", FILL_IN),
    },
    sarvam: { "saaras:v3": UNKNOWN("per_audio_minute", FILL_IN) },
    bodhan: { "indic-transcribe": UNKNOWN("per_audio_minute", FILL_IN) },
  },

  llm: {
    gemini: {
      "gemini-3.6-flash": UNKNOWN("per_million_tokens", FILL_IN),
    },
    groq: {
      "openai/gpt-oss-20b": UNKNOWN("per_million_tokens", FILL_IN),
    },
  },

  tts: {
    cartesia: { "sonic-2": UNKNOWN("per_million_chars", FILL_IN) },
    elevenlabs: {
      eleven_multilingual_v2: UNKNOWN("per_million_chars", FILL_IN),
    },
    sarvam: { "bulbul:v2": UNKNOWN("per_million_chars", FILL_IN) },
    bodhan: { "indic-speak": UNKNOWN("per_million_chars", FILL_IN) },
    gemini: { "gemini-3.5-tts": UNKNOWN("per_million_chars", FILL_IN) },
  },
};

export const MISSING_PRICING_NOTE =
  "Prices are not pre-filled. Vendor pricing changes without notice, and a " +
  "stale figure would quietly skew every comparison — so unknown is recorded " +
  "as unknown. Add rates in lib/eval/pricing.ts with the date you checked.";

/** Look up a price, or null when it is not known. */
export function priceFor(
  modality: Modality,
  provider: string,
  model: string,
): Price | null {
  return PRICING[modality]?.[provider]?.[model] ?? null;
}

export type CostEstimate = {
  usd: number;
  /** How the figure was arrived at, for display next to the number. */
  basis: string;
};

/**
 * Estimate what one evaluation request cost.
 *
 * Returns null when the rate is unknown, so callers show "—" instead of a
 * confident zero. Billing a request at $0 because we lack a price is the one
 * outcome that would actively mislead.
 */
export function estimateCost(
  modality: Modality,
  provider: string,
  model: string,
  usage: { audioSeconds?: number; characters?: number; inputTokens?: number; outputTokens?: number },
): CostEstimate | null {
  const price = priceFor(modality, provider, model);

  if (!price || price.usd === null) return null;

  if (price.unit === "per_audio_minute" && usage.audioSeconds !== undefined) {
    const minutes = usage.audioSeconds / 60;
    return {
      usd: minutes * price.usd,
      basis: `${usage.audioSeconds.toFixed(1)}s @ $${price.usd}/min`,
    };
  }

  if (price.unit === "per_million_chars" && usage.characters !== undefined) {
    return {
      usd: (usage.characters / 1_000_000) * price.usd,
      basis: `${usage.characters} chars @ $${price.usd}/M`,
    };
  }

  if (price.unit === "per_million_tokens" && usage.inputTokens !== undefined) {
    const input = (usage.inputTokens / 1_000_000) * price.usd;
    const output =
      price.usdOutput != null && usage.outputTokens !== undefined
        ? (usage.outputTokens / 1_000_000) * price.usdOutput
        : 0;

    return {
      usd: input + output,
      basis: `${usage.inputTokens} in / ${usage.outputTokens ?? 0} out tokens`,
    };
  }

  return null;
}
