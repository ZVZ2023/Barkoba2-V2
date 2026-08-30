/* eslint-disable no-console */
import { randomUUID } from "crypto";
import { createSecret, lockSecret, getSecretForAdjudication } from "../lib/secretStore";
import { createGame, saveGame } from "../lib/gameStore";
import { toRacerPublicState } from "../lib/racerState";
import { runRacerTurn, resolveGuessIntent } from "../lib/prompts/racer";
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
// M1 — D-1 benchmark fixture runner ("Generic Backpack", racer/4.0.0).
//
// IN-PROCESS ORCHESTRATION. Calls the same underlying application functions
// the real game-creation, turn, and resolve ROUTES call — createSecret,
// lockSecret, createGame, toRacerPublicState, runRacerTurn, resolveGuessIntent,
// detectGuess, answerAsComposer, getSecretForAdjudication, runAdjudicator,
// runIntegrityReview, deriveResult, saveGame — directly, in one continuous
// function, rather than issuing HTTP requests back to any deployment.
//
// WHY THIS REPLACED THE EARLIER SELF-HTTP DESIGN. The route that runs this
// (app/api/internal/benchmark/d1-generic-backpack/route.ts) sits inside a
// Vercel Preview deployment that has Deployment Protection enabled. That
// protection applies to ALL traffic to the deployment's hostname — including
// a server-side fetch() from the deployment calling back into its own sibling
// routes. A real invocation attempt confirmed this: the self-call to
// /api/game/create was rejected with HTTP 401 by Vercel's edge layer before
// ever reaching the route's own code. There is no way to make an authenticated
// self-HTTP call from inside a protected deployment without a bypass token
// this code has no legitimate way to hold. In-process calls have no such
// boundary to cross: they are ordinary function calls inside the same running
// serverless function, using the exact same resolved environment (Redis,
// Neon, Anthropic) the route itself already has.
//
// WHAT IS DELIBERATELY NOT REPLICATED, AND WHY IT'S SAFE TO SKIP:
//   - runValidator(): exists to catch a spontaneous human submission's
//     problems (missing referent, needs clarification). D-1's target and
//     definition are frozen and already reviewed; running it would cost a
//     model call to validate text nobody is submitting fresh.
//   - Entitlement/rate-limit checks (canStartGame, consumeForGame,
//     checkGameCreationRateLimit): these are ACCOUNT/PLAYER concerns —
//     Play Credit balance, per-IP abuse limits. This run has no player
//     (player_id stays null) and is gated by the route's own Preview-only +
//     confirmation-body + Deployment Protection controls instead. Skipping
//     these does not touch the real routes at all — they are simply not
//     called by this in-process path, exactly as they were never called by
//     the earlier self-HTTP path's target either (that path hit them via
//     the real /api/game/create, but always as an anonymous, unauthenticated
//     "none" identity, so the practical entitlement outcome — one
//     complimentary game — was already inert for this purpose).
//   - Composer-answer provenance (model_id/model_provider/prompt_version) is
//     intentionally NOT written onto the turn row for the answered question.
//     The real /api/game/[id]/turn route has no field for this either — for
//     an AI Racer game, a turn's model_id/model_provider/prompt_version
//     columns are dedicated to the RACER's own provenance, set once when
//     that turn's question/guess was generated, and answering it later never
//     touches those fields. Writing Composer provenance into the same column
//     would silently change what that column means for this one benchmark
//     game relative to every other AI-Racer game already in the corpus.
//
// WHAT THIS DOES NOT DO. It never sends D1_TARGET or D1_DEFINITION to
// runRacerTurn or resolveGuessIntent — those only ever receive
// toRacerPublicState(game), the same narrowing boundary every real game uses.
// The target only ever reaches createSecret (at creation), answerAsComposer
// (answering, in-process), and getSecretForAdjudication (at resolution) —
// the exact same three call sites a real game's target would reach.
//
// ---------------------------------------------------------------------------
// CLI USAGE — REQUIRED ENVIRONMENT (read here, never hard-coded, never printed):
//
//   BENCHMARK_INGRESS_SECRET  Used only to tag the created game (game-level
//                             benchmark_case_id/benchmark_run_id) — the same
//                             purpose it has always had.
//   ANTHROPIC_API_KEY         answerAsComposer(), runRacerTurn() (Anthropic
//                             seat), runAdjudicator(), runIntegrityReview()
//                             all call Anthropic directly from this process.
//
//   A local CLI run ALSO needs real UPSTASH_REDIS_REST_URL/TOKEN and
//   DATABASE_URL in the environment to actually persist a game and write a
//   corpus row — without them, createGame/saveGame fall back to an in-memory
//   dev store (or a no-op corpus write) and nothing durable is produced. The
//   evidentiary M1 run is expected to happen via the Preview route, which
//   already has all of these resolved by Vercel; this CLI path exists for
//   local mechanics testing only.
//
//   Run:  npx tsx scripts/runBenchmarkFixture.ts
// ---------------------------------------------------------------------------

export const BENCHMARK_CASE_ID = "m1-d1-generic-backpack";

// ---- D-1 frozen fixture spec (approved) ------------------------------------
export const D1_TARGET = "a backpack";
export const D1_DEFINITION =
  "A backpack as a general kind of object: a bag with two straps, worn on the back, used by a person to carry belongings hands-free. This refers to backpacks as a category — any ordinary backpack counts, regardless of brand, size, color, material, or specific use (school, travel, hiking, laptop, etc.). Not one particular backpack.";
export const D1_GRANULARITY = "generic_type" as const;
export const D1_MODIFIERS: string | null = null;
export const D1_DIFFICULTY = "medium" as const;
export const D1_MAX_QUESTIONS = 50;
export const D1_GAME_LANGUAGE = "en" as const;
export const D1_RACER_PROVIDER = "anthropic" as const;

// Safety net only — real play is bounded by max_questions/forceFinal below.
// This just stops a malfunctioning loop from running forever.
const MAX_TURN_ITERATIONS = D1_MAX_QUESTIONS + 5;

export interface D1FixtureResult {
  game_id: string;
  benchmark_case_id: string | null;
  benchmark_run_id: string | null;
  result: string | null;
  final_action: string | null;
  adjudicator_verdict: string | null;
  integrity_verdict: string | null;
}

/**
 * Every failure mode below throws a plain Error with a safe, secret-free
 * message. Callers decide what to do with it: the CLI (main(), below) prints
 * it and exits 1; the Preview-only route turns it into a JSON error response.
 */
export class D1FixtureError extends Error {}

function newLogEntry(turnIndex: number): QuestionLogEntry {
  // Mirrors app/api/game/[id]/turn/route.ts's newLogEntry() exactly. Kept as
  // a small, separate copy here rather than importing from that file: it is
  // a quarantined, security-sensitive route (scripts/check-isolation.mjs)
  // that must never gain an inbound dependency from anything outside its own
  // narrow contract, and this factory is a plain data literal with no logic
  // to drift.
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
    throw new D1FixtureError(
      `Model call budget exhausted (${kind}) while ${context}. failedClosed=${budget.failedClosed}`
    );
  }
}

/**
 * Plays exactly one D-1 ("Generic Backpack") benchmark game end to end,
 * entirely in-process, tagged with BENCHMARK_CASE_ID, and returns the seven
 * fields needed to verify success. Throws D1FixtureError on any failure;
 * never retries internally.
 *
 * Takes no secret: BENCHMARK_INGRESS_SECRET's only remaining job is a
 * readiness gate ("is benchmark tagging configured at all?"), which the
 * caller (the route, or main() below) checks before ever calling this
 * function — there is nothing left to compare its value against, since
 * benchmark_case_id/benchmark_run_id are now set directly on the created
 * game record rather than carried through a request header.
 */
export async function runD1Fixture(): Promise<D1FixtureResult> {
  const benchmarkRunId = randomUUID();

  console.log(`[runD1Fixture] benchmark_case_id: ${BENCHMARK_CASE_ID}`);
  console.log(
    `[runD1Fixture] target: "${D1_TARGET}" (${D1_GRANULARITY}, ${D1_DIFFICULTY}, ${D1_MAX_QUESTIONS}q, ${D1_GAME_LANGUAGE}, racer_provider=${D1_RACER_PROVIDER})`
  );

  // ---- Step 1: create the secret + game, tagged as this benchmark case -----
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
    // "a backpack" rests on no private/personal knowledge — an ordinary,
    // publicly-known category, same as every other frozen dev fixture target.
    private_target: false,
    game_language: D1_GAME_LANGUAGE,
    benchmark_case_id: BENCHMARK_CASE_ID,
    benchmark_run_id: benchmarkRunId,
  });

  console.log(`[runD1Fixture] Created game_id=${gameId}, benchmark_run_id=${benchmarkRunId}`);

  // ---- Step 2: first Racer move (no answer pending yet) ---------------------
  await requireModelBudget("racer", "generating the first Racer turn");
  {
    const racerState = toRacerPublicState(game);
    const { output, provenance } = await runRacerTurn(racerState, {
      forceFinal: false,
      provider: D1_RACER_PROVIDER,
    });
    game = await appendRacerTurn(game, output, provenance, racerState);
  }

  // ---- Step 3: drive the turn loop ------------------------------------------
  let iterations = 0;
  while (game.phase === "questioning") {
    iterations += 1;
    if (iterations > MAX_TURN_ITERATIONS) {
      throw new D1FixtureError(
        `Exceeded ${MAX_TURN_ITERATIONS} turn iterations without resolving. game_id=${gameId}`
      );
    }

    const pending = game.qa_log[game.qa_log.length - 1];
    if (!pending || pending.turn_type !== "question" || pending.composer_response !== null) {
      throw new D1FixtureError(
        `Unexpected state: no unanswered question at the end of qa_log. game_id=${gameId}`
      );
    }

    console.log(`[runD1Fixture] Q${pending.turn_index}: ${pending.question_text}`);

    // ---- Composer answers (in-process — the same function /api/game/[id]/ask
    // ---- already uses for AI-Composer games), standing in for what would
    // ---- otherwise be a human typing YES/NO/AMBIGUOUS. ------------------------
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
      `[runD1Fixture]   -> ${answer}${
        answerOutcome.result.ambiguous_explanation ? ` (${answerOutcome.result.ambiguous_explanation})` : ""
      }`
    );

    // Record the answer exactly as /api/game/[id]/turn's Step 1 does — never
    // touching the turn's model_id/model_provider/prompt_version, which are
    // reserved for the RACER's own provenance on that same row.
    pending.composer_response = answer;
    pending.answered_at = new Date().toISOString();
    if (answer === "AMBIGUOUS") {
      pending.ambiguous_explanation = answerOutcome.result.ambiguous_explanation ?? null;
      game.ambiguous_count += 1;
    } else {
      pending.ambiguous_explanation = null;
    }
    game.question_count += 1;

    // ---- The Racer's next move, on narrowed public state only — mirrors
    // ---- /api/game/[id]/turn's Step 3 exactly. --------------------------------
    const forceFinal = game.question_count >= game.max_questions;
    await requireModelBudget("racer", "generating the next Racer turn");
    const racerState = toRacerPublicState(game);
    const { output, provenance } = await runRacerTurn(racerState, {
      forceFinal,
      provider: D1_RACER_PROVIDER,
    });
    game = await appendRacerTurn(game, output, provenance, racerState);
  }

  console.log(`[runD1Fixture] Questioning ended. final_action=${game.final_action}, phase=${game.phase}`);

  // ---- Step 4: resolve (adjudication + integrity review + corpus write) ----
  const secret = await getSecretForAdjudication(gameId);
  if (!secret) {
    throw new D1FixtureError(`Secret unavailable at resolution for game_id=${gameId}`);
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

  // DECLASSIFICATION — identical to /api/game/[id]/resolve's single seam.
  game.revealed_target = secret.target;
  game.revealed_definition = secret.private_clarification;
  game.revealed_granularity = secret.granularity;
  game.revealed_modifiers = secret.modifiers;
  game.revealed_locked_at = secret.locked_at;
  game.phase = "complete";

  await saveGame(game); // this is what writes the corpus rows (recordGameState, inside saveGame)

  console.log("[runD1Fixture] ===== RESOLVED =====");
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
  };
}

/**
 * Appends one Racer turn to `game` — the Guess Detector flow and turn-entry
 * construction, mirroring app/api/game/[id]/turn/route.ts's Steps 4-5 exactly
 * — and persists the result. Extracted only to avoid writing this twice (the
 * first-turn call site and the loop's call site); not a route re-implementation,
 * just this function's own control flow factored once.
 */
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

// ---------------------------------------------------------------------------
// CLI entry point only. Reading env vars, printing, and process.exit all
// belong here — never inside runD1Fixture, which a route handler also calls.
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[runBenchmarkFixture] Missing required environment variable: ${name}`);
    console.error("[runBenchmarkFixture] Aborting before any game is created.");
    process.exit(1);
  }
  return value.trim();
}

async function main(): Promise<void> {
  requiredEnv("BENCHMARK_INGRESS_SECRET"); // readiness gate only — see runD1Fixture's own comment
  requiredEnv("ANTHROPIC_API_KEY");

  try {
    const outcome = await runD1Fixture();
    console.log(
      "\nVerify in Neon with:\n" +
        `  SELECT * FROM corpus.games WHERE benchmark_case_id = '${outcome.benchmark_case_id}';`
    );
  } catch (err) {
    console.error(`[runBenchmarkFixture] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Only run as a CLI when invoked directly (e.g. `npx tsx scripts/runBenchmarkFixture.ts`),
// never when imported as a module by the Preview-only route.
if (require.main === module) {
  void main();
}
