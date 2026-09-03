/**
 * Optional credential / quota probe.
 *
 * This is the ONLY place the app talks to a provider API, and it runs solely
 * when the user presses Test Connection. It never influences which options are
 * available — the catalog in app/lib/capabilities.ts is static and controlled
 * by us. With no keys configured, every provider reports "missing" and the rest
 * of the app is unaffected.
 */

import { keyFor, isProbeable } from "../../../lib/providers/env";
import type { ProbeResult, ProbeStatus } from "../../../lib/validate";

// Credential checks must never be served from cache.
export const dynamic = "force-dynamic";

/** Cheapest authenticated GET per provider. */
const ENDPOINT: Record<string, (key: string) => { url: string; headers: HeadersInit }> = {
  gemini: (key) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    headers: {},
  }),
  elevenlabs: (key) => ({
    url: "https://api.elevenlabs.io/v1/user",
    headers: { "xi-api-key": key },
  }),
  cartesia: (key) => ({
    url: "https://api.cartesia.ai/voices",
    headers: { "X-API-Key": key, "Cartesia-Version": "2024-06-10" },
  }),
};

function statusFor(httpStatus: number): ProbeStatus {
  if (httpStatus === 401 || httpStatus === 403) return "invalid";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus >= 200 && httpStatus < 300) return "ok";
  return "unreachable";
}

async function probe(provider: string): Promise<ProbeResult> {
  const checkedAt = Date.now();

  if (!isProbeable(provider)) {
    return {
      status: "missing",
      message: "No connection check available for this provider.",
      checkedAt,
    };
  }

  const key = keyFor(provider);
  if (!key) {
    return { status: "missing", message: "No API key configured.", checkedAt };
  }

  const build = ENDPOINT[provider];
  if (!build) {
    return { status: "missing", message: "No probe endpoint.", checkedAt };
  }

  const { url, headers } = build(key);

  try {
    // Bound the wait so one slow provider cannot hang the whole check.
    const res = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    const status = statusFor(res.status);
    return {
      status,
      message:
        status === "ok" ? undefined : `HTTP ${res.status} from ${provider}.`,
      checkedAt,
    };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      status: "unreachable",
      message: timedOut ? "Request timed out." : "Network error.",
      checkedAt,
    };
  }
}

export async function POST(request: Request) {
  let providers: string[];

  try {
    const body = await request.json();
    providers = Array.isArray(body?.providers) ? body.providers : [];
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (providers.length === 0) {
    return Response.json({ results: {} });
  }

  // allSettled so one provider's failure cannot fail the whole request.
  const unique = Array.from(new Set(providers)).slice(0, 10);
  const settled = await Promise.allSettled(unique.map((p) => probe(p)));

  const results: Record<string, ProbeResult> = {};
  unique.forEach((provider, i) => {
    const outcome = settled[i];
    results[provider] =
      outcome.status === "fulfilled"
        ? outcome.value
        : {
            status: "unreachable",
            message: "Check failed unexpectedly.",
            checkedAt: Date.now(),
          };
  });

  return Response.json({ results });
}
