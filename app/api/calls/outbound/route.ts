/**
 * Place an outbound call.
 *
 * Today this registers an intent that the browser harness answers, which is
 * enough to exercise the outbound path end to end without a carrier. With
 * Twilio, the voice server does a REST call to /Calls.json instead and the
 * returned SID replaces the local id — this route does not change.
 */

export const dynamic = "force-dynamic";

const VOICE_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:3001";

export async function POST(request: Request) {
  let body: { to?: string; agentId?: string; greeting?: string };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.to?.trim()) {
    return Response.json(
      { error: "A destination number `to` is required." },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(new URL("/internal/calls/outbound", VOICE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify(body),
    });

    return Response.json(await res.json(), { status: res.status });
  } catch {
    return Response.json(
      {
        error: `Voice server unreachable at ${VOICE_URL}. Start it with \`npm run dev:voice\`.`,
      },
      { status: 503 },
    );
  }
}
