/**
 * Call history.
 *
 * A proxy rather than a store: call records live on the voice server, which
 * has a real filesystem and is already holding the sessions. This app is bound
 * for Vercel, whose filesystem is read-only, so it could not persist them here
 * even if it wanted to.
 */

export const dynamic = "force-dynamic";

const VOICE_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:3001";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = new URL("/internal/calls", VOICE_URL);

  const id = url.searchParams.get("id");
  const limit = url.searchParams.get("limit");

  if (id) target.searchParams.set("id", id);
  if (limit) target.searchParams.set("limit", limit);

  try {
    const res = await fetch(target, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    return Response.json(await res.json(), { status: res.status });
  } catch {
    // A stopped voice server is the normal case when only the UI is running,
    // so say so plainly rather than surfacing a connection error.
    return Response.json(
      {
        calls: [],
        error: `Voice server unreachable at ${VOICE_URL}. Start it with \`npm run dev:voice\`.`,
      },
      { status: 503 },
    );
  }
}
