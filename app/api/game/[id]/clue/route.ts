import { NextResponse } from "next/server";
import { getGame, newLogEntry, saveGame } from "@/lib/gameStore";
import { getSecretForAnswering } from "@/lib/secretStore";
import { requestClueFromComposer } from "@/lib/prompts/composerAnswer";
import { consumeModelCall } from "@/lib/callBudget";
import {
  clueCreditsAvailable,
  cluesEnabled,
  pendingClueRequest,
} from "@/lib/clueCredits";
import type { GameRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * SÚGÓ — the explicit clue action (0.9.8.0).
 *
 * One route, two directions, because the credit rule and the transcript entry
 * are identical in both and only the author of the text differs:
 *
 *   AI Composer -> human Racer : the human spends a credit, the model writes
 *                               the clue, and it passes the disclosure guard.
 *   human Composer -> AI Racer : the Racer already spent the credit on its own
 *                               turn, leaving a clue entry awaiting text; the
 *                               human supplies that text here.
 *
 * A clue never touches question_count, never touches the single final guess,
 * and never becomes an answer to anything.
 */

function respond(game: GameRecord) {
  return NextResponse.json({ game });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const game = await getGame(params.id);

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
        message: `Ez a játék "${game.phase}" állapotban van, most nem kérhető súgó.`,
        game,
      },
      { status: 409 }
    );
  }

  if (!cluesEnabled(game)) {
    return NextResponse.json(
      { error: "clues_disabled", message: "Ebben a játékban nincs súgó.", game },
      { status: 409 }
    );
  }

  // -------------------------------------------------------------------------
  // Direction B — the human Composer is filling in a clue the AI Racer asked
  // for. The credit was already spent when the Racer chose the clue action, so
  // this path must not spend a second one.
  // -------------------------------------------------------------------------
  const outstanding = pendingClueRequest(game);
  if (outstanding) {
    let body: { clue_text?: string } = {};
    try {
      body = (await req.json()) as { clue_text?: string };
    } catch {
      body = {};
    }

    const text = (body.clue_text || "").trim();
    if (!text) {
      return NextResponse.json(
        { error: "missing_clue", message: "Írd le a súgót.", game },
        { status: 400 }
      );
    }

    // Not scrubbed: this text is the Composer's own, about their own target.
    // The disclosure guard exists to stop the MODEL revealing a secret it was
    // entrusted with. A human choosing how much to give away is playing the
    // game, not breaching it.
    outstanding.clue_text = text;
    await saveGame(game);
    return respond(game);
  }

  // -------------------------------------------------------------------------
  // Direction A — the human Racer is spending a credit to ask the AI Composer.
  // -------------------------------------------------------------------------
  if (game.racer_kind !== "human") {
    return NextResponse.json(
      {
        error: "no_clue_request",
        message: "Most nincs függőben lévő súgókérés.",
        game,
      },
      { status: 409 }
    );
  }

  if (clueCreditsAvailable(game) < 1) {
    return NextResponse.json(
      { error: "no_clue_credit", message: "Most nincs elérhető súgód.", game },
      { status: 409 }
    );
  }

  const budget = await consumeModelCall("racer");
  if (!budget.allowed) {
    return NextResponse.json(
      {
        error: "budget_exhausted",
        message: budget.failedClosed
          ? "Most nem tudjuk ellenőrizni a keretet. A játékod megvan — próbáld újra hamarosan."
          : "A Barkóba elérte a napi globális határát. A játékod megvan — próbáld újra holnap.",
        game,
      },
      { status: 503 }
    );
  }

  const secret = await getSecretForAnswering(game.game_id);
  if (!secret) {
    return NextResponse.json(
      {
        error: "secret_unavailable",
        message: "Ennek a játéknak a célpontja már nem elérhető.",
        game,
      },
      { status: 410 }
    );
  }

  let clueText: string | null = null;
  try {
    const clue = await requestClueFromComposer({
      target: secret.target,
      definition: secret.private_clarification,
      granularity: secret.granularity ?? "generic_type",
      modifiers: secret.modifiers,
      qaLog: game.qa_log,
      questionsAsked: game.question_count,
      maxQuestions: game.max_questions,
      clueMode: game.clue_mode ?? "none",
      gameLanguage: game.game_language,
    });
    clueText = clue.clue_text;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] Clue request failed:", err);
    return NextResponse.json(
      {
        error: "clue_failed",
        message: "Most nem sikerült súgót kérni. A súgód megmaradt — próbáld újra.",
        game,
      },
      { status: 502 }
    );
  }

  // A credit is spent by writing the turn, so a failed call above costs the
  // player nothing: no entry, no credit, question_count untouched.
  if (!clueText) {
    return NextResponse.json(
      {
        error: "clue_empty",
        message: "Most nem sikerült súgót adni. A súgód megmaradt — próbáld újra.",
        game,
      },
      { status: 502 }
    );
  }

  const entry = newLogEntry(game.qa_log.length + 1);
  entry.turn_type = "clue";
  entry.clue_text = clueText;
  game.qa_log.push(entry);

  await saveGame(game);
  return respond(game);
}
