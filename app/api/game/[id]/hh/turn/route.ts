import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  acquireTurnLock,
  getGame,
  releaseTurnLock,
  saveGameIfRevisionMatches,
} from "@/lib/gameStore";
import { resolveActingPlayerId } from "@/lib/actingPlayer";
import { awaitingRacer, isHumanVsHuman, requireSeat } from "@/lib/seats";
import { pendingQuestionIndex } from "@/lib/gameView";
import type { ComposerAnswer, QuestionLogEntry } from "@/lib/types";

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
//
// V2.8.6 R2 — the same per-game turn lock and CAS-bound save /turn, /ask and
// /clue all now share, and the SAME revision this route now validates
// against is the REAL GameRecord.revision (the My Car Key CAS counter),
// not lib/gameView.ts's own derived revisionOf() poll marker this route
// used to check expected_revision against. That marker still exists and is
// still what a plain GET /view poll reports for cheap "did anything
// change?" comparisons — it is simply no longer what THIS route's own
// integrity guarantee is built on. This route intentionally returns neither
// GameRecord nor GameView: HumanClient.tsx fetches canonical narrowed state
// through a SEPARATE GET /view call after every mutation, exactly as it
// already did before this change; the response here only needs to say
// whether the write landed and at what revision.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/**
 * V2.8.6 R2 — this route makes no model call at all (unchanged from V2.3 —
 * see the module doc above); its lock only needs to cover a KV read plus a
 * KV compare-and-swap write, comfortably done in well under a second even
 * against real network latency. 15s is generous headroom for that, not a
 * budget for slow work the way /turn's/ask's/clue's much longer TTLs are —
 * their numbers exist to outlive a provider call this route never makes.
 */
const HH_TURN_LOCK_TTL_SECONDS = 15;

interface Body {
  action: "question" | "answer" | "guess" | "concede" | "hint";
  question?: string;
  guess?: string;
  hint?: string;
  answer?: ComposerAnswer;
  ambiguous_explanation?: string;
  /**
   * V2.8.6 R2 — now REQUIRED (previously optional), and validated against
   * the REAL GameRecord.revision CAS counter via saveGameIfRevisionMatches
   * — the same My Car Key invariant /turn, /ask and /clue enforce. A
   * backgrounded tab that wakes up and submits against state that has since
   * moved is rejected rather than allowed to overwrite, and — unlike the
   * pre-R2 comparison against lib/gameView.ts's derived revisionOf()
   * marker — this is now a genuine atomic compare-and-swap, not a
   * best-effort validation against a value Redis itself cannot enforce
   * uniqueness on.
   */
  expected_revision?: number;
}

const VALID_ANSWERS: ComposerAnswer[] = ["YES", "NO", "AMBIGUOUS"];
const MAX_TEXT = 500;

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
    // Human↔Human makes no model call, so these three stay null for the life of
    // the turn. That is a finding, not a gap: a null model on an H↔H turn
    // correctly says no model produced it.
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

/** V2.8.6 R2 — the game moved on since the client's snapshot. Never carries game/view — see the module doc. */
function staleTurn(revision: number) {
  return NextResponse.json(
    {
      error: "stale_turn",
      message: "Közben történt valami. Frissítettük az állást.",
      revision,
    },
    { status: 409 }
  );
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gameId = params.id;

  // ---------------------------------------------------------------------
  // V2.8.6 R2 — KNOWN INCONSISTENCY, DELIBERATELY NOT FIXED HERE. Every
  // OTHER mutating gameplay route (/turn, /ask, /clue) and /view now
  // resolve identity through resolveActingPlayerIdentity's typed
  // IdentityResolution (V2.8.6 R1 Commit 3 — see lib/actingPlayer.ts's own
  // doc), which distinguishes "no identity presented" (401) from "the
  // identity backend itself is unreachable" (503 identity_unavailable).
  // This route still uses the older resolveActingPlayerId, which collapses
  // BOTH cases into a plain `null` — so an identity-backend outage on THIS
  // route surfaces as 403 not_a_participant, not 503, unlike its four
  // siblings. /hh/turn was outside R1 Commit 3's own stated scope, and R2's
  // authorized scope is gameplay reliability (locking/CAS/revision), not
  // authorization policy or its response taxonomy — so this is recorded as
  // a named POST-R2 CLEANUP ITEM, not silently patched over inside a
  // reliability change.
  // ---------------------------------------------------------------------
  const playerId = await resolveActingPlayerId(req.headers);

  const game = await getGame(gameId);
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

  // -------------------------------------------------------------------------
  // V2.8.6 R2 — the My Car Key invariant, extended to /hh/turn. Every action
  // this route accepts mutates, so expected_revision is required
  // unconditionally. Cheap, lock-free rejection of an OBVIOUSLY stale
  // snapshot using the read already in hand; re-checked again below against
  // a fresh read, once the lock is held.
  // -------------------------------------------------------------------------
  if (typeof body.expected_revision !== "number") {
    return NextResponse.json(
      { error: "missing_expected_revision", message: "A kérésnek tartalmaznia kell, melyik állapotra vonatkozik." },
      { status: 400 }
    );
  }
  if (body.expected_revision !== game.revision) {
    return staleTurn(game.revision);
  }

  // -------------------------------------------------------------------------
  // V2.8.6 R2 — authorization runs BEFORE the lock is ever acquired, exactly
  // like /ask and /clue: reliability wrapping must never become a way to
  // spend a lock slot ahead of an authorization decision. Which seat is
  // required depends on the action (hint/answer belong to the Composer,
  // everything else — including an unrecognized action, matching this
  // route's pre-existing fallthrough behavior below — belongs to the
  // Racer), so that much of the body must be read first; nothing else about
  // it is trusted or acted on until the lock is held and state is re-read.
  // -------------------------------------------------------------------------
  const requiredSeat = body.action === "hint" || body.action === "answer" ? "composer" : "racer";
  const seatCheck = requireSeat(game, playerId, requiredSeat);
  if (!seatCheck.ok) {
    // Preserves each action's own pre-existing message verbatim (hint's own
    // wording differs from every other seat failure's, which all share the
    // generic "not your move").
    return NextResponse.json(
      {
        error: seatCheck.error,
        message: body.action === "hint" ? "Csak a gondolkodó súghat." : "Ez nem a te lépésed.",
      },
      { status: 403 }
    );
  }

  // -------------------------------------------------------------------------
  // V2.8.6 R2 — the per-game turn lock, sharing the SAME key /turn, /ask and
  // /clue already do (see lib/gameStore.ts's acquireTurnLock). A game's mode
  // fixes which one of /turn/ask/hh-turn ever applies to it, so this is safe
  // — there is no cross-route contention to reason about for this game.
  // -------------------------------------------------------------------------
  const lockAcquired = await acquireTurnLock(gameId, HH_TURN_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    return NextResponse.json({ error: "turn_in_progress" }, { status: 409 });
  }

  try {
    // Re-fetch canonical state now that the lock is held, closing any gap
    // between the read above and lock acquisition.
    const game = await getGame(gameId);
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
    if (body.expected_revision !== game.revision) {
      return staleTurn(game.revision);
    }

    // The revision every save in this request must be conditioned on. Fixed
    // once, at the moment the lock was confirmed — every exit path below
    // saves against this same value.
    const revisionAtLockTime = game.revision;
    const pending = pendingQuestionIndex(game);

    async function saveAndRespond(): Promise<NextResponse> {
      const saved = await saveGameIfRevisionMatches(game!, revisionAtLockTime);
      if (!saved.ok) {
        // Structurally shouldn't happen: this whole block runs while holding
        // the per-game turn lock, so nothing else could have advanced the
        // revision since revisionAtLockTime was read. Reaching this means the
        // lock was somehow bypassed or its TTL expired mid-request.
        // eslint-disable-next-line no-console
        console.error(
          `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId}); ` +
            `expected ${revisionAtLockTime}, actual ${saved.revision}`
        );
        return staleTurn(saved.revision);
      }
      return NextResponse.json({ ok: true, revision: saved.revision });
    }

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
      // Seat already checked pre-lock (see requiredSeat above).
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

      return saveAndRespond();
    }

    // -------------------------------------------------------------------------
    // Composer: answer the one outstanding question.
    // -------------------------------------------------------------------------
    if (body.action === "answer") {
      // Seat already checked pre-lock (see requiredSeat above).
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
      // V2.5 — when the other human answered. No model provenance: Human↔Human
      // makes no model call, and a null model here correctly says so.
      entry.answered_at = new Date().toISOString();
      entry.ambiguous_explanation =
        answer === "AMBIGUOUS"
          ? (body.ambiguous_explanation || "").trim().slice(0, MAX_TEXT) || null
          : null;

      // The 0.3.4.0 rule, unchanged: every answered question costs one, whatever
      // the answer. AMBIGUOUS is unlimited in count but never free.
      game.question_count += 1;
      if (answer === "AMBIGUOUS") game.ambiguous_count += 1;

      return saveAndRespond();
    }

    // -------------------------------------------------------------------------
    // Racer: ask, guess, or concede. Seat already checked pre-lock (see
    // requiredSeat above) — every action that reaches this point (including
    // an unrecognized one, which still falls through to unknown_action
    // below) required the racer seat.
    // -------------------------------------------------------------------------
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

      return saveAndRespond();
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

      return saveAndRespond();
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } finally {
    await releaseTurnLock(gameId);
  }
}
