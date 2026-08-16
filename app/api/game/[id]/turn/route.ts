import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getGame, saveGame } from "@/lib/gameStore";
import { toRacerPublicState } from "@/lib/racerState";
import { pendingClueRequest } from "@/lib/clueCredits";
import { runRacerTurn, resolveGuessIntent } from "@/lib/prompts/racer";
import { detectGuess } from "@/lib/guessDetector";
import { consumeModelCall } from "@/lib/callBudget";
import { env } from "@/lib/env";
import type {
  ComposerAnswer,
  GameRecord,
  GuessIntentOutcome,
  QuestionLogEntry,
} from "@/lib/types";

// This route deliberately imports neither lib/secretStore.ts nor anything that
// does. It runs the entire question loop on public state alone.

export const maxDuration = 60;

interface TurnBody {
  answer?: ComposerAnswer;
  ambiguous_explanation?: string;
}

const VALID_ANSWERS: ComposerAnswer[] = ["YES", "NO", "AMBIGUOUS"];

function respond(game: GameRecord, status = 200) {
  return NextResponse.json({ game }, { status });
}

/** The most recent question awaiting a Composer answer, if any. */
function findPendingEntry(game: GameRecord): QuestionLogEntry | null {
  for (let i = game.qa_log.length - 1; i >= 0; i -= 1) {
    const entry = game.qa_log[i];
    if (!entry) continue;
    if (entry.turn_type !== "question") return null;
    return entry.composer_response === null ? entry : null;
  }
  return null;
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

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const gameId = params.id;

  const game = await getGame(gameId);
  if (!game) {
    return NextResponse.json(
      { error: "not_found", message: "Nincs ilyen játék, vagy már lejárt." },
      { status: 404 }
    );
  }

  if (game.phase !== "questioning") {
    return NextResponse.json(
      {
        error: "wrong_phase",
        message: `Ez a játék "${game.phase}" állapotban van, nem fogad több kört.`,
        game,
      },
      { status: 409 }
    );
  }

  let body: TurnBody = {};
  if (req.headers.get("content-length") !== "0") {
    try {
      body = (await req.json()) as TurnBody;
    } catch {
      body = {};
    }
  }

  const answer = body.answer;
  if (answer !== undefined && !VALID_ANSWERS.includes(answer)) {
    return NextResponse.json(
      {
        error: "invalid_answer",
        message: `A válasznak ezek egyikének kell lennie: ${VALID_ANSWERS.join(", ")}.`,
      },
      { status: 400 }
    );
  }

  const pending = findPendingEntry(game);

  // -------------------------------------------------------------------------
  // Step 1 — record the Composer's answer, if one was supplied.
  // -------------------------------------------------------------------------
  if (answer) {
    if (!pending) {
      return NextResponse.json(
        {
          error: "no_pending_question",
          message: "Nincs megválaszolatlan kérdés.",
          game,
        },
        { status: 409 }
      );
    }

    pending.composer_response = answer;
    // V2.5 — `timestamp` is when the Racer's question was created; this is when
    // the human answered it. Without both, the only derivable quantity was the
    // interval to the next turn, which also contains the model call, so think
    // time and model latency were inseparable.
    pending.answered_at = new Date().toISOString();

    if (answer === "AMBIGUOUS") {
      pending.ambiguous_explanation = (body.ambiguous_explanation || "").trim() || null;
      // Unlimited in COUNT — there is no quota — but not free. ambiguous_count
      // is tracked separately as the input to later abuse analysis, never as a
      // discount on the Racer's budget.
      game.ambiguous_count += 1;
    } else {
      pending.ambiguous_explanation = null;
    }

    // Every question the Racer asks costs one of its 20, whatever answer comes
    // back. YES, NO and AMBIGUOUS are all worth exactly one question.
    game.question_count += 1;
  } else if (pending) {
    // -----------------------------------------------------------------------
    // Idempotency guard. A pending question with no answer supplied means a
    // duplicate request — React strict-mode double-effect, a double click, a
    // client retry. Return what is already there instead of burning a model
    // call and desynchronising question_count. KV has no compare-and-swap, so
    // this guard is the only thing standing between a double-fire and a
    // corrupted log.
    // -----------------------------------------------------------------------
    return respond(game);
  }

  // -------------------------------------------------------------------------
  // Step 1b — an outstanding clue request blocks the Racer.
  //
  // When the Racer spends a credit it is waiting on a human, exactly as it
  // waits on an answer. findPendingEntry only recognises unanswered QUESTIONS,
  // so without this the Racer would take another turn immediately and the
  // Composer would never get to write the clue.
  // -------------------------------------------------------------------------
  if (pendingClueRequest(game)) {
    await saveGame(game);
    return respond(game);
  }

  // -------------------------------------------------------------------------
  // Step 2 — global spend ceiling. Checked before every model call, fails closed.
  // -------------------------------------------------------------------------
  const budget = await consumeModelCall("racer");
  if (!budget.allowed) {
    await saveGame(game); // the answer recorded above must not be lost
    return NextResponse.json(
      {
        error: budget.failedClosed ? "budget_unavailable" : "budget_exhausted",
        message: budget.failedClosed
          ? "Most nem tudjuk ellenőrizni a keretet. Próbáld újra hamarosan."
          : "A Barkóba elérte az AI-körökre szánt napi globális határát. Próbáld újra holnap.",
        game,
      },
      { status: budget.failedClosed ? 503 : 429 }
    );
  }

  // -------------------------------------------------------------------------
  // Step 3 — the Racer's turn, on narrowed public state only.
  // -------------------------------------------------------------------------
  const forceFinal = game.question_count >= game.max_questions;
  const racerState = toRacerPublicState(game);

  let turn;
  let provenance;
  try {
    const racerResult = await runRacerTurn(racerState, { forceFinal });
    turn = racerResult.output;
    provenance = racerResult.provenance;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] Racer call failed:", err);
    await saveGame(game); // preserve the recorded answer
    return NextResponse.json(
      {
        error: "racer_unavailable",
        message: "Az ellenfeled most nem tudott lépni. Próbáld újra.",
        game,
      },
      { status: 502 }
    );
  }

  // -------------------------------------------------------------------------
  // Step 4 — Guess Detector, then internal intent resolution if it fires.
  //
  // The flag is never surfaced to the human Composer. In V1 the Racer is an AI
  // with forced structured output, so the party whose intent is in question is
  // the one re-prompted. See docs/DESIGN-NOTES.md for the Phase 2 human-Racer
  // variant, which is documented and deliberately not built.
  // -------------------------------------------------------------------------
  let flagged = false;
  let intentOutcome: GuessIntentOutcome | null = null;
  // V2.5 — the question as the Racer FIRST emitted it.
  //
  // Both resolution branches below destroy it: confirm_guess nulls
  // question_text, continue_questioning replaces it with the revision. Until
  // 2.5.0.0 the corpus recorded the second question as though it were the
  // first, next to guess_detector_flagged=true with no evidence of what was
  // actually flagged — which made the §18-B question/guess-boundary benchmark
  // unmeasurable by construction. Captured BEFORE either branch can run.
  let preRevisionQuestion: string | null = null;

  if (turn.action === "question" && turn.question_text) {
    const detection = detectGuess(turn.question_text);
    if (detection.flagged) {
      flagged = true;
      preRevisionQuestion = turn.question_text;

      const resolutionBudget = await consumeModelCall("racer");
      if (!resolutionBudget.allowed) {
        // Budget ran out mid-turn. Fail safe for the player: treat the flagged
        // question as a question rather than silently converting it to a guess.
        intentOutcome = "continue_questioning";
      } else {
        try {
          const resolution = await resolveGuessIntent(racerState, turn.question_text);
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
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[barkoba] Guess-intent resolution failed:", err);
          // Same fail-safe: an unresolved flag stays a question.
          intentOutcome = "continue_questioning";
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 5 — append the turn and transition.
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
  // V2.5 — who produced this turn, under which prompt. The provenance of the
  // PRIMARY turn call; the guess-intent sub-call above uses the same model and
  // is deliberately not given a second provenance triple.
  entry.model_id = provenance.model_id;
  entry.model_provider = provenance.model_provider;
  entry.prompt_version = provenance.prompt_version;
  // latency_ms and the other dormant fields stay null. They are schema-ready,
  // not implemented — populating them is a separate, explicit decision.

  game.qa_log.push(entry);

  if (turn.action === "guess" || turn.action === "concede") {
    game.phase = "resolving";
    game.final_action = turn.action;
    game.final_guess_text = turn.guess_text;
  }

  await saveGame(game);
  return respond(game);
}
