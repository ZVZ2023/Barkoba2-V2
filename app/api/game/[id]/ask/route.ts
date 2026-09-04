import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  acquireTurnLock,
  getGame,
  releaseTurnLock,
  saveGameIfRevisionMatches,
} from "@/lib/gameStore";
import { resolveActingPlayerIdentity } from "@/lib/actingPlayer";
import { requireSeatStrict } from "@/lib/seats";
import { getSecretForAnswering } from "@/lib/secretStore";
import { answerAsComposer } from "@/lib/prompts/composerAnswer";
import { judgeQuestionEdit } from "@/lib/prompts/questionEdit";
import { consumeModelCall } from "@/lib/callBudget";
import { decideAttemptBudget } from "@/lib/turnBudget";
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

// V2.8.6 R2 — raised from 60s. The edit_turn_index path now runs two
// sequential provider calls under its own 60s local budget (see
// EDIT_TOTAL_PROVIDER_BUDGET_MS below); 90s keeps the same ~30s margin past
// that budget for lock acquisition, JSON parsing, the CAS save and response
// construction that /turn's own maxDuration/lock-TTL ordering comment
// documents for its numbers.
export const maxDuration = 90;

/**
 * V2.8.6 R2 — this route's own turn lock, reusing the exact primitive (and,
 * per game, the exact KEY — see acquireTurnLock in lib/gameStore.ts) the My
 * Car Key hotfix built for /turn. Safe to share: a game's racer_kind fixes
 * its mode permanently at creation, so a given game only ever calls ONE of
 * /turn, /ask or /hh/turn — there is no cross-route contention to reason
 * about, only the same game's own /ask and /clue calls (see /clue's own
 * comment on why they share this lock too).
 *
 * 120s > maxDuration (90s), matching /turn's own discipline: the lock cannot
 * expire while a legitimate request is still genuinely running, so a retry
 * can only ever see "busy" for up to the time the platform itself would
 * already have killed the function holding it.
 */
const ASK_TURN_LOCK_TTL_SECONDS = 120;

/**
 * V2.8.6 R2 — the edit_turn_index path's own shared provider-time budget,
 * covering BOTH sequential calls (judgeQuestionEdit, then answerAsComposer).
 * Reuses lib/turnBudget.ts's decideAttemptBudget — the same "one absolute
 * deadline, each attempt draws down from what's left" primitive /turn's own
 * duplicate-question loop is built on — rather than inventing a second
 * implementation of the same arithmetic.
 */
const EDIT_TOTAL_PROVIDER_BUDGET_MS = 60_000;
/** Below this much remaining budget, the second call never starts. */
const EDIT_SECOND_CALL_MIN_REMAINING_MS = 15_000;
/** The most the second call may run, even with more budget to spare. */
const EDIT_SECOND_CALL_MAX_MS = 30_000;

const EDIT_BUDGET_EXHAUSTED_MESSAGE = "A szerkesztés most nem végezhető el. Próbáld újra.";

/**
 * V2.8.6 R2 — a LOCAL wait bound only, exactly like lib/turnBudget.ts's own
 * runWithAbortTimeout documents for the Racer call: neither judgeQuestionEdit
 * nor answerAsComposer accepts an AbortSignal (unlike runRacerTurn), and
 * neither gains one here — that would touch lib/prompts/*.ts, out of this
 * change's scope. This only stops BARKÓBA from waiting past `ms`; it makes no
 * claim about the remote call itself stopping.
 */
function withLocalTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[barkoba] local wait exceeded ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

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
  /**
   * V2.8.6 R2 — the revision (see GameRecord.revision) the client's screen
   * was showing when it composed this action. Required on every mutating
   * call to this route — question, guess, concede, and edit alike all
   * mutate — mirroring /turn's own My Car Key invariant.
   */
  expected_revision?: number;
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

/**
 * V2.8.6 R2 — mirrors /turn's staleTurn(): the game has moved on since the
 * client's snapshot. `game` must always be the freshest canonical read
 * available to the caller.
 */
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

  // -------------------------------------------------------------------------
  // V2.8.6 R1 — this route submits questions/guesses as the human Racer
  // against an AI Composer. It never checked who was asking; any caller who
  // knew or guessed game_id could ask questions or commit a guess/concession
  // on someone else's game. racer_player_id is recorded for THIS mode at
  // creation as of this change (see app/api/game/create/route.ts) — a game
  // created before that change has no seat to check, and requireSeatStrict
  // fails it closed rather than matching whoever asks.
  //
  // V2.8.6 R2 — authorization runs here, entirely before any lock is
  // acquired: reliability wrapping must never become a way to spend a lock
  // slot (or learn timing information) ahead of an authorization decision.
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
  const seatCheck = requireSeatStrict(game, identity.playerId, "racer");
  if (!seatCheck.ok) {
    if (seatCheck.error === "legacy_seat_unassigned") {
      // eslint-disable-next-line no-console
      console.warn(
        `[barkoba] game ${game.game_id}: no racer seat was ever recorded for this ` +
          "AI-Composer game — refusing rather than assigning the caller retroactively."
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
        error: seatCheck.error,
        message:
          seatCheck.error === "not_a_participant"
            ? "Ehhez a játékhoz nincs hozzáférésed."
            : "Ez nem a te lépésed.",
      },
      { status: 403 }
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
  // V2.8.6 R2 — the My Car Key invariant, extended to /ask. Every branch
  // below mutates, so expected_revision is required unconditionally (unlike
  // /turn, where it is only required alongside an `answer`). Cheap, lock-free
  // rejection of an OBVIOUSLY stale snapshot using the read already in hand;
  // re-checked again below against a fresh read, once the lock is held.
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

  // -------------------------------------------------------------------------
  // V2.8.6 R2 — the per-game turn lock, shared with /turn/hh-turn's own key
  // (see ASK_TURN_LOCK_TTL_SECONDS's doc). Stops two concurrent requests from
  // both paying for a provider call against the same stale snapshot; the
  // revision CAS at every save below is the actual data-integrity guarantee.
  // -------------------------------------------------------------------------
  const lockAcquired = await acquireTurnLock(gameId, ASK_TURN_LOCK_TTL_SECONDS);
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
    // Re-fetch canonical state now that the lock is held, closing any gap
    // between the read above and lock acquisition.
    const game = await getGame(gameId);
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
    if (body.expected_revision !== game.revision) {
      return staleTurn(game);
    }

    // The revision every save in this request must be conditioned on. Fixed
    // once, at the moment the lock was confirmed — every exit path below
    // saves against this same value.
    const revisionAtLockTime = game.revision;

    // -----------------------------------------------------------------------
    // Declared guess or concession. A human Racer states intent directly, so
    // the Guess Detector — which exists to infer an AI's intent from its
    // prose — has nothing to do here. See DESIGN-NOTES §1.
    // -----------------------------------------------------------------------
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
    // Question correction. Mobile autocorrect should not cost a question.
    // -----------------------------------------------------------------------
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

      // V2.8.6 R2 — the shared local time-budget for this branch's two
      // sequential provider calls, fixed once at branch entry. Distinct from
      // the GLOBAL daily spend ceiling below (consumeModelCall) — this bounds
      // wall-clock time within ONE request, not aggregate spend.
      const editDeadlineAt = Date.now() + EDIT_TOTAL_PROVIDER_BUDGET_MS;

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
        verdict = await withLocalTimeout(
          EDIT_TOTAL_PROVIDER_BUDGET_MS,
          judgeQuestionEdit({
            original,
            edited,
            gameLanguage: game.game_language,
          })
        );
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

      // ---------------------------------------------------------------------
      // V2.8.6 R2 — the local time-budget gate, evaluated AFTER the first
      // call's real elapsed time is known and immediately before the second
      // call would start — BEFORE the secret lookup and the second daily
      // spend-ceiling reservation below, deliberately: there is no reason to
      // spend either once the wall-clock budget alone already rules the
      // second call out. Nothing has mutated `game` yet at this point (only
      // `verdict` was fetched), so a refusal here needs no save: the game is
      // already sitting at its own authorized pre-mutation revision.
      // ---------------------------------------------------------------------
      const secondCallDecision = decideAttemptBudget(editDeadlineAt, Date.now(), {
        sharedDeadlineMs: EDIT_TOTAL_PROVIDER_BUDGET_MS,
        perAttemptMaxMs: EDIT_SECOND_CALL_MAX_MS,
        minRemainingToStartMs: EDIT_SECOND_CALL_MIN_REMAINING_MS,
      });
      if (!secondCallDecision.allowed) {
        return NextResponse.json(
          { error: "budget_exhausted", message: EDIT_BUDGET_EXHAUSTED_MESSAGE, game },
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
        reanswer = await withLocalTimeout(
          secondCallDecision.allowanceMs,
          answerAsComposer({
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
          })
        );
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
