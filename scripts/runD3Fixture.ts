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
// M4 — held-out benchmark fixture ("heldout-01-mona-lisa"), run against
// whichever RACER_PROMPT_VERSION is currently exported from lib/prompts/racer.ts
// (racer/4.0.0 for the control pass, racer/4.1.0 for the candidate pass — see
// docs/m4-experiment-spec.md §6). SAME MACHINERY AS D-1/D-2
// (scripts/runBenchmarkFixture.ts, scripts/runD2Fixture.ts), one deliberate
// variable changed relative to both: the target itself.
//
// WHY THIS TARGET. Selected AFTER the racer/4.1.0 diff was written, not to
// motivate it — see docs/m4-experiment-spec.md §5. D-1 is a worn/carried
// object (generic_type); D-2 is a public monument/structure
// (specific_instance). "The Mona Lisa" is a specific fine-art object — a
// domain with its own dense sibling taxonomy (painting vs. sculpture vs.
// tapestry vs. manuscript; artist, era, museum, movement) capable of
// producing the same sibling-enumeration shape D-1 and D-2 both showed under
// a materially different subject, while remaining a public, unambiguous,
// non-private target exactly like both prior fixtures.
//
// THIS IS A SEPARATE FILE FROM runBenchmarkFixture.ts AND runD2Fixture.ts,
// NOT A PARAMETERIZED SHARED RUNNER, matching the project's established
// convention that each frozen fixture is its own individually-reviewed spec.
//
// IN-PROCESS ORCHESTRATION, IDENTICAL SHAPE TO D-1/D-2. Calls the same
// underlying application functions the real game-creation, turn, and resolve
// ROUTES call, directly, in one continuous function, rather than issuing HTTP
// requests back to any deployment. See runD2Fixture.ts's own header comment
// for the full accounting of why (Vercel Deployment Protection blocks a
// deployment's self-HTTP calls to its own routes) and what is deliberately
// not replicated (runValidator, entitlement/rate-limit checks, Composer-answer
// provenance on the turn row).
//
// WHAT THIS DOES NOT DO. It never sends D3_TARGET or D3_DEFINITION to
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
//   dev store (or a no-op corpus write) and nothing durable is produced.
//   Whichever way this is run, the resulting transcript (exported via
//   scripts/exportFullTranscript.ts, same as D-1/D-2) must be committed to
//   docs/m4-evidence/{control-rg-4.0.0,candidate-rg-4.1.0}/heldout-01-mona-lisa.transcript.json
//   depending on which RACER_PROMPT_VERSION was active for that run — per
//   docs/m4-experiment-spec.md §10/§11. Git, not the corpus database, is the
//   canonical scientific record for this fixture.
//
//   Run:  npx tsx scripts/runD3Fixture.ts
// ---------------------------------------------------------------------------

export const BENCHMARK_CASE_ID = "m4-heldout-01-mona-lisa";

// ---- Held-out 01 frozen fixture spec (approved) ----------------------------
// Every parameter below is identical to D-1/D-2's except D3_TARGET,
// D3_DEFINITION, and D3_GRANULARITY. See the header comment above for why.
export const D3_TARGET = "the Mona Lisa";
export const D3_DEFINITION =
  "The Mona Lisa: the specific portrait painting by Leonardo da Vinci, painted in the early 16th century, currently on permanent display in the Louvre Museum in Paris, France. This refers to that exact painting — not portraits in general, not any other painting by Leonardo, and not a print, poster, reproduction, or parody of it. There is only one original Mona Lisa; this is it.";
export const D3_GRANULARITY = "specific_instance" as const;
export const D3_MODIFIERS: string | null = null;
export const D3_DIFFICULTY = "medium" as const;
export const D3_MAX_QUESTIONS = 50;
export const D3_GAME_LANGUAGE = "en" as const;
export const D3_RACER_PROVIDER = "anthropic" as const;

// Safety net only — real play is bounded by max_questions/forceFinal below.
// This just stops a malfunctioning loop from running forever.
const MAX_TURN_ITERATIONS = D3_MAX_QUESTIONS + 5;

export interface D3FixtureResult {
  game_id: string;
  benchmark_case_id: string | null;
  benchmark_run_id: string | null;
  result: string | null;
  final_action: string | null;
  adjudicator_verdict: string | null;
  integrity_verdict: string | null;
  prompt_version: string | null;
}

/**
 * Every failure mode below throws a plain Error with a safe, secret-free
 * message. Callers decide what to do with it: the CLI (main(), below) prints
 * it and exits 1; the Preview-only route turns it into a JSON error response.
 */
export class D3FixtureError extends Error {}

function newLogEntry(turnIndex: number): QuestionLogEntry {
  // Mirrors app/api/game/[id]/turn/route.ts's newLogEntry() exactly (and
  // scripts/runBenchmarkFixture.ts's and runD2Fixture.ts's own copies) —
  // kept as a small, separate copy here rather than importing from any of
  // them: it is a quarantined, security-sensitive route
  // (scripts/check-isolation.mjs) that must never gain an inbound dependency
  // from anything outside its own narrow contract, and this factory is a
  // plain data literal with no logic to drift.
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
    throw new D3FixtureError(
      `Model call budget exhausted (${kind}) while ${context}. failedClosed=${budget.failedClosed}`
    );
  }
}

/**
 * Plays exactly one held-out ("the Mona Lisa") benchmark game end to end,
 * entirely in-process, tagged with BENCHMARK_CASE_ID, and returns the eight
 * fields needed to verify success — including prompt_version, so a caller
 * can confirm which guidance (racer/4.0.0 control or racer/4.1.0 candidate)
 * this specific run was actually played under. Throws D3FixtureError on any
 * failure; never retries internally.
 *
 * Takes no secret: BENCHMARK_INGRESS_SECRET's only remaining job is a
 * readiness gate ("is benchmark tagging configured at all?"), which the
 * caller (the route, or main() below) checks before ever calling this
 * function.
 */
export async function runD3Fixture(): Promise<D3FixtureResult> {
  const benchmarkRunId = randomUUID();

  console.log(`[runD3Fixture] benchmark_case_id: ${BENCHMARK_CASE_ID}`);
  console.log(`[runD3Fixture] racer_prompt_version: ${RACER_PROMPT_VERSION}`);
  console.log(
    `[runD3Fixture] target: "${D3_TARGET}" (${D3_GRANULARITY}, ${D3_DIFFICULTY}, ${D3_MAX_QUESTIONS}q, ${D3_GAME_LANGUAGE}, racer_provider=${D3_RACER_PROVIDER})`
  );

  // ---- Step 1: create the secret + game, tagged as this benchmark case -----
  const gameId = randomUUID();
  await createSecret(gameId, D3_TARGET, D3_DEFINITION, D3_GRANULARITY, D3_MODIFIERS);
  await lockSecret(gameId);

  let game: GameRecord = await createGame(gameId, {
    player_id: null,
    composer_player_id: null,
    racer_kind: "ai",
    racer_provider: D3_RACER_PROVIDER,
    racer_player_id: null,
    difficulty: D3_DIFFICULTY,
    phase: "questioning",
    max_questions: D3_MAX_QUESTIONS,
    // "the Mona Lisa" rests on no private/personal knowledge — a publicly
    // known artwork, same as D-1's "a backpack" and D-2's "the Eiffel Tower".
    private_target: false,
    game_language: D3_GAME_LANGUAGE,
    benchmark_case_id: BENCHMARK_CASE_ID,
    benchmark_run_id: benchmarkRunId,
  });

  console.log(`[runD3Fixture] Created game_id=${gameId}, benchmark_run_id=${benchmarkRunId}`);

  // ---- Step 2: first Racer move (no answer pending yet) ---------------------
  await requireModelBudget("racer", "generating the first Racer turn");
  {
    const racerState = toRacerPublicState(game);
    const { output, provenance } = await runRacerTurn(racerState, {
      forceFinal: false,
      provider: D3_RACER_PROVIDER,
    });
    game = await appendRacerTurn(game, output, provenance, racerState);
  }

  // ---- Step 3: drive the turn loop ------------------------------------------
  let iterations = 0;
  while (game.phase === "questioning") {
    iterations += 1;
    if (iterations > MAX_TURN_ITERATIONS) {
      throw new D3FixtureError(
        `Exceeded ${MAX_TURN_ITERATIONS} turn iterations without resolving. game_id=${gameId}`
      );
    }

    const pending = game.qa_log[game.qa_log.length - 1];
    if (!pending || pending.turn_type !== "question" || pending.composer_response !== null) {
      throw new D3FixtureError(
        `Unexpected state: no unanswered question at the end of qa_log. game_id=${gameId}`
      );
    }

    console.log(`[runD3Fixture] Q${pending.turn_index}: ${pending.question_text}`);

    // ---- Composer answers (in-process — the same function /api/game/[id]/ask
    // ---- already uses for AI-Composer games), standing in for what would
    // ---- otherwise be a human typing YES/NO/AMBIGUOUS. ------------------------
    await requireModelBudget("racer", "answering as the Composer");
    const answerOutcome = await answerAsComposer({
      target: D3_TARGET,
      definition: D3_DEFINITION,
      granularity: D3_GRANULARITY,
      modifiers: D3_MODIFIERS,
      question: pending.question_text ?? "",
      qaLog: game.qa_log.slice(0, -1),
      questionsAsked: game.question_count,
      maxQuestions: game.max_questions,
      gameLanguage: D3_GAME_LANGUAGE,
    });

    const answer: ComposerAnswer = answerOutcome.result.answer;
    console.log(
      `[runD3Fixture]   -> ${answer}${
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
      provider: D3_RACER_PROVIDER,
    });
    game = await appendRacerTurn(game, output, provenance, racerState);
  }

  console.log(`[runD3Fixture] Questioning ended. final_action=${game.final_action}, phase=${game.phase}`);

  // ---- Step 4: resolve (adjudication + integrity review + corpus write) ----
  const secret = await getSecretForAdjudication(gameId);
  if (!secret) {
    throw new D3FixtureError(`Secret unavailable at resolution for game_id=${gameId}`);
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

  console.log("[runD3Fixture] ===== RESOLVED =====");
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
      const resolution = await resolveGuessIntent(racerState, turn.question_text, D3_RACER_PROVIDER);
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
// belong here — never inside runD3Fixture, which a route handler also calls.
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[runD3Fixture] Missing required environment variable: ${name}`);
    console.error("[runD3Fixture] Aborting before any game is created.");
    process.exit(1);
  }
  return value.trim();
}

async function main(): Promise<void> {
  requiredEnv("BENCHMARK_INGRESS_SECRET"); // readiness gate only — see runD3Fixture's own comment
  requiredEnv("ANTHROPIC_API_KEY");

  try {
    const outcome = await runD3Fixture();
    console.log(
      "\nVerify in Neon with:\n" +
        `  SELECT * FROM corpus.games WHERE benchmark_case_id = '${outcome.benchmark_case_id}';`
    );
  } catch (err) {
    console.error(`[runD3Fixture] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Only run as a CLI when invoked directly (e.g. `npx tsx scripts/runD3Fixture.ts`),
// never when imported as a module by the Preview-only route.
if (require.main === module) {
  void main();
}
