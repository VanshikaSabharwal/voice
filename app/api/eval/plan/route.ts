/**
 * What a run would cost, before committing to it.
 *
 * Makes no provider calls, so it is free to ask. The UI calls this on every
 * selection change and shows the answer next to the Run button, which is what
 * keeps the cost of an evaluation visible while it is still avoidable.
 */

import { planRun } from "../../../../lib/eval/plan";
import { MISSING_PRICING_NOTE } from "../../../../lib/eval/pricing";
import type { Target, TestCase } from "../../../../lib/eval/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: {
    targets?: Target[];
    testCase?: TestCase;
    runsPerTarget?: number;
    synthesizeSttInput?: boolean;
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

  const runsPerTarget = Math.min(10, Math.max(1, body.runsPerTarget ?? 3));

  const plan = planRun({
    targets,
    testCase,
    runsPerTarget,
    synthesizeSttInput: body.synthesizeSttInput ?? true,
  });

  return Response.json({
    plan,
    // Surfaced so an unknown total reads as "not configured" rather than as a
    // bug in the estimator.
    pricingNote: plan.estimatedCostUsd === null ? MISSING_PRICING_NOTE : undefined,
  });
}
