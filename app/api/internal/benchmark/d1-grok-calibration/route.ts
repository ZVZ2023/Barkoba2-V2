import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runD1GrokCalibration, D1GrokFixtureError, BENCHMARK_CASE_ID } from "@/scripts/runD1GrokCalibration";

// ---------------------------------------------------------------------------
// TEMPORARY — V2.8.x Grok calibration game 1 of 2 ("Generic Backpack",
// provider xai, racer/4.0.0). Mirrors app/api/internal/benchmark/
// d1-generic-backpack/route.ts exactly, pointed at
// scripts/runD1GrokCalibration.ts instead. Own confirmation string, own
// route — matching this project's established one-fixture-per-file
// convention.
//
// AUTH MODEL, IDENTICAL SHAPE TO EVERY OTHER internal/benchmark ROUTE:
//   1. Preview-only. Refuses (404) unless VERCEL_ENV === "preview".
//   2. Exact confirmation body {"confirm":"run-d1-grok-calibration-once"}.
//   3. BENCHMARK_INGRESS_SECRET is a readiness gate only.
//   4. POST-only.
// ---------------------------------------------------------------------------

export const maxDuration = 300;

const REQUIRED_CONFIRMATION = "run-d1-grok-calibration-once";

function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.VERCEL_ENV !== "preview") {
    return notFound();
  }

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

  if (!env.benchmarkIngressSecret()) {
    return NextResponse.json({ error: "benchmark_secret_not_configured" }, { status: 500 });
  }

  if (!env.xaiApiKey()) {
    return NextResponse.json(
      {
        error: "xai_key_not_configured",
        message: "XAI_API_KEY is not set in this Preview deployment's environment.",
      },
      { status: 500 }
    );
  }

  try {
    const outcome = await runD1GrokCalibration();
    return NextResponse.json({
      game_id: outcome.game_id,
      benchmark_case_id: outcome.benchmark_case_id ?? BENCHMARK_CASE_ID,
      benchmark_run_id: outcome.benchmark_run_id,
      result: outcome.result,
      final_action: outcome.final_action,
      adjudicator_verdict: outcome.adjudicator_verdict,
      integrity_verdict: outcome.integrity_verdict,
      prompt_version: outcome.prompt_version,
      pinned_model: outcome.pinned_model,
    });
  } catch (err) {
    const message = err instanceof D1GrokFixtureError || err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[benchmark/d1-grok-calibration] run failed: ${message}`);
    return NextResponse.json({ error: "benchmark_run_failed", message }, { status: 502 });
  }
}
