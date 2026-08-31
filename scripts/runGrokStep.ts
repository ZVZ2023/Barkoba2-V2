/* eslint-disable no-console */
import { randomUUID } from "crypto";
import { createSecret, lockSecret, getSecretForAdjudication } from "../lib/secretStore";
import { createGame, getGame, saveGame } from "../lib/gameStore";
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
// V2.8.x — TURN-BY-TURN Grok fixture driver.
//
// WHY THIS EXISTS. scripts/runD{1,2}GrokCalibration.ts play an entire game
// inside one HTTP request/serverless invocation, exactly like every prior
// fixture runner in this project (D-1, D-2, held-out). That shape assumed a
// game finishes within Vercel's maxDuration ceiling (300s) — true for every
// prior Claude run (~3-4 minutes for 50 questions), false for Grok: the
// pinned reasoning model burned 755 reasoning tokens on its FIRST move alone
// (confirmed by the xAI smoke test), and a real D-1 calibration attempt
// hit FUNCTION_INVOCATION_TIMEOUT before resolving. This is a platform
// duration ceiling, not a bug in the whole-game runner.
//
// THE FIX, MIRRORING THE REAL APP'S OWN SHAPE. Production Barkóba never
// plays a whole game in one request either — app/api/game/[id]/turn/route.ts
// advances exactly one turn per call, with state persisted in Postgres/Redis
// between calls. This module does the same for the frozen Grok calibration
// (and later discovery) fixtures: startGrokFixture() creates the game and
// generates the first Racer turn; stepGrokFixture() answers the pending
// question and generates the next Racer turn, resolving the game once a
// guess/concede lands. The caller (scripts/runPreviewBenchmark.mjs, looping
// over short HTTP calls) drives it to completion — each individual call
// comfortably fits inside 300s.
//
// SAME TARGETS, SAME GOVERNANCE. Reuses the exact target/definition/
// granularity/budget/language constants scripts/runD{1,2}GrokCalibration.ts
// already define and export — not redeclared here, imported, so the two
// entry points (whole-game, stepped) can never silently drift onto
// different fixture specs.
// ---------------------------------------------------------------------------

import {
  BENCHMARK_CASE_ID as D1_BENCHMARK_CASE_ID,
  D1_TARGET,
  D1_DEFINITION,
  D1_GRANULARITY,
  D1_MODIFIERS,
  D1_DIFFICULTY,
  D1_MAX_QUESTIONS,
  D1_GAME_LANGUAGE,
  D1_RACER_PROVIDER,
  PINNED_MODEL as D1_PINNED_MODEL,
} from "./runD1GrokCalibration";
import {
  BENCHMARK_CASE_ID as D2_BENCHMARK_CASE_ID,
  D2_TARGET,
  D2_DEFINITION,
  D2_GRANULARITY,
  D2_MODIFIERS,
  D2_DIFFICULTY,
  D2_MAX_QUESTIONS,
  D2_GAME_LANGUAGE,
  D2_RACER_PROVIDER,
  PINNED_MODEL as D2_PINNED_MODEL,
} from "./runD2GrokCalibration";

export type GrokFixtureKey =
  | "d1-grok"
  | "d2-grok"
  | "disc-01-wristwatch"
  | "disc-02-guitar"
  | "disc-03-great-sphinx"
  | "disc-04-titanic"
  | "disc-05-platypus"
  | "disc-06-golden-gate-bridge"
  | "disc-07-rosetta-stone"
  | "disc-08-chess"
  | "disc-09-rubber-duck"
  | "disc-10-antarctica";

interface FixtureSpec {
  benchmarkCaseId: string;
  target: string;
  definition: string;
  granularity: "generic_type" | "specific_instance";
  modifiers: string | null;
  difficulty: "medium";
  maxQuestions: number;
  gameLanguage: "en";
  provider: "xai";
  pinnedModel: string;
}

const SPECS: Record<GrokFixtureKey, FixtureSpec> = {
  "d1-grok": {
    benchmarkCaseId: D1_BENCHMARK_CASE_ID,
    target: D1_TARGET,
    definition: D1_DEFINITION,
    granularity: D1_GRANULARITY,
    modifiers: D1_MODIFIERS,
    difficulty: D1_DIFFICULTY,
    maxQuestions: D1_MAX_QUESTIONS,
    gameLanguage: D1_GAME_LANGUAGE,
    provider: D1_RACER_PROVIDER,
    pinnedModel: D1_PINNED_MODEL,
  },
  "d2-grok": {
    benchmarkCaseId: D2_BENCHMARK_CASE_ID,
    target: D2_TARGET,
    definition: D2_DEFINITION,
    granularity: D2_GRANULARITY,
    modifiers: D2_MODIFIERS,
    difficulty: D2_DIFFICULTY,
    maxQuestions: D2_MAX_QUESTIONS,
    gameLanguage: D2_GAME_LANGUAGE,
    provider: D2_RACER_PROVIDER,
    pinnedModel: D2_PINNED_MODEL,
  },

  // -------------------------------------------------------------------------
  // V2.8.x — 10-game discovery batch. Frozen per
  // docs/v2.8-grok-baseline/discovery-10-fixture-spec.md BEFORE game 1 ran;
  // target/definition text here is byte-identical to that spec, which is the
  // durable record if the two are ever compared. All 10 share difficulty,
  // budget, language, provider, and pinned model with the calibration pair.
  // -------------------------------------------------------------------------
  "disc-01-wristwatch": {
    benchmarkCaseId: "v2.8-discovery-01-wristwatch",
    target: "a wristwatch",
    definition:
      "A wristwatch as a general kind of object: a small timekeeping device worn around the wrist, secured by a band or strap. This refers to wristwatches as a category — any ordinary wristwatch counts, regardless of brand, whether analog or digital, mechanical or electronic, smart or simple. Not one particular wristwatch.",
    granularity: "generic_type",
    modifiers: null,
    difficulty: "medium",
    maxQuestions: 50,
    gameLanguage: "en",
    provider: "xai",
    pinnedModel: "grok-4.20-0309-reasoning",
  },
  "disc-02-guitar": {
    benchmarkCaseId: "v2.8-discovery-02-guitar",
    target: "a guitar",
    definition:
      "A guitar as a general kind of object: a stringed musical instrument with a neck and a body, played by plucking or strumming its strings, typically having six strings. This refers to guitars as a category — any ordinary guitar counts, regardless of brand, whether acoustic or electric, regardless of body shape or number of strings. Not one particular guitar.",
    granularity: "generic_type",
    modifiers: null,
    difficulty: "medium",
    maxQuestions: 50,
    gameLanguage: "en",
    provider: "xai",
    pinnedModel: "grok-4.20-0309-reasoning",
  },
  "disc-03-great-sphinx": {
    benchmarkCaseId: "v2.8-discovery-03-great-sphinx",
    target: "the Great Sphinx of Giza",
    definition:
      "The Great Sphinx of Giza: the specific, one-of-a-kind limestone statue of a reclining creature with a lion's body and a human head, located on the Giza plateau in Egypt, near the Great Pyramids. This refers to that exact statue — not sphinxes in general, not any other sphinx statue elsewhere in the world, and not a replica or scale model. There is only one Great Sphinx of Giza; this is it.",
    granularity: "specific_instance",
    modifiers: null,
    difficulty: "medium",
    maxQuestions: 50,
    gameLanguage: "en",
    provider: "xai",
    pinnedModel: "grok-4.20-0309-reasoning",
  },
  "disc-04-titanic": {
    benchmarkCaseId: "v2.8-discovery-04-titanic",
    target: "the Titanic",
    definition:
      "The Titanic: the specific British passenger ocean liner that sank in the North Atlantic Ocean in April 1912 after striking an iceberg on her maiden voyage. This refers to that exact ship — not ocean liners in general, not any other ship, and not a replica, model, or a film/dramatization about it. There is only one RMS Titanic; this is it.",
    granularity: "specific_instance",
    modifiers: null,
    difficulty: "medium",
    maxQuestions: 50,
    gameLanguage: "en",
    provider: "xai",
    pinnedModel: "grok-4.20-0309-reasoning",
  },
  "disc-05-platypus": {
    benchmarkCaseId: "v2.8-discovery-05-platypus",
    target: "a platypus",
    definition:
      "A platypus as a general kind of living creature: a semi-aquatic, egg-laying mammal native to eastern Australia, with a duck-like bill, webbed feet, and a beaver-like tail. This refers to platypuses as a category — any ordinary platypus counts. Not one particular platypus.",
    granularity: "generic_type",
    modifiers: null,
    difficulty: "medium",
    maxQuestions: 50,
    gameLanguage: "en",
    provider: "xai",
    pinnedModel: "grok-4.20-0309-reasoning",
  },
  "disc-06-golden-gate-bridge": {
    benchmarkCaseId: "v2.8-discovery-06-golden-gate-bridge",
    target: "the Golden Gate Bridge",
    definition:
      "The Golden Gate Bridge: the specific suspension bridge spanning the Golden Gate strait, connecting San Francisco to Marin County, California, completed in 1937 and known for its Art Deco towers painted 'International Orange.' This refers to that exact bridge — not suspension bridges in general, not any other bridge, and not a replica or model. There is only one Golden Gate Bridge; this is it.",
    granularity: "specific_instance",
    modifiers: null,
    difficulty: "medium",
    maxQuestions: 50,
    gameLanguage: "en",
    provider: "xai",
    pinnedModel: "grok-4.20-0309-reasoning",
  },
  "disc-07-rosetta-stone": {
    benchmarkCaseId: "v2.8-discovery-07-rosetta-stone",
    target: "the Rosetta Stone",
    definition:
      "The Rosetta Stone: the specific granodiorite stele inscribed with a decree in three scripts (hieroglyphic, Demotic, and Ancient Greek), discovered in 1799 near the town of Rosetta in Egypt, now held in the British Museum. This refers to that exact stone — not inscribed stelae in general, not any other Egyptian artifact, and not a replica or cast. There is only one Rosetta Stone; this is it.",
    granularity: "specific_instance",
    modifiers: null,
    difficulty: "medium",
    maxQuestions: 50,
    gameLanguage: "en",
    provider: "xai",
    pinnedModel: "grok-4.20-0309-reasoning",
  },
  "disc-08-chess": {
    benchmarkCaseId: "v2.8-discovery-08-chess",
    target: "the game of chess",
    definition:
      "The game of chess as a specific, singular thing: the two-player strategy board game played on an 8x8 checkered board with a defined set of pieces (king, queen, rooks, bishops, knights, pawns), each with fixed legal moves, where the objective is to checkmate the opponent's king. This refers to chess itself, as codified by its standard rules — not board games in general, not one specific chess match or tournament, not a physical chess set as an object, and not a single chess piece. There is only one game of chess; this is it.",
    granularity: "specific_instance",
    modifiers: null,
    difficulty: "medium",
    maxQuestions: 50,
    gameLanguage: "en",
    provider: "xai",
    pinnedModel: "grok-4.20-0309-reasoning",
  },
  "disc-09-rubber-duck": {
    benchmarkCaseId: "v2.8-discovery-09-rubber-duck",
    target: "a rubber duck",
    definition:
      "A rubber duck as a general kind of object: a small, buoyant, duck-shaped toy typically made of rubber or soft plastic, commonly used as a bath toy for children. This refers to rubber ducks as a category — any ordinary rubber duck counts, regardless of size, exact color, or brand. Not one particular rubber duck.",
    granularity: "generic_type",
    modifiers: null,
    difficulty: "medium",
    maxQuestions: 50,
    gameLanguage: "en",
    provider: "xai",
    pinnedModel: "grok-4.20-0309-reasoning",
  },
  "disc-10-antarctica": {
    benchmarkCaseId: "v2.8-discovery-10-antarctica",
    target: "Antarctica",
    definition:
      "Antarctica: the specific, one-of-a-kind continent located at the southernmost point of the Earth, almost entirely covered by ice, surrounding the South Pole. This refers to that exact continent — not continents in general, not the Arctic (a different, northern region that is not a continent), and not any specific research station or expedition on it. There is only one Antarctica; this is it.",
    granularity: "specific_instance",
    modifiers: null,
    difficulty: "medium",
    maxQuestions: 50,
    gameLanguage: "en",
    provider: "xai",
    pinnedModel: "grok-4.20-0309-reasoning",
  },
};

export class GrokStepError extends Error {}

export interface GrokStepStatus {
  game_id: string;
  benchmark_case_id: string | null;
  benchmark_run_id: string | null;
  phase: string;
  question_count: number;
  max_questions: number;
  done: boolean;
  result: string | null;
  final_action: string | null;
  adjudicator_verdict: string | null;
  integrity_verdict: string | null;
  prompt_version: string | null;
  pinned_model: string;
  last_question: string | null;
  last_answer: string | null;
}

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
    throw new GrokStepError(`Model call budget exhausted (${kind}) while ${context}. failedClosed=${budget.failedClosed}`);
  }
}

async function appendRacerTurn(
  game: GameRecord,
  initialOutput: Awaited<ReturnType<typeof runRacerTurn>>["output"],
  provenance: Awaited<ReturnType<typeof runRacerTurn>>["provenance"],
  racerState: ReturnType<typeof toRacerPublicState>,
  provider: "xai"
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
      const resolution = await resolveGuessIntent(racerState, turn.question_text, provider);
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

async function resolveGame(game: GameRecord, gameId: string): Promise<GameRecord> {
  const secret = await getSecretForAdjudication(gameId);
  if (!secret) {
    throw new GrokStepError(`Secret unavailable at resolution for game_id=${gameId}`);
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

  const result = deriveResult({ finalAction: game.final_action, adjudicator: adjudicatorVerdict, integrity: integrityVerdict });

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
  return game;
}

function toStatus(game: GameRecord, spec: FixtureSpec): GrokStepStatus {
  const last = game.qa_log[game.qa_log.length - 1];
  return {
    game_id: game.game_id,
    benchmark_case_id: game.benchmark_case_id,
    benchmark_run_id: game.benchmark_run_id,
    phase: game.phase,
    question_count: game.question_count,
    max_questions: game.max_questions,
    done: game.phase === "complete",
    result: game.result,
    final_action: game.final_action,
    adjudicator_verdict: game.adjudicator_verdict,
    integrity_verdict: game.integrity_verdict,
    prompt_version: RACER_PROMPT_VERSION,
    pinned_model: spec.pinnedModel,
    last_question: last?.question_text ?? null,
    last_answer: last?.composer_response ?? null,
  };
}

/** Creates the game, secret, and generates the FIRST Racer turn only. */
export async function startGrokFixture(fixture: GrokFixtureKey): Promise<GrokStepStatus> {
  const spec = SPECS[fixture];
  process.env.XAI_MODEL_RACER = spec.pinnedModel;

  const benchmarkRunId = randomUUID();
  const gameId = randomUUID();

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
    benchmark_case_id: spec.benchmarkCaseId,
    benchmark_run_id: benchmarkRunId,
  });

  await requireModelBudget("racer", "generating the first Racer turn");
  const racerState = toRacerPublicState(game);
  const { output, provenance } = await runRacerTurn(racerState, { forceFinal: false, provider: spec.provider });
  game = await appendRacerTurn(game, output, provenance, racerState, spec.provider);

  console.log(`[runGrokStep] START ${fixture} game_id=${gameId} benchmark_run_id=${benchmarkRunId}`);
  return toStatus(game, spec);
}

/**
 * Advances one turn: answers the pending question, generates the next
 * Racer turn (or resolves, if the previous turn was a guess/concede).
 */
export async function stepGrokFixture(fixture: GrokFixtureKey, gameId: string): Promise<GrokStepStatus> {
  const spec = SPECS[fixture];
  process.env.XAI_MODEL_RACER = spec.pinnedModel;

  let game = await getGame(gameId);
  if (!game) {
    throw new GrokStepError(`No such game_id=${gameId}`);
  }

  if (game.phase === "resolving") {
    game = await resolveGame(game, gameId);
    console.log(`[runGrokStep] RESOLVED ${fixture} game_id=${gameId} result=${game.result}`);
    return toStatus(game, spec);
  }

  if (game.phase !== "questioning") {
    return toStatus(game, spec);
  }

  const pending = game.qa_log[game.qa_log.length - 1];
  if (!pending || pending.turn_type !== "question" || pending.composer_response !== null) {
    throw new GrokStepError(`Unexpected state: no unanswered question at the end of qa_log. game_id=${gameId}`);
  }

  await requireModelBudget("racer", "answering as the Composer");
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
  const { output, provenance } = await runRacerTurn(racerState, { forceFinal, provider: spec.provider });
  game = await appendRacerTurn(game, output, provenance, racerState, spec.provider);

  console.log(
    `[runGrokStep] STEP ${fixture} game_id=${gameId} q=${game.question_count}/${game.max_questions} -> ${answer}, phase=${game.phase}`
  );
  return toStatus(game, spec);
}
