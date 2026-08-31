import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runRacerTurn, RACER_PROMPT_VERSION } from "@/lib/prompts/racer";
import type { RacerPublicState } from "@/lib/types";

// ---------------------------------------------------------------------------
// V2.8.x — XAI PROVIDER SMOKE TEST. NOT EXPERIMENT EVIDENCE.
//
// One forced-tool call to the xAI Racer seat, on a fabricated, empty
// RacerPublicState — no secret, no game creation, no corpus write, no
// Composer/Adjudicator/Integrity Review call. Exists only to prove, before
// any real game runs: xAI auth works, the pinned model exists and returns a
// tool call, the structured-output schema parses, and usage/cost telemetry
// is actually present in the shape this batch's cost accounting assumes.
//
// PINS THE EXACT MODEL FOR THIS EXPERIMENT, IN CODE, NOT VIA
// XAI_MODEL_RACER. Setting process.env.XAI_MODEL_RACER here — mirroring
// scripts/probeRacerLatency.ts's own local-CLI pattern — means this call
// (and only this call, for the lifetime of this one invocation) resolves to
// the frozen snapshot below regardless of whatever the deployment's own
// XAI_MODEL_RACER is configured to, or its "grok-4.6" fallback default in
// lib/env.ts. Production model selection is completely untouched.
//
// AUTH MODEL, SAME SHAPE AS THE OTHER internal/benchmark ROUTES:
//   1. Preview-only. Refuses (404) unless VERCEL_ENV === "preview".
//   2. Exact confirmation body {"confirm":"run-xai-smoke-test-once"}.
//   3. BENCHMARK_INGRESS_SECRET is a readiness gate only.
//   4. POST-only.
//
// racer/4.0.0 (CORE_RACER_RULES, unmodified) is what this call is stamped
// with, per RACER_PROMPT_VERSION on the checkout this route is deployed
// from — this route asserts nothing about guidance; it only proves the
// PROVIDER path.
// ---------------------------------------------------------------------------

export const maxDuration = 60;

const REQUIRED_CONFIRMATION = "run-xai-smoke-test-once";
const PINNED_MODEL = "grok-4.20-0309-reasoning";

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
    // The exact, expected shape of the human gate this smoke test exists to
    // surface — never a secret value, just its absence.
    return NextResponse.json(
      {
        error: "xai_key_not_configured",
        message:
          "XAI_API_KEY is not set in this Preview deployment's environment. " +
          "No xAI call was attempted.",
      },
      { status: 500 }
    );
  }

  process.env.XAI_MODEL_RACER = PINNED_MODEL;

  const state: RacerPublicState = {
    question_count: 0,
    max_questions: 5,
    questions_remaining: 5,
    game_language: "en",
    transcript: [],
    clues: [],
    clue_credits_available: 0,
  };

  try {
    const { output, provenance, diagnostics } = await runRacerTurn(state, {
      forceFinal: false,
      provider: "xai",
    });

    return NextResponse.json({
      label: "XAI PROVIDER SMOKE TEST — NOT EXPERIMENT EVIDENCE",
      pinned_model_requested: PINNED_MODEL,
      guidance_version: RACER_PROMPT_VERSION,
      provenance,
      output,
      diagnostics,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[benchmark/xai-smoke-test] failed: ${message}`);
    return NextResponse.json(
      { error: "xai_smoke_test_failed", message, pinned_model_requested: PINNED_MODEL },
      { status: 502 }
    );
  }
}
