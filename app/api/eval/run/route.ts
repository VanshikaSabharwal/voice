/**
 * Executing an evaluation. THIS SPENDS MONEY.
 *
 * Every request here fires real provider calls billed to the operator's
 * accounts, so the route is deliberately awkward to trigger by accident:
 *
 *  - POST only, so no link, prefetch or address bar can start one.
 *  - `confirm: true` must be in the body. A client that forgot to show the
 *    plan therefore cannot spend anything.
 *  - No retries. A failed target is reported as failed; retrying would double
 *    a bill to improve a number nobody asked for.
 */

import { execute } from "../../../../lib/eval/run";
import { planRun } from "../../../../lib/eval/plan";
import { saveRun } from "../../../../lib/store/evals";
import type { Target, TestCase } from "../../../../lib/eval/types";

export const dynamic = "force-dynamic";

/** A run of several providers times several repetitions is not quick. */
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: {
    targets?: Target[];
    testCase?: TestCase;
    runsPerTarget?: number;
    confirm?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { targets, testCase } = body;

  if (!Array.isArray(targets) || targets.length === 0) {
    return Response.json(
      { error: "Select at least one provider to evaluate." },
      { status: 400 },
    );
  }

  if (!testCase?.text?.trim()) {
    return Response.json(
      { error: "A test case with some text is required." },
      { status: 400 },
    );
  }

  if (body.confirm !== true) {
    return Response.json(
      {
        error:
          "This run makes billed provider calls. Send confirm: true once the plan has been shown.",
      },
      { status: 428 },
    );
  }

  /* Capped low. The cost of a run is linear in this number, and nothing here
     is worth a surprise bill from a fat-fingered value. */
  const runsPerTarget = Math.min(10, Math.max(1, body.runsPerTarget ?? 3));

  const plan = planRun({
    targets,
    testCase,
    runsPerTarget,
    synthesizeSttInput: true,
  });

  if (plan.targets.length === 0) {
    return Response.json(
      {
        error:
          "None of the selected providers have an API key configured, so there is nothing to run.",
        plan,
      },
      { status: 400 },
    );
  }

  const run = await execute({
    // Only the targets that can actually run; the rest are already reported
    // as unavailable by the plan.
    targets: plan.targets,
    testCase,
    runsPerTarget,
  });

  /* Save before responding. These results cost money to produce, and losing
     them to a failed write would mean paying twice for the same numbers. */
  const saved = await saveRun(run);

  return Response.json({
    run,
    plan,
    warning: saved
      ? undefined
      : "The results could not be saved — set MONGODB_URL to keep run history.",
  });
}
