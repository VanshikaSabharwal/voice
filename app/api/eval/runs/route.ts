/** Reading and removing past runs. Free — no provider calls. */

import { deleteRun, getRun, listRuns } from "../../../../lib/store/evals";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");

  if (id) {
    const run = await getRun(id);

    if (!run) return Response.json({ error: "No such run." }, { status: 404 });

    return Response.json({ run });
  }

  return Response.json({ runs: await listRuns() });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");

  if (!id) return Response.json({ error: "id is required." }, { status: 400 });

  await deleteRun(id);

  return Response.json({ ok: true });
}
