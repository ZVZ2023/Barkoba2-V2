/* eslint-disable no-console */
import { randomUUID } from "crypto";
import { createSecret, lockSecret, getSecretForAdjudication } from "../lib/secretStore";
import { createGame, saveGame } from "../lib/gameStore";
import { toRacerPublicState } from "../lib/racerState";
import { runRacerTurn, resolveGuessIntent, RACER_PROMPT_VERSION } from "../lib/prompts/racer";
import { answerAsComposer } from "../lib/prompts/composerAnswer";
import { detectGuess } from "../lib/guessDetector";
import { runAdjudicator } from "../lib/prompts/adjudicator";
import { runIntegrityReview } from "../lib/prompts/integrityReview";
import { needsAdjudication, needsIntegrityReview, deriveResult } from "../lib/resolveResult";
import { consumeModelCall } from "../lib/callBudget";
import type {
  AdjudicatorVerdict,
  ComposerAnswer,
  GameRecord,
  GuessIntentOutcome,
  IntegrityVerdict,
  QuestionLogEntry,
} from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.x — Grok calibration game 1 of 2 ("Generic Backpack", racer/4.0.0,
// provider xai). SAME TARGET, DEFINITION, GRANULARITY, DIFFICULTY, BUDGET AND
// LANGUAGE AS D-1 (scripts/runBenchmarkFixture.ts) — the one deliberately
// varied parameter is the Racer provider. This is what makes the comparison
// against the existing Claude M1/M3 D-1 evidence a genuine bridge rather than
// a different experiment: identical guidance, identical fixture, identical
// everything except which model is answering.
//
// A SEPARATE benchmark_case_id from D-1's Claude runs on purpose — Claude and
// Grok evidence must never be mixed statistically as though they were the
// same experimental population (per this batch's own explicit governance).
//
// THE MODEL IS PINNED IN-PROCESS, NOT VIA XAI_MODEL_RACER. Setting
// process.env.XAI_MODEL_RACER here (mirroring
// app/api/internal/benchmark/xai-smoke-test/route.ts's own pattern) means
// this run resolves to the frozen snapshot below for reproducibility,
// regardless of the deployment's own XAI_MODEL_RACER configuration or
// lib/env.ts's "grok-4.6" fallback default.
//
// racer/4.0.0 (CORE_RACER_RULES) is completely untouched — this file changes
// which model plays, never what it is told. This branch was forked from the
// M3 baseline commit specifically so RACER_PROMPT_VERSION here is the
// genuine frozen racer/4.0.0 text, not the rejected M4 racer/4.1.0 candidate.
//
// IN-PROCESS ORCHESTRATION, SAME SHAPE AS EVERY OTHER FIXTURE RUNNER IN THIS
// PROJECT. See scripts/runBenchmarkFixture.ts's own header comment for the
// full accounting of why (Vercel Deployment Protection blocks a deployment's
// self-HTTP calls to its own routes) and what is deliberately not replicated
// (runValidator, entitlement/rate-limit checks, Composer-answer provenance).
// ---------------------------------------------------------------------------

export const BENCHMARK_CASE_ID = "v2.8-grok-calib-d1-generic-backpack";

export const D1_TARGET = "a backpack";
export const D1_DEFINITION =
  "A backpack as a general kind of object: a bag with two straps, worn on the back, used by a person to carry belongings hands-free. This refers to backpacks as a category — any ordinary backpack counts, regardless of brand, size, color, material, or specific use (school, travel, hiking, laptop, etc.). Not one particular backpack.";
export const D1_GRANULARITY = "generic_type" as const;
export const D1_MODIFIERS: string | null = null;
export const D1_DIFFICULTY = "medium" as const;
export const D1_MAX_QUESTIONS = 50;
export const D1_GAME_LANGUAGE = "en" as const;
export const D1_RACER_PROVIDER = "xai" as const;
export const PINNED_MODEL = "grok-4.20-0309-reasoning";

const MAX_TURN_ITERATIONS = D1_MAX_QUESTIONS + 5;

export interface D1GrokFixtureResult {
  game_id: string;
  benchmark_case_id: string | null;
  benchmark_run_id: string | null;
  result: string | null;
  final_action: string | null;
  adjudicator_verdict: string | null;
  integrity_verdict: string | null;
  prompt_version: string | null;
  pinned_model: string;
}

export class D1GrokFixtureError extends Error {}

function newLogEntry(turnIndex: number): QuestionLogEntry {
  return {
    id: randomUUID(),
    turn_index: turnIndex,
    turn_type: "question",
    racer_output_raw: "",
    question_text: null,
    guess_text: null,
    composer_response: null,
    ambiguous_explanation: null,
    guess_detector_flagged: false,
    guess_detector_method: null,
    guess_intent_outcome: null,
    clue_text: null,
    original_question_text: null,
    edit_status: null,
    edit_reason: null,
    ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(),
    model_id: null,
    model_provider: null,
    prompt_version: null,
    answered_at: null,
    pre_revision_question_text: null,
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
  };
}

async function requireModelBudget(kind: "racer" | "resolve", context: string): Promise<void> {
  const budget = await consumeModelCall(kind);
  if (!budget.allowed) {
    throw new D1GrokFixtureError(
      `Model call budget exhausted (${kind}) while ${context}. failedClosed=${budget.failedClosed}`
    );
  }
}

export async function runD1GrokCalibration(): Promise<D1GrokFixtureResult> {
  process.env.XAI_MODEL_RACER = PINNED_MODEL;

  const benchmarkRunId = randomUUID();

  console.log(`[runD1GrokCalibration] benchmark_case_id: ${BENCHMARK_CASE_ID}`);
  console.log(`[runD1GrokCalibration] racer_prompt_version: ${RACER_PROMPT_VERSION}`);
  console.log(
    `[runD1GrokCalibration] target: "${D1_TARGET}" (${D1_GRANULARITY}, ${D1_DIFFICULTY}, ${D1_MAX_QUESTIONS}q, ${D1_GAME_LANGUAGE}, racer_provider=${D1_RACER_PROVIDER}, pinned_model=${PINNED_MODEL})`
  );

  const gameId = randomUUID();
  await createSecret(gameId, D1_TARGET, D1_DEFINITION, D1_GRANULARITY, D1_MODIFIERS);
  await lockSecret(gameId);

  let game: GameRecord = await createGame(gameId, {
    player_id: null,
    composer_player_id: null,
    racer_kind: "ai",
    racer_provider: D1_RACER_PROVIDER,
    racer_player_id: null,
    difficulty: D1_DIFFICULTY,
    phase: "questioning",
    max_questions: D1_MAX_QUESTIONS,
    private_target: false,
    game_language: D1_GAME_LANGUAGE,
    benchmark_case_id: BENCHMARK_CASE_ID,
    benchmark_run_id: benchmarkRunId,
  });

  console.log(`[runD1GrokCalibration] Created game_id=${gameId}, benchmark_run_id=${benchmarkRunId}`);

  await requireModelBudget("racer", "generating the first Racer turn");
  {
    const racerState = toRacerPublicState(game);
    const { output, provenance } = await runRacerTurn(racerState, {
      forceFinal: false,
      provider: D1_RACER_PROVIDER,
    });
    game = await appendRacerTurn(game, output, provenance, racerState);
  }

  let iterations = 0;
  while (game.phase === "questioning") {
    iterations += 1;
    if (iterations > MAX_TURN_ITERATIONS) {
      throw new D1GrokFixtureError(
        `Exceeded ${MAX_TURN_ITERATIONS} turn iterations without resolving. game_id=${gameId}`
      );
    }

    const pending = game.qa_log[game.qa_log.length - 1];
    if (!pending || pending.turn_type !== "question" || pending.composer_response !== null) {
      throw new D1GrokFixtureError(
        `Unexpected state: no unanswered question at the end of qa_log. game_id=${gameId}`
      );
    }

    console.log(`[runD1GrokCalibration] Q${pending.turn_index}: ${pending.question_text}`);

    await requireModelBudget("racer", "answering as the Composer");
    const answerOutcome = await answerAsComposer({
      target: D1_TARGET,
      definition: D1_DEFINITION,
      granularity: D1_GRANULARITY,
      modifiers: D1_MODIFIERS,
      question: pending.question_text ?? "",
      qaLog: game.qa_log.slice(0, -1),
      questionsAsked: game.question_count,
      maxQuestions: game.max_questions,
      gameLanguage: D1_GAME_LANGUAGE,
    });

    const answer: ComposerAnswer = answerOutcome.result.answer;
    console.log(
      `[runD1GrokCalibration]   -> ${answer}${
        answerOutcome.result.ambiguous_explanation ? ` (${answerOutcome.result.ambiguous_explanation})` : ""
      }`
    );

    pending.composer_response = answer;
    pending.answered_at = new Date().toISOString();
    if (answer === "AMBIGUOUS") {
      pending.ambiguous_explanation = answerOutcome.result.ambiguous_explanation ?? null;
      game.ambiguous_count += 1;
    } else {
      pending.ambiguous_explanation = null;
    }
    game.question_count += 1;

    const forceFinal = game.question_count >= game.max_questions;
    await requireModelBudget("racer", "generating the next Racer turn");
    const racerState = toRacerPublicState(game);
    const { output, provenance } = await runRacerTurn(racerState, {
      forceFinal,
      provider: D1_RACER_PROVIDER,
    });
    game = await appendRacerTurn(game, output, provenance, racerState);
  }

  console.log(`[runD1GrokCalibration] Questioning ended. final_action=${game.final_action}, phase=${game.phase}`);

  const secret = await getSecretForAdjudication(gameId);
  if (!secret) {
    throw new D1GrokFixtureError(`Secret unavailable at resolution for game_id=${gameId}`);
  }

  let adjudicatorVerdict: AdjudicatorVerdict | null = null;
  let integrityVerdict: IntegrityVerdict | null = null;
  let adjudicationNotes: string | null = null;
  let adjudicationConfidence: number | null = null;
  let integrityNotes: string | null = null;
  let flaggedTurns: number[] | null = null;

  if (needsAdjudication(game.final_action)) {
    await requireModelBudget("resolve", "running the Adjudicator");
    const adjudication = await runAdjudicator({
      target: secret.target,
      privateClarification: secret.private_clarification,
      guess: game.final_guess_text ?? "",
      gameLanguage: game.game_language,
    });
    adjudicatorVerdict = adjudication.verdict;
    adjudicationNotes = adjudication.reasoning;
    adjudicationConfidence = typeof adjudication.confidence === "number" ? adjudication.confidence : null;
  }

  if (needsIntegrityReview(game.final_action, adjudicatorVerdict)) {
    await requireModelBudget("resolve", "running the Integrity Review");
    const review = await runIntegrityReview({
      target: secret.target,
      privateClarification: secret.private_clarification,
      qaLog: game.qa_log,
      gameLanguage: game.game_language,
    });
    integrityVerdict = review.verdict;
    integrityNotes = review.reasoning;
    flaggedTurns = review.contradicting_turns.length > 0 ? review.contradicting_turns : null;
  }

  const result = deriveResult({
    finalAction: game.final_action,
    adjudicator: adjudicatorVerdict,
    integrity: integrityVerdict,
  });

  game.result = result;
  game.adjudication_notes = adjudicationNotes;
  game.integrity_notes = integrityNotes;
  game.integrity_flagged_turns = flaggedTurns;
  game.adjudicator_verdict = adjudicatorVerdict;
  game.integrity_verdict = integrityVerdict;
  game.adjudication_confidence = adjudicationConfidence;

  game.revealed_target = secret.target;
  game.revealed_definition = secret.private_clarification;
  game.revealed_granularity = secret.granularity;
  game.revealed_modifiers = secret.modifiers;
  game.revealed_locked_at = secret.locked_at;
  game.phase = "complete";

  await saveGame(game);

  console.log("[runD1GrokCalibration] ===== RESOLVED =====");
  console.log(`game_id:            ${gameId}`);
  console.log(`benchmark_case_id:  ${game.benchmark_case_id ?? "(none)"}`);
  console.log(`benchmark_run_id:   ${game.benchmark_run_id ?? "(none)"}`);
  console.log(`result:             ${game.result}`);
  console.log(`final_action:       ${game.final_action}`);
  console.log(`question_count:     ${game.question_count}/${game.max_questions}`);
  console.log(`adjudicator_verdict:${game.adjudicator_verdict}`);
  console.log(`integrity_verdict:  ${game.integrity_verdict}`);

  return {
    game_id: gameId,
    benchmark_case_id: game.benchmark_case_id,
    benchmark_run_id: game.benchmark_run_id,
    result: game.result,
    final_action: game.final_action,
    adjudicator_verdict: game.adjudicator_verdict,
    integrity_verdict: game.integrity_verdict,
    prompt_version: RACER_PROMPT_VERSION,
    pinned_model: PINNED_MODEL,
  };
}

async function appendRacerTurn(
  game: GameRecord,
  initialOutput: Awaited<ReturnType<typeof runRacerTurn>>["output"],
  provenance: Awaited<ReturnType<typeof runRacerTurn>>["provenance"],
  racerState: ReturnType<typeof toRacerPublicState>
): Promise<GameRecord> {
  let turn = initialOutput;
  let flagged = false;
  let intentOutcome: GuessIntentOutcome | null = null;
  let preRevisionQuestion: string | null = null;

  if (turn.action === "question" && turn.question_text) {
    const detection = detectGuess(turn.question_text);
    if (detection.flagged) {
      flagged = true;
      preRevisionQuestion = turn.question_text;
      await requireModelBudget("racer", "resolving flagged guess intent");
      const resolution = await resolveGuessIntent(racerState, turn.question_text, D1_RACER_PROVIDER);
      intentOutcome = resolution.resolution;
      if (resolution.resolution === "confirm_guess") {
        turn = { ...turn, action: "guess" as const, guess_text: resolution.guess_text ?? turn.question_text, question_text: null };
      } else if (resolution.revised_question) {
        turn = { ...turn, question_text: resolution.revised_question };
      }
    }
  }

  const entry = newLogEntry(game.qa_log.length + 1);
  entry.turn_type = turn.action;
  entry.racer_output_raw = JSON.stringify(turn);
  entry.question_text = turn.question_text;
  entry.guess_text = turn.guess_text;
  entry.guess_detector_flagged = flagged;
  entry.guess_detector_method = flagged ? "heuristic" : null;
  entry.guess_intent_outcome = intentOutcome;
  entry.pre_revision_question_text = preRevisionQuestion;
  entry.model_id = provenance.model_id;
  entry.model_provider = provenance.model_provider;
  entry.prompt_version = provenance.prompt_version;

  game.qa_log.push(entry);

  if (turn.action === "guess" || turn.action === "concede") {
    game.phase = "resolving";
    game.final_action = turn.action;
    game.final_guess_text = turn.guess_text;
  }

  await saveGame(game);
  return game;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[runD1GrokCalibration] Missing required environment variable: ${name}`);
    console.error("[runD1GrokCalibration] Aborting before any game is created.");
    process.exit(1);
  }
  return value.trim();
}

async function main(): Promise<void> {
  requiredEnv("BENCHMARK_INGRESS_SECRET");
  requiredEnv("XAI_API_KEY");

  try {
    const outcome = await runD1GrokCalibration();
    console.log(
      "\nVerify in Neon with:\n" +
        `  SELECT * FROM corpus.games WHERE benchmark_case_id = '${outcome.benchmark_case_id}';`
    );
  } catch (err) {
    console.error(`[runD1GrokCalibration] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
