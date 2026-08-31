import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runD2Fixture, D2FixtureError, BENCHMARK_CASE_ID } from "@/scripts/runD2Fixture";

// ---------------------------------------------------------------------------
// TEMPORARY — M3 D-2 controlled benchmark case only. Delete this route once
// the D-2 run has been verified in the corpus; it is not a product feature.
// Mirrors app/api/internal/benchmark/d1-generic-backpack/route.ts exactly,
// pointed at scripts/runD2Fixture.ts instead — see that route's own header
// comment for the full reasoning (why in-process, not self-HTTP; why
// BENCHMARK_INGRESS_SECRET is a readiness gate only). Not repeated here to
// avoid the two routes' explanations drifting apart from each other.
//
// WHY A SEPARATE ROUTE FOR D-2 RATHER THAN A SHARED, PARAMETERIZED ONE.
// Matches scripts/runD2Fixture.ts's own reasoning: each frozen fixture is its
// own individually-reviewed spec, and D-1's already-verified route + test
// suite (test/benchmarkD1Route.test.ts) stay completely untouched.
//
// AUTH MODEL (identical to the D-1 route):
//   1. Preview-only. Refuses (404) unless process.env.VERCEL_ENV === "preview".
//   2. Caller authentication is Vercel's own Deployment Protection, not app
//      code.
//   3. Exact confirmation body. The request body must be exactly
//      {"confirm":"run-d2-once"} — deliberately a DIFFERENT string from D-1's
//      "run-d1-once", so the two routes can never be triggered by the same
//      accidental confirmation body.
//   4. No other parameters accepted — the route plays exactly one thing,
//      the frozen D-2 ("The Eiffel Tower") fixture.
//   5. POST-only. No other method handler exists on this route.
//
// KNOWN LIMITATION, ACCEPTED (same as D-1): a 50-question D-2 game runs up to
// ~50 sequential Racer + Composer model calls in one request, which can
// approach or exceed maxDuration below.
// ---------------------------------------------------------------------------

export const maxDuration = 300;

const REQUIRED_CONFIRMATION = "run-d2-once";

function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ---- Gate 1: Preview only ------------------------------------------------
  if (process.env.VERCEL_ENV !== "preview") {
    return notFound();
  }

  // ---- Gate 2: exact confirmation body, no other parameters ----------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  }

  const isExactConfirmation =
    typeof body === "object" &&
    body !== null &&
    Object.keys(body as Record<string, unknown>).length === 1 &&
    (body as Record<string, unknown>).confirm === REQUIRED_CONFIRMATION;

  if (!isExactConfirmation) {
    return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  }

  // ---- Readiness gate only: BENCHMARK_INGRESS_SECRET's value is never used
  // ---- for anything beyond confirming benchmark tagging is configured.
  if (!env.benchmarkIngressSecret()) {
    return NextResponse.json({ error: "benchmark_secret_not_configured" }, { status: 500 });
  }

  try {
    const outcome = await runD2Fixture();
    return NextResponse.json({
      game_id: outcome.game_id,
      benchmark_case_id: outcome.benchmark_case_id ?? BENCHMARK_CASE_ID,
      benchmark_run_id: outcome.benchmark_run_id,
      result: outcome.result,
      final_action: outcome.final_action,
      adjudicator_verdict: outcome.adjudicator_verdict,
      integrity_verdict: outcome.integrity_verdict,
    });
  } catch (err) {
    // err.message is constructed entirely in runD2Fixture from game/turn
    // state and route-style error codes — never from a secret value. No retry.
    const message = err instanceof D2FixtureError || err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[benchmark/d2-eiffel-tower] run failed: ${message}`);
    return NextResponse.json({ error: "benchmark_run_failed", message }, { status: 502 });
  }
}
