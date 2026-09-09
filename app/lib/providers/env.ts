/**
 * Server-only API key lookup. The single place `process.env` is read for
 * provider credentials.
 *
 * Keys are never exposed to the browser — the env vars carry no NEXT_PUBLIC_
 * prefix, so Next.js will not inline them into client bundles.
 *
 * IMPORTANT: import this only from route handlers. It is never referenced by a
 * "use client" module, which is what keeps the keys server-side.
 */

const ENV_VAR: Record<string, string> = {
  gemini: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  cartesia: "CARTESIA_API_KEY",
  sarvam: "SARVAM_API_KEY",
  bodhan: "BODHAN_API_KEY",
};

/**
 * Per-modality key overrides, checked before the provider-wide variable.
 *
 * Bodhan scopes each key to a single model, so one credential cannot cover
 * both transcription and speech — using the TTS key for STT returns a 403
 * naming the model it is allowed to access. Anyone using only one modality can
 * still set the plain BODHAN_API_KEY and ignore this.
 */
const MODALITY_ENV_VAR: Record<string, Partial<Record<Modality, string>>> = {
  bodhan: {
    stt: "BODHAN_STT_API_KEY",
    tts: "BODHAN_TTS_API_KEY",
  },
};

export type Modality = "stt" | "llm" | "tts";

/**
 * Providers with a free health endpoint. Sarvam and Bodhan are excluded:
 * checking either would require a billable inference call, so Test Connection
 * reports them as unavailable rather than spending credits.
 */
const PROBEABLE = new Set(["gemini", "elevenlabs", "cartesia"]);

function read(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

/**
 * The API key for a provider, optionally for one modality.
 *
 * A modality-specific variable wins when set, so a provider issuing separate
 * credentials per model works without forcing everyone else to name their
 * variables that way.
 */
export function keyFor(provider: string, modality?: Modality): string | undefined {
  if (modality) {
    const specific = read(MODALITY_ENV_VAR[provider]?.[modality]);
    if (specific) return specific;
  }

  return read(ENV_VAR[provider]);
}

/**
 * The env var a config should set, for error messages.
 *
 * Names the modality-specific variable when the provider uses them, so a
 * failure tells the reader which of the two is missing.
 */
export function envVarFor(provider: string, modality?: Modality): string | undefined {
  if (modality) {
    const specific = MODALITY_ENV_VAR[provider]?.[modality];
    if (specific) return specific;
  }

  return ENV_VAR[provider];
}

/** Providers this app is able to probe at all. */
export function isProbeable(provider: string): boolean {
  return PROBEABLE.has(provider);
}
