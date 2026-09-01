import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runCandidateValidationGate, CANDIDATE_VALIDATION_GATE_VERSION } from "@/lib/prompts/candidateValidationGate";
import type { RacerPublicState } from "@/lib/types";

// ---------------------------------------------------------------------------
// V2.8.x — CANDIDATE-VALIDATION-GATE SMOKE TEST. NOT EXPERIMENT EVIDENCE.
//
// One forced-tool call to the gate itself, on a fabricated transcript
// deliberately built to resemble game 2's real failure (guitar guessed as
// "musical instrument") — a category one level too broad given established
// facts, with an obvious unused discriminator (string count, acoustic vs.
// electric, etc.) still available. This exists only to prove, before any
// paid regression game runs: xAI auth works for THIS call shape, the gate's
// schema parses, the pinned model is honored, and usage/cost telemetry is
// present on the gate call path specifically (separate from the ordinary
// Racer-turn path the existing xai-smoke-test route already proved).
//
// No secret, no game creation, no corpus write. Same auth model as every
// other internal/benchmark route: Preview-only, exact confirmation body,
// BENCHMARK_INGRESS_SECRET readiness gate, POST-only.
// ---------------------------------------------------------------------------

export const maxDuration = 60;

const REQUIRED_CONFIRMATION = "run-gate-smoke-test-once";
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
    return NextResponse.json(
      {
        error: "xai_key_not_configured",
        message:
          "XAI_API_KEY is not set in this Preview deployment's environment. No xAI call was attempted.",
      },
      { status: 500 }
    );
  }

  const state: RacerPublicState = {
    question_count: 6,
    max_questions: 50,
    questions_remaining: 44,
    game_language: "en",
    transcript: [
      { turn_index: 1, question: "Is the target something that exists or has existed in the real world (not fictional)?", answer: "YES", ambiguous_explanation: null },
      { turn_index: 2, question: "Is the target a physical object?", answer: "YES", ambiguous_explanation: null },
      { turn_index: 3, question: "Is it larger than a breadbox?", answer: "NO", ambiguous_explanation: null },
      { turn_index: 4, question: "Does it have strings?", answer: "YES", ambiguous_explanation: null },
      { turn_index: 5, question: "Is it played by plucking or strumming?", answer: "YES", ambiguous_explanation: null },
      { turn_index: 6, question: "Does it have a neck and a body?", answer: "YES", ambiguous_explanation: null },
    ],
    clues: [],
    clue_credits_available: 0,
  };
  const proposedGuess = "a musical instrument";

  try {
    const gate = await runCandidateValidationGate(state, proposedGuess, "xai", PINNED_MODEL);

    return NextResponse.json({
      label: "CANDIDATE-VALIDATION-GATE SMOKE TEST — NOT EXPERIMENT EVIDENCE",
      pinned_model_requested: PINNED_MODEL,
      gate_version: CANDIDATE_VALIDATION_GATE_VERSION,
      proposed_guess: proposedGuess,
      expected: "block (candidate is a bare category one level above what the transcript already supports)",
      gate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[benchmark/gate-smoke-test] failed: ${message}`);
    return NextResponse.json(
      { error: "gate_smoke_test_failed", message, pinned_model_requested: PINNED_MODEL },
      { status: 502 }
    );
  }
}
