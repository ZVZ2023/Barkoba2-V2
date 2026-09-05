import { NextResponse } from "next/server";
import {
  acquireTurnLock,
  getGame,
  newLogEntry,
  releaseTurnLock,
  saveGameIfRevisionMatches,
} from "@/lib/gameStore";
import { resolveActingPlayerIdentity } from "@/lib/actingPlayer";
import { requireSeatStrict } from "@/lib/seats";
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

// V2.8.6 R2 — explicit and unchanged at 60s (this route makes at most one
// model call, same as before). See CLUE_TURN_LOCK_TTL_SECONDS below for why
// the lock TTL is longer than this ceiling.
export const maxDuration = 60;

/**
 * V2.8.6 R2 — this route's own turn lock. Reuses the exact primitive (and,
 * per game, the exact KEY — see acquireTurnLock in lib/gameStore.ts) /turn,
 * /ask and /hh/turn all share: a game's mode fixes which ONE of those three
 * ever applies to it, so /clue sharing the same key with whichever one does
 * is what makes "a clue-held lock blocks a concurrent /turn or /ask on the
 * SAME game" true by construction, not by a second, independently-guarded
 * mechanism that could drift out of sync with the first. 90s > maxDuration
 * (60s), matching /turn's and /ask's own discipline: the lock cannot expire
 * while a legitimate request is still genuinely running.
 */
const CLUE_TURN_LOCK_TTL_SECONDS = 90;

interface ClueBody {
  clue_text?: string;
  /**
   * V2.8.6 R2 — the revision (see GameRecord.revision) the client's screen
   * was showing when it composed this action. Required on both directions:
   * both mutate.
   */
  expected_revision?: number;
}

function respond(game: GameRecord, status = 200) {
  return NextResponse.json({ game }, { status });
}

/** Mirrors /turn's and /ask's staleTurn(): the game has moved on since the client's snapshot. */
function staleTurn(game: GameRecord) {
  return NextResponse.json(
    {
      error: "stale_turn",
      message: "A játék időközben továbblépett — frissítve a jelenlegi állapotra.",
      game,
    },
    { status: 409 }
  );
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
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
  // V2.8.6 R1 — this route serves BOTH directions of a clue exchange, so
  // identity is resolved once and checked against whichever seat the branch
  // below requires. Previously neither direction checked who was asking, so
  // any caller who knew or guessed game_id could request a clue as the
  // Racer, or write clue text as the Composer, on someone else's game.
  //
  // V2.8.6 R2 — authorization (identity + seat, whichever direction applies)
  // runs entirely before any lock is acquired, exactly like /ask.
  // -------------------------------------------------------------------------
  const identity = await resolveActingPlayerIdentity(req.headers);
  if (identity.kind === "backend_unavailable") {
    return NextResponse.json(
      {
        error: "identity_unavailable",
        message: "Most nem tudjuk azonosítani a munkameneted. Próbáld újra hamarosan.",
      },
      { status: 503 }
    );
  }
  if (identity.kind === "absent") {
    return NextResponse.json(
      { error: "unauthenticated", message: "A játékhoz be kell azonosítanod magad." },
      { status: 401 }
    );
  }
  const playerId = identity.playerId;

  function seatFailureResponse(
    error: "not_a_participant" | "wrong_seat" | "legacy_seat_unassigned",
    unassignedFor: "composer" | "racer"
  ) {
    if (error === "legacy_seat_unassigned") {
      // eslint-disable-next-line no-console
      console.warn(
        `[barkoba] game ${game!.game_id}: no ${unassignedFor} seat was ever recorded for this game — ` +
          "refusing rather than assigning the caller retroactively."
      );
      return NextResponse.json(
        {
          error: "restart_required",
          message:
            "Ez a játék egy régebbi verzióból származik, és a hozzáférés-ellenőrzés miatt nem folytatható. Kezdj új játékot.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        error,
        message: error === "not_a_participant" ? "Ehhez a játékhoz nincs hozzáférésed." : "Ez nem a te lépésed.",
      },
      { status: 403 }
    );
  }

  // Direction is a structural property of this game (see CLUE_TURN_LOCK_
  // TTL_SECONDS's own doc: only one of /turn/ask ever applies, and pending-
  // ness only ever arises for the mode /turn's AI Racer creates it for), so
  // determining it against this pre-lock read and checking the seat it
  // implies is safe — a race that could flip it is exactly what the shared
  // lock below rules out before either direction's own mutation runs.
  const outstanding = pendingClueRequest(game);
  const direction: "compose_text" | "request_clue" = outstanding ? "compose_text" : "request_clue";

  if (direction === "compose_text") {
    const composerSeat = requireSeatStrict(game, playerId, "composer");
    if (!composerSeat.ok) return seatFailureResponse(composerSeat.error!, "composer");
  } else {
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
    const racerSeat = requireSeatStrict(game, playerId, "racer");
    if (!racerSeat.ok) return seatFailureResponse(racerSeat.error!, "racer");
  }

  let body: ClueBody = {};
  try {
    body = (await req.json()) as ClueBody;
  } catch {
    body = {};
  }

  // -------------------------------------------------------------------------
  // V2.8.6 R2 — the My Car Key invariant, extended to /clue. Both directions
  // mutate, so expected_revision is required unconditionally. Cheap,
  // lock-free rejection of an OBVIOUSLY stale snapshot; re-checked again
  // below against a fresh read, once the lock is held.
  // -------------------------------------------------------------------------
  if (typeof body.expected_revision !== "number") {
    return NextResponse.json(
      {
        error: "missing_expected_revision",
        message: "A kérésnek tartalmaznia kell, melyik állapotra vonatkozik.",
      },
      { status: 400 }
    );
  }
  if (body.expected_revision !== game.revision) {
    return staleTurn(game);
  }

  const lockAcquired = await acquireTurnLock(gameId, CLUE_TURN_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    return NextResponse.json(
      {
        error: "turn_in_progress",
        message: "Már folyamatban van egy kérés ehhez a játékhoz. Próbáld újra röviden.",
        game,
      },
      { status: 409 }
    );
  }

  try {
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
    if (body.expected_revision !== game.revision) {
      return staleTurn(game);
    }

    const revisionAtLockTime = game.revision;

    // -----------------------------------------------------------------------
    // Direction B — the human Composer is filling in a clue the AI Racer
    // asked for. The credit was already spent when the Racer chose the clue
    // action, so this path must not spend a second one.
    // -----------------------------------------------------------------------
    const outstandingNow = pendingClueRequest(game);
    if (outstandingNow) {
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
      outstandingNow.clue_text = text;

      const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
      if (!saved.ok) {
        // eslint-disable-next-line no-console
        console.error(
          `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId})`
        );
        const canonical = await getGame(gameId);
        return staleTurn(canonical ?? game);
      }
      game.revision = saved.revision;
      return respond(game);
    }

    // -----------------------------------------------------------------------
    // Direction A — the human Racer is spending a credit to ask the AI
    // Composer. Re-derived and re-checked post-lock: the pre-lock read above
    // only established that authorization was safe to evaluate against it,
    // not that it is still current.
    // -----------------------------------------------------------------------
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
    let clueProvenance: import("@/lib/types").ModelProvenance | null = null;
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
      clueProvenance = clue.provenance;
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
    // Null on the human-Composer direction of this route, where the human wrote
    // the clue themselves and no model authored anything.
    if (clueProvenance) {
      entry.model_id = clueProvenance.model_id;
      entry.model_provider = clueProvenance.model_provider;
      entry.prompt_version = clueProvenance.prompt_version;
    }
    game.qa_log.push(entry);

    const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
    if (!saved.ok) {
      // eslint-disable-next-line no-console
      console.error(
        `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId})`
      );
      const canonical = await getGame(gameId);
      return staleTurn(canonical ?? game);
    }
    game.revision = saved.revision;
    return respond(game);
  } finally {
    await releaseTurnLock(gameId);
  }
}
