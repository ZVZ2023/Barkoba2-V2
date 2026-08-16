import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getGame, saveGame } from "@/lib/gameStore";
import { getSecretForAnswering } from "@/lib/secretStore";
import { answerAsComposer } from "@/lib/prompts/composerAnswer";
import { judgeQuestionEdit } from "@/lib/prompts/questionEdit";
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
  /**
   * Correct the most recent question in place. Accepted only when the edit
   * repairs how the question was written rather than what it asks; an accepted
   * edit costs no extra question and keeps its turn number.
   */
  edit_turn_index?: number;
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
      { error: "not_found", message: "Nincs ilyen játék, vagy már lejárt." },
      { status: 404 }
    );
  }

  if (game.racer_kind !== "human") {
    return NextResponse.json(
      {
        error: "wrong_mode",
        message: "Ebben a játékban az AI kérdez. Használd a /turn végpontot.",
        game,
      },
      { status: 409 }
    );
  }

  if (game.phase !== "questioning") {
    return NextResponse.json(
      {
        error: "wrong_phase",
        message: `Ez a játék "${game.phase}" állapotban van, nem fogad több kérdést.`,
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
      { error: "invalid_body", message: "A kérés törzsének JSON formátumúnak kell lennie." },
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

  // -------------------------------------------------------------------------
  // Question correction. Mobile autocorrect should not cost a question.
  // -------------------------------------------------------------------------
  if (typeof body.edit_turn_index === "number") {
    const edited = (body.question || "").trim();
    if (!edited) {
      return NextResponse.json(
        { error: "missing_question", message: "Add meg a javított kérdést.", game },
        { status: 400 }
      );
    }

    const last = game.qa_log[game.qa_log.length - 1];
    // Only the most recent question is editable. Anything earlier would mean
    // re-answering a turn the player has already reasoned onward from.
    if (
      !last ||
      last.turn_index !== body.edit_turn_index ||
      last.turn_type !== "question" ||
      !last.question_text
    ) {
      return NextResponse.json(
        {
          error: "not_editable",
          message: "Csak a legutóbbi kérdésedet lehet javítani.",
          game,
        },
        { status: 409 }
      );
    }

    const original = last.question_text;

    const judgeBudget = await consumeModelCall("racer");
    if (!judgeBudget.allowed) {
      return NextResponse.json(
        {
          error: judgeBudget.failedClosed ? "budget_unavailable" : "budget_exhausted",
          message: "Most nem sikerült ellenőrizni a javítást. A játékod megvan.",
          game,
        },
        { status: judgeBudget.failedClosed ? 503 : 429 }
      );
    }

    let verdict;
    try {
      verdict = await judgeQuestionEdit({
        original,
        edited,
        gameLanguage: game.game_language,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[barkoba] question edit check failed:", err);
      return NextResponse.json(
        {
          error: "edit_check_unavailable",
          message: "Nem sikerült ellenőrizni a javítást. Semmi nem változott — próbáld újra.",
          game,
        },
        { status: 502 }
      );
    }

    if (!verdict.same_intent) {
      // Rejected: recorded on the entry, nothing else touched. The original
      // question and its answer stand, and a new question costs one.
      last.edit_status = "rejected";
      last.edit_reason = verdict.reasoning;
      await saveGame(game);
      return NextResponse.json(
        {
          error: "edit_changes_intent",
          message:
            "That asks something different, so it counts as a new question. Your original question and answer stand.",
          game,
        },
        { status: 409 }
      );
    }

    const secretForEdit = await getSecretForAnswering(game.game_id);
    if (!secretForEdit) {
      return NextResponse.json(
        { error: "secret_unavailable", message: "Ennek a játéknak a titka már nem elérhető.", game },
        { status: 410 }
      );
    }

    const answerBudget = await consumeModelCall("racer");
    if (!answerBudget.allowed) {
      return NextResponse.json(
        {
          error: answerBudget.failedClosed ? "budget_unavailable" : "budget_exhausted",
          message: "Most nem sikerült újra megválaszolni. A játékod megvan.",
          game,
        },
        { status: answerBudget.failedClosed ? 503 : 429 }
      );
    }

    let reanswer;
    try {
      reanswer = await answerAsComposer({
        target: secretForEdit.target,
        definition: secretForEdit.private_clarification,
        granularity: secretForEdit.granularity ?? "generic_type",
        modifiers: secretForEdit.modifiers,
        question: edited,
        // The corrected turn is excluded, so the Composer re-answers against
        // the history as it stood before it — not against its own first reply.
        qaLog: game.qa_log.slice(0, -1),
        questionsAsked: Math.max(0, game.question_count - 1),
        maxQuestions: game.max_questions,
        gameLanguage: game.game_language,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[barkoba] re-answer after edit failed:", err);
      return NextResponse.json(
        {
          error: "composer_unavailable",
          message: "Nem sikerült újra megválaszolni. Az eredeti kérdésed és válaszod marad érvényben.",
          game,
        },
        { status: 502 }
      );
    }

    // Same turn number, no extra question spent.
    last.original_question_text = last.original_question_text ?? original;
    last.question_text = edited;
    last.edit_status = "accepted";
    last.edit_reason = verdict.reasoning;
    last.composer_response = reanswer.result.answer;
    last.ambiguous_explanation = reanswer.result.ambiguous_explanation;
    // Only the participant's own structured output — provenance rides in its
    // own fields so raw_output keeps meaning exactly what it claims to.
    last.racer_output_raw = JSON.stringify(reanswer.result);
    last.answered_at = new Date().toISOString();
    last.model_id = reanswer.provenance.model_id;
    last.model_provider = reanswer.provenance.model_provider;
    last.prompt_version = reanswer.provenance.prompt_version;

    await saveGame(game);
    return respond(game);
  }

  const question = (body.question || "").trim();
  if (!question) {
    return NextResponse.json(
      { error: "missing_question", message: "Tegyél fel egy kérdést, tippelj, vagy add fel." },
      { status: 400 }
    );
  }

  if (game.question_count >= game.max_questions) {
    return NextResponse.json(
      {
        error: "out_of_questions",
        message: "Elfogytak a kérdések. Tippelj, vagy add fel.",
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
        message: "Ennek a játéknak a titka már nem elérhető, így nem folytatható.",
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
          ? "Most nem tudjuk ellenőrizni a keretet. A játékod megvan — próbáld újra hamarosan."
          : "A Barkóba elérte a napi globális határát. A játékod megvan — próbáld újra holnap.",
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
      granularity: secret.granularity ?? "generic_type",
      modifiers: secret.modifiers,
      question,
      qaLog: game.qa_log,
      questionsAsked: game.question_count,
      maxQuestions: game.max_questions,
      gameLanguage: game.game_language,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] Composer answer failed:", err);
    // Nothing is recorded, so the question is not spent. The player can retry.
    return NextResponse.json(
      {
        error: "composer_unavailable",
        message: "Most nem sikerült válaszolni. A kérdésed nem lett felhasználva — próbáld újra.",
        game,
      },
      { status: 502 }
    );
  }

  const entry = newEntry(game.qa_log.length + 1);
  entry.question_text = question;
  entry.composer_response = answer.result.answer;
  entry.ambiguous_explanation = answer.result.ambiguous_explanation;
  entry.racer_output_raw = JSON.stringify(answer.result);
  // The human Racer asked and the model answered in one request, so creation
  // and answering are the same instant here. Recorded anyway: the field must
  // mean "when the answer landed" in every mode, or it means nothing.
  entry.answered_at = new Date().toISOString();
  entry.model_id = answer.provenance.model_id;
  entry.model_provider = answer.provenance.model_provider;
  entry.prompt_version = answer.provenance.prompt_version;

  game.qa_log.push(entry);
  // Every question costs one, whatever the answer — the 0.3.4.0 rule, unchanged.
  game.question_count += 1;

  await saveGame(game);
  return respond(game);
}
