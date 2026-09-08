/**
 * Request deadlines for provider calls.
 *
 * On a phone call, a slow provider is indistinguishable from a dead line — the
 * caller hears silence either way, and after a few seconds they hang up. So
 * every outbound request needs a ceiling, and it needs to be far tighter than
 * a typical HTTP default.
 *
 * The subtlety this exists to prevent: `signal ?? AbortSignal.timeout(ms)`
 * reads as "use the caller's signal, or a timeout", but when a caller signal
 * *is* supplied it silently replaces the deadline, so the request can hang
 * forever. Both conditions have to apply, which is what AbortSignal.any does.
 */

/** A single LLM round-trip. Two are needed for a tool call. */
export const LLM_TIMEOUT_MS = 12000;

/** Transcription of one utterance, capped at general.maxDuration seconds. */
export const STT_TIMEOUT_MS = 15000;

/** Time to the first byte of speech, not the whole stream. */
export const TTS_TIMEOUT_MS = 15000;

/** Cancel when either the caller aborts or the deadline passes. */
export function withDeadline(
  signal: AbortSignal | undefined,
  ms: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(ms);

  if (!signal) return timeout;

  // AbortSignal.any: Node 20+, and every current browser.
  return AbortSignal.any([signal, timeout]);
}

/**
 * Turn an abort into something a person can act on.
 *
 * A bare "This operation was aborted" in a call log tells you nothing about
 * which provider stalled, which is precisely what you need to know.
 */
export function describeFailure(
  err: unknown,
  provider: string,
  stage: string,
): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") {
      return `${provider} ${stage} timed out. It may be rate limited — try a different provider.`;
    }

    if (err.name === "AbortError") {
      return `${provider} ${stage} was cancelled.`;
    }

    return err.message;
  }

  return `${provider} ${stage} failed.`;
}
