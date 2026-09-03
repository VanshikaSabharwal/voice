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
  elevenlabs: "ELEVENLABS_API_KEY",
  cartesia: "CARTESIA_API_KEY",
  sarvam: "SARVAM_API_KEY",
};

/**
 * Providers with a free health endpoint. Sarvam is excluded: checking it would
 * require a billable inference call, so Test Connection reports it as
 * unavailable rather than spending credits.
 */
const PROBEABLE = new Set(["gemini", "elevenlabs", "cartesia"]);

export function keyFor(provider: string): string | undefined {
  const name = ENV_VAR[provider];
  if (!name) return undefined;
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

/** Providers this app is able to probe at all. */
export function isProbeable(provider: string): boolean {
  return PROBEABLE.has(provider);
}
