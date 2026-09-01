/* eslint-disable no-console */
import { randomUUID } from "crypto";
import { createSecret, lockSecret, getSecretForAdjudication } from "../lib/secretStore";
import { createGame, getGame, saveGame } from "../lib/gameStore";
import { toRacerPublicState } from "../lib/racerState";
import { runRacerTurn, resolveGuessIntent } from "../lib/prompts/racer";
import { answerAsComposer } from "../lib/prompts/composerAnswer";
import { detectGuess } from "../lib/guessDetector";
import {
  runCandidateValidationGate,
  CANDIDATE_VALIDATION_GATE_VERSION,
} from "../lib/prompts/candidateValidationGate";
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
// V2.8.x — CANDIDATE-VALIDATION-GATE turn-by-turn driver.
//
// A SIBLING of scripts/runGrokStep.ts, not a parameterized generalization of
// it. Deliberately duplicates the ~40 lines of per-turn commit logic
// (disguised-guess detection, qa_log append, phase transition) rather than
// threading a boolean through the control file, for one reason: the file
// that produced the frozen Grok discovery-batch evidence
// (docs/v2.8-grok-baseline/) must never be touched by this experiment, even
// additively, so that evidence's provenance stays exactly what it was when
// it was collected. See docs/DESIGN-NOTES.md's "one-fixture-per-file"
// convention note — this is the same reasoning applied one level up.
//
// Reuses SPECS, requireModelBudget, resolveGame, toStatus and newLogEntry
// from runGrokStep.ts UNMODIFIED (imported, not copied) specifically so
// fixture target/definition/granularity/budget/language text is
// byte-identical between control and candidate runs — see
// docs/v2.8-grok-baseline/candidate-validation-gate-spec.md's validity
// requirements.
//
// THE GATE HOOK. lib/prompts/candidateValidationGate.ts's own header comment
// explains why the check itself needs a model call. This file is where that
// call is actually made load-bearing: appendRacerTurnCandidate() refuses to
// commit an "guess" action to qa_log until the gate has run, and can replace
// it with the gate's own replacement_question — the runtime enforcement the
// experiment spec calls for, not merely another instruction in the prompt.
//
// TELEMETRY. Every xAI-side model call this driver makes (Racer turns, gate
// checks, guess-intent resolutions) is timestamped and its diagnostics
// captured into stepDiagnostics, returned in the HTTP status so the
// orchestrating script (scripts/runPreviewBenchmark.mjs) can accumulate a
// full per-game telemetry record without any server-side persistence change
// — see docs/v2.8-grok-baseline/candidate-validation-gate-spec.md §Phase 2
// for why this could not be retrofitted into corpus.game_turns itself
// (QuestionLogEntry has no token/cost columns; adding them is a schema
// migration this experiment does not need and was not asked to make).
// ---------------------------------------------------------------------------

export interface GateActivationRecord {
  turn_index: number;
  proposed_guess: string;
  decision: "allow" | "block";
  grain_ok: boolean;
  unused_discriminator: string | null;
  hard_evidence_violation: string | null;
  replacement_question: string | null;
  reasoning: string;
  gate_version: string;
  model_id: string;
  model_provider: string;
}

export interface StepDiagnosticsRecord {
  event: "racer_turn" | "gate_check" | "guess_intent_resolution" | "composer_answer";
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

export interface GrokStepStatusCandidate extends GrokStepStatus {
  candidate_gate_version: string;
  candidate_benchmark_case_id: string | null;
  gate_activations_this_step: GateActivationRecord[];
  step_diagnostics: StepDiagnosticsRecord[];
}

function pushRacerDiagnostics(
  log: StepDiagnosticsRecord[],
  turnIndex: number,
  provenance: { model_id: string; model_provider: string },
  diagnostics: Awaited<ReturnType<typeof runRacerTurn>>["diagnostics"]
): void {
  log.push({
    event: "racer_turn",
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

async function appendRacerTurnCandidate(
  game: GameRecord,
  initialOutput: Awaited<ReturnType<typeof runRacerTurn>>["output"],
  provenance: Awaited<ReturnType<typeof runRacerTurn>>["provenance"],
  racerState: ReturnType<typeof toRacerPublicState>,
  provider: "xai",
  model: string,
  gateActivations: GateActivationRecord[],
  stepDiagnostics: StepDiagnosticsRecord[]
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

  // -------------------------------------------------------------------------
  // THE CANDIDATE-VALIDATION GATE. Covers both an originally-declared guess
  // and one that only became a guess via the guess-intent resolution above —
  // either way, nothing reaches qa_log as a "guess" turn without passing
  // through here first.
  // -------------------------------------------------------------------------
  if (turn.action === "guess" && turn.guess_text) {
    await requireModelBudget("racer", "running the candidate-validation gate");
    const gate = await runCandidateValidationGate(racerState, turn.guess_text, provider, model);

    gateActivations.push({
      turn_index: game.qa_log.length + 1,
      proposed_guess: turn.guess_text,
      decision: gate.decision,
      grain_ok: gate.grain_ok,
      unused_discriminator: gate.unused_discriminator,
      hard_evidence_violation: gate.hard_evidence_violation,
      replacement_question: gate.replacement_question,
      reasoning: gate.reasoning,
      gate_version: gate.gate_version,
      model_id: gate.model_id,
      model_provider: gate.model_provider,
    });
    stepDiagnostics.push({
      event: "gate_check",
      turn_index: game.qa_log.length + 1,
      model_id: gate.model_id,
      model_provider: gate.model_provider,
      promptTokens: gate.diagnostics?.promptTokens,
      cachedPromptTokens: gate.diagnostics?.cachedPromptTokens,
      completionTokens: gate.diagnostics?.completionTokens,
      reasoningTokens: gate.diagnostics?.reasoningTokens,
      totalTokens: gate.diagnostics?.totalTokens,
      latencyMs: gate.diagnostics?.latencyMs,
      rawUsage: gate.diagnostics?.rawUsage,
    });

    if (gate.decision === "block") {
      const blockedGuess = turn.guess_text;
      turn = {
        ...turn,
        action: "question" as const,
        question_text: gate.replacement_question,
        guess_text: null,
        rationale:
          `[CANDIDATE GATE BLOCKED guess "${blockedGuess}" — grain_ok=${gate.grain_ok}, ` +
          `unused_discriminator=${gate.unused_discriminator ? "yes" : "no"}, ` +
          `evidence_violation=${gate.hard_evidence_violation ?? "none"}. ${gate.reasoning}] ${turn.rationale}`,
      };
      // Deliberately not re-run through detectGuess: the gate's
      // replacement_question is schema-constrained to be a narrowing
      // question, never a candidate name. See candidateValidationGate.ts.
    } else {
      turn = {
        ...turn,
        rationale:
          `[CANDIDATE GATE ALLOWED guess "${turn.guess_text}" — grain_ok=true, ` +
          `no unused discriminator, no evidence violation] ${turn.rationale}`,
      };
    }
  }
  // -------------------------------------------------------------------------

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

function toStatusCandidate(
  game: GameRecord,
  spec: FixtureSpec,
  gateActivations: GateActivationRecord[],
  stepDiagnostics: StepDiagnosticsRecord[]
): GrokStepStatusCandidate {
  return {
    ...toStatus(game, spec),
    candidate_gate_version: CANDIDATE_VALIDATION_GATE_VERSION,
    candidate_benchmark_case_id: game.benchmark_case_id,
    gate_activations_this_step: gateActivations,
    step_diagnostics: stepDiagnostics,
  };
}

/** Creates the game, secret, and generates the FIRST Racer turn only. */
export async function startGrokFixtureCandidate(fixture: GrokFixtureKey): Promise<GrokStepStatusCandidate> {
  const spec = SPECS[fixture];
  process.env.XAI_MODEL_RACER = spec.pinnedModel;

  const benchmarkRunId = randomUUID();
  const gameId = randomUUID();
  // Suffixed so a corpus query can separate candidate-gate games from the
  // control games recorded under the same base fixture id — both share
  // prompt_version "racer/4.0.0" (the guidance text is unchanged), so
  // benchmark_case_id is the only field that distinguishes them.
  const candidateBenchmarkCaseId = `${spec.benchmarkCaseId}-candidate-gate`;

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
    benchmark_case_id: candidateBenchmarkCaseId,
    benchmark_run_id: benchmarkRunId,
  });

  const gateActivations: GateActivationRecord[] = [];
  const stepDiagnostics: StepDiagnosticsRecord[] = [];

  await requireModelBudget("racer", "generating the first Racer turn");
  const racerState = toRacerPublicState(game);
  const { output, provenance, diagnostics } = await runRacerTurn(racerState, {
    forceFinal: false,
    provider: spec.provider,
  });
  pushRacerDiagnostics(stepDiagnostics, game.qa_log.length + 1, provenance, diagnostics);
  game = await appendRacerTurnCandidate(
    game,
    output,
    provenance,
    racerState,
    spec.provider,
    spec.pinnedModel,
    gateActivations,
    stepDiagnostics
  );

  console.log(
    `[runGrokStepCandidate] START ${fixture} game_id=${gameId} benchmark_run_id=${benchmarkRunId} ` +
      `benchmark_case_id=${candidateBenchmarkCaseId}`
  );
  return toStatusCandidate(game, spec, gateActivations, stepDiagnostics);
}

/**
 * Advances one turn: answers the pending question, generates the next
 * Racer turn (or resolves, if the previous turn was a guess/concede) —
 * running the candidate-validation gate on any guess before it commits.
 */
export async function stepGrokFixtureCandidate(
  fixture: GrokFixtureKey,
  gameId: string
): Promise<GrokStepStatusCandidate> {
  const spec = SPECS[fixture];
  process.env.XAI_MODEL_RACER = spec.pinnedModel;

  let game = await getGame(gameId);
  if (!game) {
    throw new GrokStepError(`No such game_id=${gameId}`);
  }

  const gateActivations: GateActivationRecord[] = [];
  const stepDiagnostics: StepDiagnosticsRecord[] = [];

  if (game.phase === "resolving") {
    game = await resolveGame(game, gameId);
    console.log(`[runGrokStepCandidate] RESOLVED ${fixture} game_id=${gameId} result=${game.result}`);
    return toStatusCandidate(game, spec, gateActivations, stepDiagnostics);
  }

  if (game.phase !== "questioning") {
    return toStatusCandidate(game, spec, gateActivations, stepDiagnostics);
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
    // Composer stays Anthropic permanently (see lib/providers/index.ts) and
    // that adapter does not populate token/cost diagnostics — latency is
    // still measured here, wall-clock, so game-duration accounting is
    // complete even though per-call Composer cost is not.
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
  const { output, provenance, diagnostics } = await runRacerTurn(racerState, {
    forceFinal,
    provider: spec.provider,
  });
  pushRacerDiagnostics(stepDiagnostics, game.qa_log.length + 1, provenance, diagnostics);
  game = await appendRacerTurnCandidate(
    game,
    output,
    provenance,
    racerState,
    spec.provider,
    spec.pinnedModel,
    gateActivations,
    stepDiagnostics
  );

  console.log(
    `[runGrokStepCandidate] STEP ${fixture} game_id=${gameId} q=${game.question_count}/${game.max_questions} ` +
      `-> ${answer}, phase=${game.phase}, gate_activations_this_step=${gateActivations.length}`
  );
  return toStatusCandidate(game, spec, gateActivations, stepDiagnostics);
}
