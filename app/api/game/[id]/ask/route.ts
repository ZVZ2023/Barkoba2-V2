import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getGame, saveGame } from "@/lib/gameStore";
import { getSecretForAnswering } from "@/lib/secretStore";
import { answerAsComposer } from "@/lib/prompts/composerAnswer";
import { consumeModelCall } from "@/lib/callBudget";
import type { GameRecord, QuestionLogEntry } from "@/lib/types";

// ---------------------------------------------------------------------------
// 0.6.x — the human Racer's turn. The inverse of /turn.
//
// WHY THIS IS A SIBLING ROUTE RATHER THAN A FLAG ON /turn:
//
// /turn's contract is "prior answer in, next Racer action out" — it exists to
// call a model for the Racer's move. This route's contract is the mirror image:
// "question in, Composer's answer out". The two differ in which participant the
// server has to synthesise, which is the one thing role inversion actually
// changes. Branching inside one handler would mean a route whose contract
// depends on a stored field, and every future reader would have to hold both
// games in their head to change either.
//
// Everything underneath is shared: the same store, the same secret module, the
// same budget, the same result table, the same adjudication and integrity
// review. One engine, two turn shapes.
//
// PERMITTED SECRET CALL SITE — reads the locked target on every turn so the
// Composer answers against the record rather than its own recollection.
// ---------------------------------------------------------------------------

export const maxDuration = 60;

interface AskBody {
  question?: string;
  /** Set instead of `question` when the player commits their single guess. */
  guess?: string;
  concede?: boolean;
}

function newEntry(turnIndex: number): QuestionLogEntry {
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
    ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(),
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
  };
}

function respond(game: GameRecord, status = 200) {
  return NextResponse.json({ game }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const game = await getGame(params.id);
  if (!game) {
    return NextResponse.json(
      { error: "not_found", message: "No such game, or it has expired." },
      { status: 404 }
    );
  }

  if (game.racer_kind !== "human") {
    return NextResponse.json(
      {
        error: "wrong_mode",
        message: "This game has an AI Racer. Use /turn.",
        game,
      },
      { status: 409 }
    );
  }

  if (game.phase !== "questioning") {
    return NextResponse.json(
      {
        error: "wrong_phase",
        message: `This game is in phase "${game.phase}" and is not accepting questions.`,
        game,
      },
      { status: 409 }
    );
  }

  let body: AskBody;
  try {
    body = (await req.json()) as AskBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body must be JSON." },
      { status: 400 }
    );
  }

  // -------------------------------------------------------------------------
  // Declared guess or concession. A human Racer states intent directly, so the
  // Guess Detector — which exists to infer an AI's intent from its prose — has
  // nothing to do here. See DESIGN-NOTES §1.
  // -------------------------------------------------------------------------
  if (body.concede === true || (body.guess && body.guess.trim())) {
    const conceding = body.concede === true;
    const entry = newEntry(game.qa_log.length + 1);
    entry.turn_type = conceding ? "concede" : "guess";
    entry.guess_text = conceding ? null : body.guess!.trim();
    entry.racer_output_raw = JSON.stringify({
      source: "human_racer",
      action: entry.turn_type,
      guess_text: entry.guess_text,
    });

    game.qa_log.push(entry);
    game.phase = "resolving";
    game.final_action = entry.turn_type;
    game.final_guess_text = entry.guess_text;

    await saveGame(game);
    return respond(game);
  }

  const question = (body.question || "").trim();
  if (!question) {
    return NextResponse.json(
      { error: "missing_question", message: "Ask a question, make a guess, or concede." },
      { status: 400 }
    );
  }

  if (game.question_count >= game.max_questions) {
    return NextResponse.json(
      {
        error: "out_of_questions",
        message: "No questions left. Make your guess, or concede.",
        game,
      },
      { status: 409 }
    );
  }

  const secret = await getSecretForAnswering(game.game_id);
  if (!secret) {
    return NextResponse.json(
      {
        error: "secret_unavailable",
        message: "This game's target is no longer available, so it cannot continue.",
        game,
      },
      { status: 410 }
    );
  }

  const budget = await consumeModelCall("racer");
  if (!budget.allowed) {
    return NextResponse.json(
      {
        error: budget.failedClosed ? "budget_unavailable" : "budget_exhausted",
        message: budget.failedClosed
          ? "Unable to verify the call budget right now. Your game is safe — try again shortly."
          : "Barkóba has hit its global daily limit. Your game is safe — try again tomorrow.",
        game,
      },
      { status: budget.failedClosed ? 503 : 429 }
    );
  }

  let answer;
  try {
    answer = await answerAsComposer({
      target: secret.target,
      definition: secret.private_clarification,
      question,
      qaLog: game.qa_log,
      questionsAsked: game.question_count,
      maxQuestions: game.max_questions,
      clueMode: game.clue_mode ?? "none",
      gameLanguage: game.game_language,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] Composer answer failed:", err);
    // Nothing is recorded, so the question is not spent. The player can retry.
    return NextResponse.json(
      {
        error: "composer_unavailable",
        message: "Could not answer that right now. Your question was not used — please try again.",
        game,
      },
      { status: 502 }
    );
  }

  const entry = newEntry(game.qa_log.length + 1);
  entry.question_text = question;
  entry.composer_response = answer.answer;
  entry.ambiguous_explanation = answer.ambiguous_explanation;
  entry.clue_text = answer.clue_text;
  entry.racer_output_raw = JSON.stringify(answer);

  game.qa_log.push(entry);
  // Every question costs one, whatever the answer — the 0.3.4.0 rule, unchanged.
  game.question_count += 1;

  await saveGame(game);
  return respond(game);
}
