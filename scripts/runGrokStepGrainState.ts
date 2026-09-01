/* eslint-disable no-console */
import { randomUUID } from "crypto";
import { createSecret, lockSecret, getSecretForAdjudication } from "../lib/secretStore";
import { createGame, getGame, saveGame } from "../lib/gameStore";
import { toRacerPublicState } from "../lib/racerState";
import { runRacerTurn, resolveGuessIntent } from "../lib/prompts/racer";
import { answerAsComposer } from "../lib/prompts/composerAnswer";
import { detectGuess } from "../lib/guessDetector";
import { deriveRequiredGrain, checkCandidateGrain, type RequiredTargetGrain } from "../lib/prompts/grainState";
import {
  SPECS,
  GrokStepError,
  newLogEntry,
  requireModelBudget,
  resolveGame,
  toStatus,
  type FixtureSpec,
  type GrokFixtureKey,
  type GrokStepStatus,
} from "./runGrokStep";
import type { ComposerAnswer, GameRecord, GuessIntentOutcome } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.x — REQUIRED-TARGET-GRAIN STATE turn-by-turn driver.
//
// A SIBLING of scripts/runGrokStep.ts and scripts/runGrokStepCandidate.ts,
// not a generalization of either. Same reasoning as runGrokStepCandidate.ts's
// own header comment: the files that produced already-collected frozen
// evidence must never be touched by a later experiment, even additively.
//
// Reuses SPECS, requireModelBudget, resolveGame, toStatus and newLogEntry
// from runGrokStep.ts UNMODIFIED, for the same fixture-identity reason as
// before.
//
// NO LLM CALL ANYWHERE IN THE GATE LOGIC HERE. lib/prompts/grainState.ts is
// pure and deterministic — see its own header comment for why that is the
// point of this experiment, not an incidental detail. This driver's only
// model calls are the ordinary Racer-turn generation (identical to control)
// and, on a block, exactly one mechanical retry of the same call with no
// injected hint — never a second candidate-gate prompt.
// ---------------------------------------------------------------------------

export interface GrainTransitionRecord {
  turn_index: number;
  grain: RequiredTargetGrain;
  probe: "A" | "B" | null;
  probe_question: string | null;
  probe_answer: "YES" | "NO" | null;
}

export interface GrainCheckActivationRecord {
  turn_index: number;
  proposed_guess: string;
  required_grain: RequiredTargetGrain;
  decision: string;
  grain_ok: boolean | null;
  reasoning: string;
  retried: boolean;
  retry_guess: string | null;
  retry_decision: string | null;
}

export interface StepDiagnosticsRecord {
  event: "racer_turn" | "racer_turn_retry" | "composer_answer";
  turn_index: number | null;
  model_id: string | null;
  model_provider: string | null;
  promptTokens?: number;
  cachedPromptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  rawUsage?: unknown;
}

export interface GrokStepStatusGrain extends GrokStepStatus {
  current_required_grain: RequiredTargetGrain;
  grain_established_this_step: GrainTransitionRecord | null;
  grain_checks_this_step: GrainCheckActivationRecord[];
  step_diagnostics: StepDiagnosticsRecord[];
}

function pushRacerDiagnostics(
  log: StepDiagnosticsRecord[],
  event: "racer_turn" | "racer_turn_retry",
  turnIndex: number,
  provenance: { model_id: string; model_provider: string },
  diagnostics: Awaited<ReturnType<typeof runRacerTurn>>["diagnostics"]
): void {
  log.push({
    event,
    turn_index: turnIndex,
    model_id: provenance.model_id,
    model_provider: provenance.model_provider,
    promptTokens: diagnostics?.promptTokens,
    cachedPromptTokens: diagnostics?.cachedPromptTokens,
    completionTokens: diagnostics?.completionTokens,
    reasoningTokens: diagnostics?.reasoningTokens,
    totalTokens: diagnostics?.totalTokens,
    latencyMs: diagnostics?.latencyMs,
    rawUsage: diagnostics?.rawUsage,
  });
}

async function appendRacerTurnGrain(
  game: GameRecord,
  initialOutput: Awaited<ReturnType<typeof runRacerTurn>>["output"],
  provenance: Awaited<ReturnType<typeof runRacerTurn>>["provenance"],
  racerState: ReturnType<typeof toRacerPublicState>,
  provider: "xai",
  grainChecks: GrainCheckActivationRecord[],
  stepDiagnostics: StepDiagnosticsRecord[],
  forceFinal: boolean
): Promise<GameRecord> {
  let turn = initialOutput;
  let flagged = false;
  let intentOutcome: GuessIntentOutcome | null = null;
  let preRevisionQuestion: string | null = null;

  // Unchanged from control: catch a disguised guess hiding inside a
  // "question" action before anything else happens.
  if (turn.action === "question" && turn.question_text) {
    const detection = detectGuess(turn.question_text);
    if (detection.flagged) {
      flagged = true;
      preRevisionQuestion = turn.question_text;
      await requireModelBudget("racer", "resolving flagged guess intent");
      const resolution = await resolveGuessIntent(racerState, turn.question_text, provider);
      intentOutcome = resolution.resolution;
      if (resolution.resolution === "confirm_guess") {
        turn = {
          ...turn,
          action: "guess" as const,
          guess_text: resolution.guess_text ?? turn.question_text,
          question_text: null,
        };
      } else if (resolution.revised_question) {
        turn = { ...turn, question_text: resolution.revised_question };
      }
    }
  }

  // ---------------------------------------------------------------------
  // THE GRAIN CHECK. Deterministic, pure, no model call. Fires on any guess
  // action, whether originally declared or produced by the guess-intent
  // resolution above.
  // ---------------------------------------------------------------------
  if (turn.action === "guess" && turn.guess_text) {
    const requiredGrain = deriveRequiredGrain(racerState.transcript).grain;
    const check = checkCandidateGrain(turn.guess_text, requiredGrain);

    const activation: GrainCheckActivationRecord = {
      turn_index: game.qa_log.length + 1,
      proposed_guess: turn.guess_text,
      required_grain: requiredGrain,
      decision: check.decision,
      grain_ok: check.grain_ok,
      reasoning: check.reasoning,
      retried: false,
      retry_guess: null,
      retry_decision: null,
    };

    if (check.decision === "block") {
      // ONE mechanical retry: re-invoke ordinary Racer-turn generation on
      // the SAME unchanged transcript, no injected hint. Whatever comes
      // back is accepted as this turn's action, whether or not it is
      // itself another guess — capped here so this driver can never loop.
      await requireModelBudget("racer", "retrying after a grain-check block");
      const retryResult = await runRacerTurn(racerState, { forceFinal, provider });
      pushRacerDiagnostics(
        stepDiagnostics,
        "racer_turn_retry",
        game.qa_log.length + 1,
        retryResult.provenance,
        retryResult.diagnostics
      );

      activation.retried = true;
      if (retryResult.output.action === "guess" && retryResult.output.guess_text) {
        activation.retry_guess = retryResult.output.guess_text;
        const retryCheck = checkCandidateGrain(retryResult.output.guess_text, requiredGrain);
        activation.retry_decision = retryCheck.decision;
      }

      turn = {
        ...retryResult.output,
        rationale:
          `[GRAIN CHECK BLOCKED prior guess "${turn.guess_text}" -- required_grain=${requiredGrain}, ` +
          `${check.reasoning} One mechanical retry follows, no hint given.] ${retryResult.output.rationale}`,
      };
      // Update provenance to the retry call's own, since that is the call
      // that actually produced the committed turn.
      provenance = retryResult.provenance;
    } else {
      turn = {
        ...turn,
        rationale: `[GRAIN CHECK ${check.decision.toUpperCase()} -- required_grain=${requiredGrain}, ${check.reasoning}] ${turn.rationale}`,
      };
    }

    grainChecks.push(activation);
  }
  // ---------------------------------------------------------------------

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

function toStatusGrain(
  game: GameRecord,
  spec: FixtureSpec,
  grainChecks: GrainCheckActivationRecord[],
  stepDiagnostics: StepDiagnosticsRecord[]
): GrokStepStatusGrain {
  const racerState = toRacerPublicState(game);
  const derived = deriveRequiredGrain(racerState.transcript);
  const establishedThisStep =
    grainChecks.length === 0 && derived.established_at_turn !== null && derived.established_at_turn === game.qa_log.length
      ? {
          turn_index: derived.established_at_turn,
          grain: derived.grain,
          probe: derived.probe,
          probe_question: derived.probe_question,
          probe_answer: derived.probe_answer,
        }
      : null;

  return {
    ...toStatus(game, spec),
    current_required_grain: derived.grain,
    grain_established_this_step: establishedThisStep,
    grain_checks_this_step: grainChecks,
    step_diagnostics: stepDiagnostics,
  };
}

/** Creates the game, secret, and generates the FIRST Racer turn only. */
export async function startGrokFixtureGrain(fixture: GrokFixtureKey): Promise<GrokStepStatusGrain> {
  const spec = SPECS[fixture];
  process.env.XAI_MODEL_RACER = spec.pinnedModel;

  const benchmarkRunId = randomUUID();
  const gameId = randomUUID();
  const grainBenchmarkCaseId = `${spec.benchmarkCaseId}-grain-state`;

  await createSecret(gameId, spec.target, spec.definition, spec.granularity, spec.modifiers);
  await lockSecret(gameId);

  let game: GameRecord = await createGame(gameId, {
    player_id: null,
    composer_player_id: null,
    racer_kind: "ai",
    racer_provider: spec.provider,
    racer_player_id: null,
    difficulty: spec.difficulty,
    phase: "questioning",
    max_questions: spec.maxQuestions,
    private_target: false,
    game_language: spec.gameLanguage,
    benchmark_case_id: grainBenchmarkCaseId,
    benchmark_run_id: benchmarkRunId,
  });

  const grainChecks: GrainCheckActivationRecord[] = [];
  const stepDiagnostics: StepDiagnosticsRecord[] = [];

  await requireModelBudget("racer", "generating the first Racer turn");
  const racerState = toRacerPublicState(game);
  const { output, provenance, diagnostics } = await runRacerTurn(racerState, {
    forceFinal: false,
    provider: spec.provider,
  });
  pushRacerDiagnostics(stepDiagnostics, "racer_turn", game.qa_log.length + 1, provenance, diagnostics);
  game = await appendRacerTurnGrain(game, output, provenance, racerState, spec.provider, grainChecks, stepDiagnostics, false);

  console.log(
    `[runGrokStepGrainState] START ${fixture} game_id=${gameId} benchmark_run_id=${benchmarkRunId} ` +
      `benchmark_case_id=${grainBenchmarkCaseId}`
  );
  return toStatusGrain(game, spec, grainChecks, stepDiagnostics);
}

/**
 * Advances one turn: answers the pending question, generates the next
 * Racer turn (or resolves, if the previous turn was a guess/concede) —
 * running the deterministic grain check on any guess before it commits.
 */
export async function stepGrokFixtureGrain(fixture: GrokFixtureKey, gameId: string): Promise<GrokStepStatusGrain> {
  const spec = SPECS[fixture];
  process.env.XAI_MODEL_RACER = spec.pinnedModel;

  let game = await getGame(gameId);
  if (!game) {
    throw new GrokStepError(`No such game_id=${gameId}`);
  }

  const grainChecks: GrainCheckActivationRecord[] = [];
  const stepDiagnostics: StepDiagnosticsRecord[] = [];

  if (game.phase === "resolving") {
    game = await resolveGame(game, gameId);
    console.log(`[runGrokStepGrainState] RESOLVED ${fixture} game_id=${gameId} result=${game.result}`);
    return toStatusGrain(game, spec, grainChecks, stepDiagnostics);
  }

  if (game.phase !== "questioning") {
    return toStatusGrain(game, spec, grainChecks, stepDiagnostics);
  }

  const pending = game.qa_log[game.qa_log.length - 1];
  if (!pending || pending.turn_type !== "question" || pending.composer_response !== null) {
    throw new GrokStepError(`Unexpected state: no unanswered question at the end of qa_log. game_id=${gameId}`);
  }

  await requireModelBudget("racer", "answering as the Composer");
  const composerStart = Date.now();
  const answerOutcome = await answerAsComposer({
    target: spec.target,
    definition: spec.definition,
    granularity: spec.granularity,
    modifiers: spec.modifiers,
    question: pending.question_text ?? "",
    qaLog: game.qa_log.slice(0, -1),
    questionsAsked: game.question_count,
    maxQuestions: game.max_questions,
    gameLanguage: spec.gameLanguage,
  });
  stepDiagnostics.push({
    event: "composer_answer",
    turn_index: pending.turn_index,
    model_id: null,
    model_provider: "anthropic",
    latencyMs: Date.now() - composerStart,
  });

  const answer: ComposerAnswer = answerOutcome.result.answer;
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
  const { output, provenance, diagnostics } = await runRacerTurn(racerState, { forceFinal, provider: spec.provider });
  pushRacerDiagnostics(stepDiagnostics, "racer_turn", game.qa_log.length + 1, provenance, diagnostics);
  game = await appendRacerTurnGrain(
    game,
    output,
    provenance,
    racerState,
    spec.provider,
    grainChecks,
    stepDiagnostics,
    forceFinal
  );

  console.log(
    `[runGrokStepGrainState] STEP ${fixture} game_id=${gameId} q=${game.question_count}/${game.max_questions} ` +
      `-> ${answer}, phase=${game.phase}, grain_checks_this_step=${grainChecks.length}`
  );
  return toStatusGrain(game, spec, grainChecks, stepDiagnostics);
}
