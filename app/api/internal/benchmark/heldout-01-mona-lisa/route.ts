import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runD3Fixture, D3FixtureError, BENCHMARK_CASE_ID } from "@/scripts/runD3Fixture";

// ---------------------------------------------------------------------------
// TEMPORARY — M4 held-out benchmark case only. Delete this route once the
// held-out run has been verified in the corpus (both racer/4.0.0 control and
// racer/4.1.0 candidate passes — see docs/m4-experiment-spec.md §6). Mirrors
// app/api/internal/benchmark/d2-eiffel-tower/route.ts exactly, pointed at
// scripts/runD3Fixture.ts instead — see that route's own header comment for
// the full reasoning (why in-process, not self-HTTP; why
// BENCHMARK_INGRESS_SECRET is a readiness gate only). Not repeated here to
// avoid the routes' explanations drifting apart from each other.
//
// WHY A SEPARATE ROUTE FOR THE HELD-OUT FIXTURE RATHER THAN A SHARED,
// PARAMETERIZED ONE. Matches scripts/runD3Fixture.ts's own reasoning: each
// frozen fixture is its own individually-reviewed spec, and D-1/D-2's
// already-verified routes + test suites stay completely untouched.
//
// AUTH MODEL (identical to the D-1/D-2 routes):
//   1. Preview-only. Refuses (404) unless process.env.VERCEL_ENV === "preview".
//   2. Caller authentication is Vercel's own Deployment Protection, not app
//      code.
//   3. Exact confirmation body. The request body must be exactly
//      {"confirm":"run-heldout-01-once"} — deliberately a DIFFERENT string
//      from D-1's "run-d1-once" and D-2's "run-d2-once", so no two routes can
//      ever be triggered by the same accidental confirmation body.
//   4. No other parameters accepted — the route plays exactly one thing,
//      the frozen held-out ("the Mona Lisa") fixture, under whichever
//      RACER_PROMPT_VERSION is deployed at the time (racer/4.0.0 for the
//      control pass, racer/4.1.0 for the candidate pass).
//   5. POST-only. No other method handler exists on this route.
//
// KNOWN LIMITATION, ACCEPTED (same as D-1/D-2): a 50-question game runs up to
// ~50 sequential Racer + Composer model calls in one request, which can
// approach or exceed maxDuration below.
// ---------------------------------------------------------------------------

export const maxDuration = 300;

const REQUIRED_CONFIRMATION = "run-heldout-01-once";

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
    const outcome = await runD3Fixture();
    return NextResponse.json({
      game_id: outcome.game_id,
      benchmark_case_id: outcome.benchmark_case_id ?? BENCHMARK_CASE_ID,
      benchmark_run_id: outcome.benchmark_run_id,
      result: outcome.result,
      final_action: outcome.final_action,
      adjudicator_verdict: outcome.adjudicator_verdict,
      integrity_verdict: outcome.integrity_verdict,
      prompt_version: outcome.prompt_version,
    });
  } catch (err) {
    // err.message is constructed entirely in runD3Fixture from game/turn
    // state and route-style error codes — never from a secret value. No retry.
    const message = err instanceof D3FixtureError || err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[benchmark/heldout-01-mona-lisa] run failed: ${message}`);
    return NextResponse.json({ error: "benchmark_run_failed", message }, { status: 502 });
  }
}
