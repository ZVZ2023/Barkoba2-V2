import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getGame, saveGame } from "@/lib/gameStore";
import { playerIdFromHeaders } from "@/lib/playerIdentity";
import { awaitingRacer, isHumanVsHuman, requireSeat } from "@/lib/seats";
import { pendingQuestionIndex, revisionOf } from "@/lib/gameView";
import type { ComposerAnswer, GameRecord, QuestionLogEntry } from "@/lib/types";

// ---------------------------------------------------------------------------
// V2.3 — the Human↔Human turn route. NO AI IS INVOKED HERE.
//
// WHY A SIBLING ROUTE RATHER THAN A FLAG ON /ask OR /turn:
//
//   /ask  unconditionally calls answerAsComposer — the AI answers the question.
//   /turn unconditionally calls the AI Racer for the next move.
//
// Neither contract fits two humans, and the codebase already states the rule
// (see the header of /turn): a route whose contract depends on a stored field
// forces every future reader to hold both games in their head. So this is a
// third sibling, and it does exactly one thing — record what a human did.
//
// It deliberately does not import lib/secretStore.ts. A Human↔Human turn needs
// no target: the Composer supplies the answer, and correctness is judged later
// by the existing Adjudicator and Integrity Review at /resolve. That is also
// why the AI referee needed no new code.
//
// Two actions, one route, because they are the same transition from opposite
// seats: the Racer adds a question (or ends the game), the Composer answers the
// one outstanding question.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

interface Body {
  action: "question" | "answer" | "guess" | "concede" | "hint";
  question?: string;
  guess?: string;
  hint?: string;
  answer?: ComposerAnswer;
  ambiguous_explanation?: string;
  /**
   * The revision the client composed this turn against. Optional, and when
   * present it is the stale-turn guard: a backgrounded tab that wakes up and
   * submits against state that has since moved is rejected rather than allowed
   * to overwrite. Redis has no compare-and-swap, so this is a validation, not a
   * lock — but it closes the realistic case, which is a slow human, not a race.
   */
  expected_revision?: number;
}

const VALID_ANSWERS: ComposerAnswer[] = ["YES", "NO", "AMBIGUOUS"];
const MAX_TEXT = 500;

function respond(game: GameRecord, status = 200) {
  return NextResponse.json({ ok: true, revision: revisionOf(game) }, { status });
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
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
  };
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const playerId = playerIdFromHeaders(req.headers);

  const game = await getGame(params.id);
  if (!game) {
    return NextResponse.json(
      { error: "not_found", message: "Nincs ilyen játék, vagy már lejárt." },
      { status: 404 }
    );
  }
  if (!isHumanVsHuman(game)) {
    return NextResponse.json({ error: "wrong_mode" }, { status: 409 });
  }
  if (game.phase !== "questioning") {
    return NextResponse.json(
      { error: "wrong_phase", message: `A játék "${game.phase}" állapotban van.` },
      { status: 409 }
    );
  }
  if (awaitingRacer(game)) {
    return NextResponse.json(
      { error: "awaiting_racer", message: "Még nem csatlakozott a másik játékos." },
      { status: 409 }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (typeof body.expected_revision === "number" && body.expected_revision !== revisionOf(game)) {
    return NextResponse.json(
      {
        error: "stale_turn",
        message: "Közben történt valami. Frissítettük az állást.",
        revision: revisionOf(game),
      },
      { status: 409 }
    );
  }

  const pending = pendingQuestionIndex(game);

  // -------------------------------------------------------------------------
  // V2.3.1 — Composer's voluntary hint. "You are barking up the wrong tree."
  //
  // DELIBERATELY REUSES turn_type "clue" RATHER THAN ADDING A TYPE. A clue is
  // already defined as help flowing from the Composer to the Racer that costs
  // no question and never answers one — which is exactly this. What differed
  // in 0.9.8.0 was who ASKED for it, not what it is.
  //
  // Reuse also keeps the corpus uniform and needs no migration: the turn_type
  // CHECK constraint in migration 0001 already permits 'clue', and
  // gameCorpus.actorFor stamps it `human_composer` here versus `ai_composer`
  // for an AI clue — so the two remain distinguishable in analysis without a
  // new column.
  //
  // NOT gated on your_turn. The moment worth intervening is usually just after
  // an answer, when the other player has started down an irrelevant branch.
  // It spends no question and no clue credit, and changes nobody's turn.
  // -------------------------------------------------------------------------
  if (body.action === "hint") {
    const seatCheck = requireSeat(game, playerId, "composer");
    if (!seatCheck.ok) {
      return NextResponse.json(
        { error: seatCheck.error, message: "Csak a gondolkodó súghat." },
        { status: 403 }
      );
    }

    const text = (body.hint || "").trim().slice(0, MAX_TEXT);
    if (!text) return NextResponse.json({ error: "missing_hint" }, { status: 400 });

    // Stored verbatim. The Composer owns the target and may say what they
    // like about it; the only way the secret reaches the Racer here is if the
    // Composer types it themselves, which is their decision to make.
    const entry = newEntry(game.qa_log.length + 1);
    entry.turn_type = "clue";
    entry.question_text = null;
    entry.clue_text = text;
    game.qa_log.push(entry);

    await saveGame(game);
    return respond(game);
  }

  // -------------------------------------------------------------------------
  // Composer: answer the one outstanding question.
  // -------------------------------------------------------------------------
  if (body.action === "answer") {
    const seat = requireSeat(game, playerId, "composer");
    if (!seat.ok) {
      return NextResponse.json(
        { error: seat.error, message: "Ez nem a te lépésed." },
        { status: 403 }
      );
    }
    if (pending === null) {
      return NextResponse.json(
        { error: "no_pending_question", message: "Nincs megválaszolatlan kérdés." },
        { status: 409 }
      );
    }
    const answer = body.answer;
    if (!answer || !VALID_ANSWERS.includes(answer)) {
      return NextResponse.json({ error: "invalid_answer" }, { status: 400 });
    }

    const entry = game.qa_log.find((e) => e.turn_index === pending);
    if (!entry) return NextResponse.json({ error: "no_pending_question" }, { status: 409 });

    entry.composer_response = answer;
    entry.ambiguous_explanation =
      answer === "AMBIGUOUS"
        ? (body.ambiguous_explanation || "").trim().slice(0, MAX_TEXT) || null
        : null;

    // The 0.3.4.0 rule, unchanged: every answered question costs one, whatever
    // the answer. AMBIGUOUS is unlimited in count but never free.
    game.question_count += 1;
    if (answer === "AMBIGUOUS") game.ambiguous_count += 1;

    await saveGame(game);
    return respond(game);
  }

  // -------------------------------------------------------------------------
  // Racer: ask, guess, or concede.
  // -------------------------------------------------------------------------
  const seat = requireSeat(game, playerId, "racer");
  if (!seat.ok) {
    return NextResponse.json(
      { error: seat.error, message: "Ez nem a te lépésed." },
      { status: 403 }
    );
  }

  if (body.action === "question") {
    if (pending !== null) {
      // Idempotency and ordering in one check: the Racer cannot stack a second
      // question on an unanswered one, so a double submit is a no-op rather
      // than a corrupted log.
      return NextResponse.json(
        { error: "awaiting_answer", message: "Előbb a másik játékos válaszol." },
        { status: 409 }
      );
    }
    if (game.question_count >= game.max_questions) {
      return NextResponse.json(
        { error: "out_of_questions", message: "Elfogytak a kérdéseid. Tippelj!" },
        { status: 409 }
      );
    }
    const question = (body.question || "").trim().slice(0, MAX_TEXT);
    if (!question) return NextResponse.json({ error: "missing_question" }, { status: 400 });

    const entry = newEntry(game.qa_log.length + 1);
    entry.question_text = question;
    game.qa_log.push(entry);

    await saveGame(game);
    return respond(game);
  }

  if (body.action === "guess" || body.action === "concede") {
    const isGuess = body.action === "guess";
    const guess = (body.guess || "").trim().slice(0, MAX_TEXT);
    if (isGuess && !guess) {
      return NextResponse.json({ error: "missing_guess" }, { status: 400 });
    }

    const entry = newEntry(game.qa_log.length + 1);
    entry.turn_type = isGuess ? "guess" : "concede";
    entry.question_text = null;
    entry.guess_text = isGuess ? guess : null;
    game.qa_log.push(entry);

    // Hand off to the existing resolution path unchanged: /resolve runs the
    // Adjudicator and the Integrity Review, which is exactly the referee a
    // human Composer needs. No new AI behaviour was required for V2.3.
    game.phase = "resolving";
    game.final_action = isGuess ? "guess" : "concede";
    game.final_guess_text = isGuess ? guess : null;

    await saveGame(game);
    return respond(game);
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
