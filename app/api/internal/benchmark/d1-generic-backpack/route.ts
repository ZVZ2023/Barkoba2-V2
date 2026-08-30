import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runD1Fixture, D1FixtureError, BENCHMARK_CASE_ID } from "@/scripts/runBenchmarkFixture";

// ---------------------------------------------------------------------------
// TEMPORARY — M1 proof-of-concept only. Delete this route once the D-1
// benchmark run has been verified in the corpus; it is not a product feature.
//
// WHY THIS ROUTE EXISTS AT ALL.
//
// scripts/runBenchmarkFixture.ts needs BENCHMARK_INGRESS_SECRET and
// ANTHROPIC_API_KEY. Both are Vercel "Sensitive" environment variables,
// decrypted ONLY inside an actual running Production or Preview deployment —
// never via `vercel env pull`, the dashboard, the API, or `vercel dev`. The
// only way to use them without weakening that protection is to run the
// orchestration as code that IS the deployment.
//
// ---------------------------------------------------------------------------
// EXECUTION MODEL — IN-PROCESS, NOT SELF-HTTP.
//
// An earlier version of this route called runD1Fixture(baseUrl) which issued
// HTTP requests back to /api/game/create, /turn, and /resolve on this same
// deployment's own hostname. That failed in a real invocation: this project's
// Preview deployments sit behind Vercel Deployment Protection, which applies
// to ALL traffic to the deployment's hostname — including a server-side
// fetch() from the deployment calling back into itself. The self-call to
// /api/game/create came back HTTP 401 before ever reaching that route's code.
//
// runD1Fixture() now calls the same underlying application functions those
// three routes call (createSecret, lockSecret, createGame, toRacerPublicState,
// runRacerTurn, resolveGuessIntent, answerAsComposer, getSecretForAdjudication,
// runAdjudicator, runIntegrityReview, deriveResult, saveGame) directly, as
// ordinary in-process function calls — see that file's own header comment for
// the full accounting of what is and isn't replicated, and why. There is no
// HTTP boundary left inside this route's own execution to be blocked by
// Deployment Protection.
//
// ---------------------------------------------------------------------------
// AUTH MODEL (unchanged from the prior redesign — see that commit for the
// reasoning behind moving off the x-barkoba-benchmark-secret header entirely).
//
//   1. Preview-only. Refuses (404) unless process.env.VERCEL_ENV === "preview".
//   2. Caller authentication is Vercel's own Deployment Protection, not app
//      code — a request only reaches this handler's code at all after
//      passing Vercel's SSO/team-membership check at the edge.
//   3. Exact confirmation body. The request body must be exactly
//      {"confirm":"run-d1-once"} — no other key, no other value. Not a
//      secret; its only job is to prove the call was deliberate.
//   4. No other parameters accepted — the route plays exactly one thing,
//      the frozen D-1 ("Generic Backpack") fixture.
//   5. POST-only. No other method handler exists on this route.
//
// BENCHMARK_INGRESS_SECRET keeps exactly one job: a readiness gate confirming
// benchmark tagging is configured at all before a game is created (refusing
// otherwise, rather than silently creating an untagged benchmark game). Its
// value is never compared against anything, never leaves this process, and is
// never logged, returned, or echoed.
//
// NO AUTOMATIC RETRY. Exactly one call to runD1Fixture per request.
//
// KNOWN LIMITATION, ACCEPTED FOR THIS PROOF-OF-CONCEPT: a 50-question D-1 game
// runs up to ~50 sequential Racer + Composer model calls in one request. That
// can approach or exceed maxDuration below. If it times out mid-game, the
// game itself is NOT lost — every internal saveGame() call already persisted
// state — but it can no longer be advanced by this route (which only ever
// plays one fresh game); it would need the ordinary /api/game/[id]/turn and
// /resolve routes called directly against its game_id to finish.
// ---------------------------------------------------------------------------

export const maxDuration = 300;

const REQUIRED_CONFIRMATION = "run-d1-once";

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
    const outcome = await runD1Fixture();
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
    // err.message is constructed entirely in runD1Fixture from game/turn
    // state and route-style error codes — never from a secret value. No retry.
    const message = err instanceof D1FixtureError || err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[benchmark/d1-generic-backpack] run failed: ${message}`);
    return NextResponse.json({ error: "benchmark_run_failed", message }, { status: 502 });
  }
}
