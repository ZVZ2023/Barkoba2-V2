import { NextRequest, NextResponse } from "next/server";
import { acquireTurnLock, getGame, releaseTurnLock, saveGameIfRevisionMatches } from "@/lib/gameStore";
import {
  isCorrectable,
  isNoOpCorrection,
  isPreGuessCheckpointCorrection,
  recomputeCounters,
  splitAtTurn,
} from "@/lib/rewind";
import type { ComposerAnswer } from "@/lib/types";

// ---------------------------------------------------------------------------
// Correct a previously given answer, rewinding the game to that point.
//
// Makes NO model call. The rewind leaves the game with an answered final entry
// and nothing pending — which is exactly the state POST /turn already handles,
// so the Racer resumes through the existing path with existing budget
// accounting. Nothing about turn generation changes.
//
// WINDOW: `questioning`, plus one narrow exception. Once the Racer has
// guessed or conceded, the Composer can see the guess on screen, and allowing
// a rewind then would let them read the guess and retroactively invalidate
// it. That is not a recovery affordance, it is a cheat, and no audit trail
// makes it acceptable.
//
// V2.6.x exception: GameClient.tsx now withholds an unrevealed final guess
// from the screen until the Composer confirms the one answer that produced
// it (see the pre-guess checkpoint there). While THAT is still true — phase
// is "resolving", nothing has been adjudicated yet, and this correction
// targets exactly the turn beneath the unrevealed guess — the Composer has
// not seen the outcome, so allowing this one correction is not the cheat the
// window above exists to prevent. isPreGuessCheckpointCorrection is the only
// door through the phase gate; see docs/DESIGN-NOTES.md §48.
//
// V2.8.1 — the My Car Key integrity hotfix. This route always held its own
// `expected_log_length` optimistic-concurrency check, but the actual
// persistence was a blind saveGame() — a correction and an in-flight /turn
// could each read-modify-write past each other undetected. It now takes the
// same per-game turn lock /turn does and persists through the same
// revision-CAS primitive, so the two routes can no longer race each other at
// the storage layer either. The correction's own semantics — what
// expected_log_length validates, what gets rewound, what the response looks
// like — are unchanged.
// ---------------------------------------------------------------------------

const TURN_LOCK_TTL_SECONDS = 60; // matches /turn's maxDuration; see that route's comment

interface CorrectBody {
  turn_index?: number;
  answer?: ComposerAnswer;
  ambiguous_explanation?: string;
  /** Optimistic-concurrency token: qa_log.length the client last saw. */
  expected_log_length?: number;
}

const VALID_ANSWERS: ComposerAnswer[] = ["YES", "NO", "AMBIGUOUS"];

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

  let body: CorrectBody;
  try {
    body = (await req.json()) as CorrectBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "A kérés törzsének JSON formátumúnak kell lennie." },
      { status: 400 }
    );
  }

  const { turn_index: turnIndex, answer } = body;

  if (
    game.phase !== "questioning" &&
    !(typeof turnIndex === "number" && isPreGuessCheckpointCorrection(game, turnIndex))
  ) {
    return NextResponse.json(
      {
        error: "corrections_closed",
        message:
          game.phase === "resolving" || game.phase === "complete"
            ? "A válaszokat már nem lehet javítani, miután az ellenfeled tippelt."
            : `Ez a játék "${game.phase}" állapotban van, nem fogad javítást.`,
        game,
      },
      { status: 409 }
    );
  }

  if (typeof turnIndex !== "number") {
    return NextResponse.json(
      { error: "missing_turn_index", message: "A turn_index megadása kötelező." },
      { status: 400 }
    );
  }
  if (!answer || !VALID_ANSWERS.includes(answer)) {
    return NextResponse.json(
      {
        error: "invalid_answer",
        message: `A válasznak ezek egyikének kell lennie: ${VALID_ANSWERS.join(", ")}.`,
      },
      { status: 400 }
    );
  }

  const lockAcquired = await acquireTurnLock(gameId, TURN_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    return NextResponse.json(
      {
        error: "turn_in_progress",
        message: "Már folyamatban van egy kör ebben a játékban. Próbáld újra röviden.",
        game,
      },
      { status: 409 }
    );
  }

  try {
    // Re-fetch canonical state now that the lock is held, closing any gap
    // between the read above and lock acquisition — same reasoning as /turn.
    const game = await getGame(gameId);
    if (!game) {
      return NextResponse.json(
        { error: "not_found", message: "Nincs ilyen játék, vagy már lejárt." },
        { status: 404 }
      );
    }
    if (
      game.phase !== "questioning" &&
      !(typeof turnIndex === "number" && isPreGuessCheckpointCorrection(game, turnIndex))
    ) {
      return NextResponse.json(
        {
          error: "corrections_closed",
          message:
            game.phase === "resolving" || game.phase === "complete"
              ? "A válaszokat már nem lehet javítani, miután az ellenfeled tippelt."
              : `Ez a játék "${game.phase}" állapotban van, nem fogad javítást.`,
          game,
        },
        { status: 409 }
      );
    }

    // KV has no compare-and-swap on its own, which is exactly what the turn
    // lock plus the revision CAS below now supply — this check stays as the
    // request-level validation it always was: does the client's own view of
    // the log length still match?
    if (
      typeof body.expected_log_length === "number" &&
      body.expected_log_length !== game.qa_log.length
    ) {
      return NextResponse.json(
        {
          error: "stale_state",
          message: "A játék közben továbblépett. Próbáld újra.",
          game,
        },
        { status: 409 }
      );
    }

    const split = splitAtTurn(game.qa_log, turnIndex);
    if (!split) {
      return NextResponse.json(
        { error: "no_such_turn", message: `Nincs ${turnIndex}. kör ebben a játékban.`, game },
        { status: 404 }
      );
    }

    const target = split.retained[split.retained.length - 1];
    if (!isCorrectable(target)) {
      return NextResponse.json(
        {
          error: "not_correctable",
          message: "Csak olyan kérdést lehet javítani, amelyre már megjött a válasz.",
          game,
        },
        { status: 400 }
      );
    }

    const explanation =
      answer === "AMBIGUOUS" ? (body.ambiguous_explanation || "").trim() || null : null;

    if (isNoOpCorrection(target!, answer, explanation)) {
      return NextResponse.json({ game });
    }

    const revisionAtLockTime = game.revision;
    const previousAnswer = target!.composer_response!;

    target!.composer_response = answer;
    target!.ambiguous_explanation = explanation;

    // The corrected answer is canonical; everything after it was generated from
    // information now known to be wrong.
    game.qa_log = split.retained;
    if (split.abandoned.length > 0) {
      game.abandoned_branches = [...game.abandoned_branches, split.abandoned];
    }

    game.corrections = [
      ...game.corrections,
      {
        at: new Date().toISOString(),
        turn_index: turnIndex,
        from: previousAnswer,
        to: answer,
        discarded_turns: split.abandoned.length,
      },
    ];

    // Recomputed, never decremented — and this also repairs the positional
    // ambiguous_consumed_credit flags across the surviving log.
    const counters = recomputeCounters(game.qa_log);
    game.question_count = counters.questionCount;
    game.ambiguous_count = counters.ambiguousCount;

    // A mid-game rewind finds these already clear. A pre-guess-checkpoint
    // rewind (the V2.6.x exception above) does NOT: final_action and
    // final_guess_text are set to the guess this correction just discarded, so
    // clearing them here is load-bearing, not defensive, for that path.
    game.final_action = null;
    game.final_guess_text = null;
    game.result = null;
    game.adjudication_notes = null;
    game.integrity_notes = null;
    game.integrity_flagged_turns = null;
    game.adjudicator_verdict = null;
    game.integrity_verdict = null;
    game.adjudication_confidence = null;
    game.revealed_target = null;
    // A game that is live again has declassified nothing. Clearing every
    // revealed_* field together keeps declassification all-or-nothing; leaving
    // one behind would mean a playable game carrying target metadata.
    game.revealed_definition = null;
    game.revealed_granularity = null;
    game.revealed_modifiers = null;
    game.revealed_locked_at = null;
    game.phase = "questioning";

    const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
    if (!saved.ok) {
      // Structurally shouldn't happen while holding the lock — see /turn's
      // identical defensive check.
      // eslint-disable-next-line no-console
      console.error(
        `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId}) ` +
          `during a correction; expected ${revisionAtLockTime}, actual ${saved.revision}`
      );
      const canonical = await getGame(gameId);
      return NextResponse.json(
        {
          error: "stale_state",
          message: "A játék közben továbblépett. Próbáld újra.",
          game: canonical ?? game,
        },
        { status: 409 }
      );
    }
    game.revision = saved.revision;
    return NextResponse.json({ game });
  } finally {
    await releaseTurnLock(gameId);
  }
}
