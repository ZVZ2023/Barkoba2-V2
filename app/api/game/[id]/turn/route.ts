import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  acquireTurnLock,
  getGame,
  releaseTurnLock,
  saveGameIfRevisionMatches,
} from "@/lib/gameStore";
import { resolveActingPlayerId } from "@/lib/actingPlayer";
import { requireSeatStrict } from "@/lib/seats";
import { toRacerPublicState } from "@/lib/racerState";
import { derivePhaseOneState } from "@/lib/phaseOne";
import {
  deriveLayerTwoState,
  nextMandatoryGate,
  resolveLivingRoute,
  resolvePlaceRoute,
  type LayerTwoState,
} from "@/lib/layerTwo";
import {
  deriveSandboxClarificationState,
  isSandboxClarificationEntry,
  sandboxClarificationRawOutput,
} from "@/lib/sandboxClarification";
import { advanceHighWaterMark, effectiveConsumed } from "@/lib/rewind";
import { pendingClueRequest } from "@/lib/clueCredits";
import { runRacerTurn, resolveGuessIntent, racerModelFor } from "@/lib/prompts/racer";
import { DEFAULT_RACER_PROVIDER, isModelProviderId } from "@/lib/providers";
import type { ModelProviderId } from "@/lib/providers/types";
import { detectGuess } from "@/lib/guessDetector";
import {
  priorAskedQuestions,
  runWithDuplicateQuestionGuard,
  isDuplicateQuestion,
} from "@/lib/duplicateQuestionGuard";
import { consumeModelCall } from "@/lib/callBudget";
import {
  TURN_BUDGET_CONFIG,
  decideAttemptBudget,
  runWithAbortTimeout,
  isLocalTimeoutError,
} from "@/lib/turnBudget";
import {
  recordOperationStarted,
  recordOperationCompleted,
  type OperationHandle,
} from "@/lib/corpus/turnTelemetry";
import { env } from "@/lib/env";
import type {
  ComposerAnswer,
  GameLanguage,
  GameRecord,
  GuessIntentOutcome,
  ModelProvenance,
  QuestionLogEntry,
  RacerPublicState,
  RacerTurnOutput,
} from "@/lib/types";

/**
 * V2.8.5 FINAL ENGINE-CONTRACT CORRECTION (localization) — this route's
 * other error messages are, by longstanding pre-existing convention, plain
 * Hungarian regardless of game.game_language (unrelated to this ticket, and
 * out of scope to relitigate here). The "+1" corridor's failure message is
 * called out specifically because an English game must not receive a
 * Hungarian terminal message at exactly the point where the player needs to
 * understand why the game stopped.
 */
const SANDBOX_CLARIFICATION_FAILED_MESSAGE: Record<GameLanguage, string> = {
  hu: "Nem sikerült egyértelmű célkategóriát megállapítani a megadott válaszokból. Kérlek, kezdj új játékot pontosabban megfogalmazott céllal.",
  en: "Could not establish a clear target category from the answers given. Please start a new game with a more precisely defined target.",
};

// This route deliberately imports neither lib/secretStore.ts nor anything that
// does. It runs the entire question loop on public state alone.

// S2 / RB-2 — 270, a LITERAL, not a reference to another constant. Next.js's
// route-segment-config analyzer looks for `export const maxDuration = <number
// literal>` specifically; a computed or imported value here is not guaranteed
// to be picked up by the Vercel build step, so this MUST stay a bare number.
// See lib/turnBudget.ts's module doc for the read-only S2 discovery evidence
// this value is chosen from: Vercel's actual Hobby-plan ceiling is 300s (this
// repo's team plan, confirmed against Vercel's own current docs), well above
// the pre-S2 self-imposed 60s. Ordering requirement, pinned by
// test/turnBudget.test.ts: the shared provider deadline (lib/turnBudget.ts,
// 240s) < maxDuration (270s) < TURN_LOCK_TTL_SECONDS (300s) below — 30s of
// margin after the shared deadline for duplicate-checking, the revision-CAS
// save, telemetry, and response construction; then 30s more before the lock
// itself can be re-acquired by a legitimate retry.
export const maxDuration = 270;

// V2.8.1 — the My Car Key integrity hotfix's turn lock.
//
// S2 / RB-2 — NO LONGER TIED TO maxDuration. Before S2 this was
// `= maxDuration` (both 60), which is exactly what the S2 discovery pass
// flagged as unsafe once real attempts could run close to a multi-hundred-
// second budget: the lock could expire while a legitimate call was still in
// flight, letting a retry acquire it and start a SECOND concurrent Racer
// call for the same turn. 300 is deliberately > maxDuration (270), so the
// lock cannot expire before the platform itself would have already killed
// the function holding it. If the Racer call times out, the platform kills
// this function before it reaches its own `finally` release — the lock then
// simply expires on its own TTL, at most 300s after acquisition. A later
// retry sees "busy, try again shortly" for up to that long rather than ever
// risking a stale answer landing on the wrong question — see
// docs/DESIGN-NOTES.md for the incident this closes.
const TURN_LOCK_TTL_SECONDS = 300;

// V2.8.2 — the exact-duplicate question pre-emission guard. A "small bounded
// retry cap" per the intervention ticket: 1 initial attempt plus 2
// regenerations. Each attempt below is a full, real LLM call (its own
// consumeModelCall check, same as any other Racer call), not a cheap retry —
// the cap stays small on purpose. See lib/duplicateQuestionGuard.ts for the
// detector itself and the forensic report for why this exact mechanism (and
// no other) was chosen.
const MAX_DUPLICATE_QUESTION_ATTEMPTS = 3;

interface TurnBody {
  answer?: ComposerAnswer;
  ambiguous_explanation?: string;
  /**
   * V2.8.1 — required whenever `answer` is present. The revision (see
   * GameRecord.revision) the client's screen was showing when it decided
   * what question it was answering. The server accepts the answer only if
   * this still matches canonical state; see the "stale_turn" response
   * below for what happens when it doesn't.
   */
  expected_revision?: number;
}

const VALID_ANSWERS: ComposerAnswer[] = ["YES", "NO", "AMBIGUOUS"];

function respond(game: GameRecord, status = 200) {
  return NextResponse.json({ game }, { status });
}

/**
 * V2.8.1 — the game has moved on since the client's snapshot. Returned
 * instead of applying a stale answer. `game` must always be the freshest
 * canonical read available to the caller, so the client can reconcile to it
 * directly rather than being told to blindly resubmit.
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

interface RacerAttempt {
  turn: RacerTurnOutput;
  provenance: ModelProvenance;
  flagged: boolean;
  intentOutcome: GuessIntentOutcome | null;
  preRevisionQuestion: string | null;
  /**
   * S2 / RB-2 — the durable-telemetry handle for THIS attempt's provider
   * call. Always present (round-2 review fix: the id is generated
   * client-side by recordOperationStarted regardless of whether corpus is
   * configured or the start write itself lands — see
   * lib/corpus/turnTelemetry.ts's module doc). Carried out of
   * runOneRacerAttempt because only the CALLER (POST's produceCandidate
   * closure) knows the duplicate-guard's verdict — accepted vs
   * duplicate_rejected — which this handle is used to finalize.
   */
  telemetryHandle: OperationHandle;
  /** Wall-clock time of the runRacerTurn() call alone, in ms. */
  attemptLatencyMs: number;
}

type RacerAttemptOutcome =
  | { ok: true; attempt: RacerAttempt }
  | { ok: false; response: NextResponse };

/**
 * One full attempt at a Racer turn: the spend-ceiling check, the LLM call,
 * and (if the Guess Detector fires) intent resolution. Extracted so the
 * duplicate-question guard below can call it more than once without
 * duplicating any of Steps 2–4's logic — byte-identical to what a single
 * unguarded attempt does, just callable in a loop.
 *
 * V2.8.2, revised from the original V2.8.x guard: every `ok: false` branch
 * now preserves the Composer's answer via the SAME revision-CAS save the
 * My Car Key hotfix requires (`saveGameIfRevisionMatches`), not a blind
 * `saveGame` — this function runs entirely inside POST's turn-lock section,
 * so it must honor the same "never mutate outside the CAS" invariant every
 * other exit path in that section does. `revisionAtLockTime` is the value
 * fixed once when the lock was confirmed; `gameId` is only needed for the
 * re-fetch-on-mismatch defensive log path, matching every other save site
 * in this route.
 *
 * S2 / RB-2 — `providerDeadlineAt` is the ONE absolute deadline (epoch ms)
 * fixed at route entry for the whole invocation's provider time, shared
 * across every attempt the duplicate-guard makes; `attemptNumber` is this
 * attempt's 1-based position in that loop, for telemetry only. See
 * lib/turnBudget.ts for why an absolute deadline (rather than a per-attempt
 * duration) is what makes time already spent by earlier attempts count
 * automatically.
 */
/**
 * The recoverable racer_unavailable 502, with the answer (if any) preserved
 * via the same revision-CAS every other exit path in this route uses. Shared
 * by the early and final shared-budget gates below — both need EXACTLY this
 * outcome, and duplicating it a third time is what the S2 review flagged as
 * worth avoiding once a second call site needed it.
 */
async function preserveAnswerAndFailRacerUnavailable(
  game: GameRecord,
  gameId: string,
  revisionAtLockTime: number
): Promise<RacerAttemptOutcome> {
  const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
  if (!saved.ok) {
    // eslint-disable-next-line no-console
    console.error(
      `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId})`
    );
    const canonical = await getGame(gameId);
    return { ok: false, response: staleTurn(canonical ?? game) };
  }
  game.revision = saved.revision;
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: "racer_unavailable",
        message: "Az ellenfeled most nem tudott lépni. Próbáld újra.",
        game,
      },
      { status: 502 }
    ),
  };
}

async function runOneRacerAttempt(
  game: GameRecord,
  racerState: RacerPublicState,
  forceFinal: boolean,
  racerProvider: ModelProviderId,
  gameId: string,
  revisionAtLockTime: number,
  providerDeadlineAt: number,
  attemptNumber: number,
  layerTwoState?: LayerTwoState
): Promise<RacerAttemptOutcome> {
  // S2 / RB-2 — the shared provider-time budget's EARLY gate. Cheap and
  // approximate: it avoids wasting a daily spend-ceiling slot and a
  // telemetry row on an attempt already known to be hopeless, but it is NOT
  // the enforcement point — see the FINAL gate below, immediately before the
  // provider call, which is authoritative. (S2 review fix: the original
  // version treated this early check as sufficient, but consumeModelCall's
  // own await and the telemetry insert between here and the actual call can
  // each consume real wall-clock time that this check cannot see.)
  const earlyDecision = decideAttemptBudget(providerDeadlineAt, Date.now());
  if (!earlyDecision.allowed) {
    return preserveAnswerAndFailRacerUnavailable(game, gameId, revisionAtLockTime);
  }

  // Step 2 — global spend ceiling. Checked before every model call, fails closed.
  const preProviderStartedAt = Date.now();
  const budget = await consumeModelCall("racer");
  if (!budget.allowed) {
    const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime); // the answer recorded in Step 1 must not be lost
    if (!saved.ok) {
      // eslint-disable-next-line no-console
      console.error(
        `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId})`
      );
      const canonical = await getGame(gameId);
      return { ok: false, response: staleTurn(canonical ?? game) };
    }
    game.revision = saved.revision;
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: budget.failedClosed ? "budget_unavailable" : "budget_exhausted",
          message: budget.failedClosed
            ? "Most nem tudjuk ellenőrizni a keretet. Próbáld újra hamarosan."
            : "A Barkóba elérte az AI-körökre szánt napi globális határát. Próbáld újra holnap.",
          game,
        },
        { status: budget.failedClosed ? 503 : 429 }
      ),
    };
  }

  // S2 review fix — the REQUESTED model, resolved before the call so
  // telemetry records it immediately (reusing racer.ts's own resolver rather
  // than duplicating model-selection logic a second time). A failed or
  // timed-out attempt keeps this value; only a successful call's telemetry
  // finalization (in POST's produceCandidate closure, which alone knows the
  // duplicate-guard's verdict) may overwrite it with the RESOLVED model.
  const requestedModel = racerModelFor(racerProvider);

  const telemetryHandle = await recordOperationStarted({
    gameId,
    turnIndex: game.qa_log.length + 1,
    operationKind: "provider_attempt",
    attemptNumber,
    provider: racerProvider,
    modelId: requestedModel,
  });

  // S2 review fix — the FINAL, AUTHORITATIVE budget gate. Recomputed here,
  // immediately before the provider call, using a FRESH Date.now(): the
  // early gate above cannot see how much wall-clock time consumeModelCall's
  // own await and the recordOperationStarted insert above JUST consumed, so
  // an attempt the early gate allowed 45s could otherwise still run up to
  // 45s past the absolute shared deadline. This is the check that actually
  // enforces "the provider cannot run beyond the original absolute
  // deadline" — the early gate is an optimization, not the enforcement.
  const finalDecision = decideAttemptBudget(providerDeadlineAt, Date.now());
  if (!finalDecision.allowed) {
    // The shared budget disappeared during pre-provider work (the daily
    // ceiling check, this telemetry insert) — the provider is never called.
    // Recorded honestly rather than left as an indistinguishable orphaned
    // 'started' row: this operation reached telemetry but never reached the
    // model.
    await recordOperationCompleted(telemetryHandle, {
      status: "shared_budget_exhausted",
      latencyMs: Date.now() - preProviderStartedAt,
      errorClass: "shared_budget_exhausted",
    });
    return preserveAnswerAndFailRacerUnavailable(game, gameId, revisionAtLockTime);
  }

  // Step 3 — the Racer's turn, on narrowed public state only.
  //
  // S2 / RB-2 — bounded locally to finalDecision.allowanceMs (min(150s,
  // whatever remains of the shared 240s deadline AT THIS EXACT MOMENT) via
  // AbortController, and telemetered start-to-finish. The abort is a LOCAL
  // deadline only: it stops Barkóba from waiting, and must never be read as
  // stopping the remote provider's inference or its billing — see
  // lib/providers/types.ts's ToolCallRequest.signal doc.
  let turn: RacerTurnOutput;
  let provenance: ModelProvenance;
  const attemptStartedAt = Date.now();
  let attemptLatencyMs = 0;
  try {
    const racerResult = await runWithAbortTimeout(finalDecision.allowanceMs, (signal) =>
      runRacerTurn(racerState, {
        forceFinal,
        provider: racerProvider,
        signal,
        layerTwoState,
      })
    );
    turn = racerResult.output;
    provenance = racerResult.provenance;
    attemptLatencyMs = Date.now() - attemptStartedAt;
    // NOT finalized here: whether this lands as "accepted" or
    // "duplicate_rejected" is the duplicate-guard's verdict, which only the
    // caller (POST's produceCandidate closure) knows. telemetryHandle
    // and attemptLatencyMs travel with the returned attempt for exactly
    // that purpose — see the RacerAttempt field docs.
  } catch (err) {
    attemptLatencyMs = Date.now() - attemptStartedAt;
    const localTimeout = isLocalTimeoutError(err);
    // eslint-disable-next-line no-console
    console.error(
      `[barkoba] Racer call failed${localTimeout ? " (local timeout — Barkóba stopped waiting; the remote call may still be running)" : ""}:`,
      err
    );
    // modelId deliberately omitted — COALESCE(new, existing) in
    // recordOperationCompleted keeps the REQUESTED model this row was
    // inserted with (or created with directly, if the start write never
    // landed); a failed/timed-out attempt never learned a resolved model to
    // overwrite it with.
    await recordOperationCompleted(telemetryHandle, {
      status: localTimeout ? "self_timeout" : "provider_error",
      latencyMs: attemptLatencyMs,
      errorClass: localTimeout ? "self_timeout" : "provider_error",
    });
    return preserveAnswerAndFailRacerUnavailable(game, gameId, revisionAtLockTime);
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
          const resolution = await resolveGuessIntent(
            racerState,
            turn.question_text,
            racerProvider
          );
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

  return {
    ok: true,
    attempt: {
      turn,
      provenance,
      flagged,
      intentOutcome,
      preRevisionQuestion,
      telemetryHandle,
      attemptLatencyMs,
    },
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  // S2 / RB-2 — established ONCE, at route entry, before anything else: the
  // one absolute deadline every provider attempt in this invocation shares.
  // See lib/turnBudget.ts's module doc for why an absolute timestamp (not a
  // remaining-duration counter) is what makes time already spent by earlier
  // attempts and intervening work count automatically.
  const providerDeadlineAt = Date.now() + TURN_BUDGET_CONFIG.sharedDeadlineMs;

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

  // -------------------------------------------------------------------------
  // V2.8.6 R1 — this route answers the AI Racer's questions as the human
  // Composer. It never checked who was asking; any caller who knew or
  // guessed game_id could read the full transcript (via the idempotent
  // no-body poll below) or answer on the real Composer's behalf. seats.ts
  // already records composer_player_id for this mode at creation, so the
  // check costs no data-model change here — see app/api/game/create/route.ts.
  // -------------------------------------------------------------------------
  const playerId = await resolveActingPlayerId(req.headers);
  if (playerId === null) {
    return NextResponse.json(
      { error: "unauthenticated", message: "A játékhoz be kell azonosítanod magad." },
      { status: 401 }
    );
  }
  const seatCheck = requireSeatStrict(game, playerId, "composer");
  if (!seatCheck.ok) {
    if (seatCheck.error === "legacy_seat_unassigned") {
      // eslint-disable-next-line no-console
      console.warn(
        `[barkoba] game ${game.game_id}: no composer seat was ever recorded for this ` +
          "human-Composer game — refusing rather than assigning the caller retroactively."
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

  // ---------------------------------------------------------------------------
  // V2.8.1 — exact-question binding, the My Car Key integrity hotfix.
  //
  // CRITICAL INVARIANT: a human answer must never be applied to a question
  // unless the server can verify that answer was submitted for the exact
  // pending question/state it targets. Every ordinary public caller
  // submitting an answer MUST supply expected_revision — there is no
  // fallback to the old unsafe behavior. (Audited: GameClient.tsx is the
  // only caller of this route for the human-Composer/AI-Racer path; no
  // internal/benchmark caller answers questions through it.)
  //
  // This is a cheap, lock-free rejection of an OBVIOUSLY stale snapshot,
  // using the read already in hand. It is re-checked again below, against a
  // fresh read, once the turn lock is held — closing the gap between this
  // check and lock acquisition.
  // ---------------------------------------------------------------------------
  if (answer !== undefined) {
    if (typeof body.expected_revision !== "number") {
      return NextResponse.json(
        {
          error: "missing_expected_revision",
          message: "A válasznak tartalmaznia kell, melyik állapotra vonatkozik.",
        },
        { status: 400 }
      );
    }
    if (body.expected_revision !== game.revision) {
      return staleTurn(game);
    }
  }

  const pending = findPendingEntry(game);

  if (answer === undefined && pending) {
    // -----------------------------------------------------------------------
    // Idempotency guard. A pending question with no answer supplied means a
    // duplicate request — React strict-mode double-effect, a double click, a
    // client retry. Return what is already there instead of burning a model
    // call and desynchronising question_count. No mutation happens here, so
    // no lock is needed.
    // -----------------------------------------------------------------------
    return respond(game);
  }

  // ---------------------------------------------------------------------------
  // V2.8.1 — every mutation below (recording an answer, generating the next
  // turn) happens only while holding this game's turn lock. This is what
  // stops two concurrent requests — the true-concurrency case, distinct from
  // a sequential stale retry — from both paying for a Racer call against the
  // same pending question. The revision CAS at every save below is the
  // actual data-integrity guarantee; this lock exists only to avoid wasting
  // a paid LLM call on a request that CAS would discard anyway.
  // ---------------------------------------------------------------------------
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
    // between the read above and lock acquisition.
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
    if (answer !== undefined && body.expected_revision !== game.revision) {
      return staleTurn(game);
    }

    const pending = findPendingEntry(game);
    if (answer === undefined && pending) {
      // Someone else's request produced the next question while this one
      // waited for the lock. Same idempotency case as above, just discovered
      // after acquiring the lock instead of before it.
      return respond(game);
    }

    // The revision every save in this request must be conditioned on. Fixed
    // once, at the moment the lock was confirmed to guard a consistent
    // snapshot — every exit path below saves against this same value.
    const revisionAtLockTime = game.revision;

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
      // V2.5 — `timestamp` is when the Racer's question was created; this is
      // when the human answered it. Without both, the only derivable
      // quantity was the interval to the next turn, which also contains the
      // model call, so think time and model latency were inseparable.
      pending.answered_at = new Date().toISOString();

      if (answer === "AMBIGUOUS") {
        pending.ambiguous_explanation = (body.ambiguous_explanation || "").trim() || null;
        // Unlimited in COUNT — there is no quota — but not free.
        // ambiguous_count is tracked separately as the input to later abuse
        // analysis, never as a discount on the Racer's budget.
        game.ambiguous_count += 1;
      } else {
        pending.ambiguous_explanation = null;
      }

      // V2.8.5 — the "+1" corridor (lib/sandboxClarification.ts) is a
      // private exchange with the Setter, never a Racer question: it must
      // consume no budget. Every ordinary question still costs one of the
      // 20, whatever answer comes back — YES, NO and AMBIGUOUS are worth
      // exactly one question.
      if (!isSandboxClarificationEntry(pending)) {
        const questionCountBefore = game.question_count;
        game.question_count += 1;
        // V2.8.4.2 — correction-budget integrity. Keeps the durable floor in
        // step with ordinary play, so the very first correction (if any) has
        // an accurate mark to freeze rather than starting from a stale one.
        game.question_count_high_water_mark = advanceHighWaterMark(
          questionCountBefore,
          game.question_count_high_water_mark,
          game.question_count
        );
      }
    }

    // -------------------------------------------------------------------------
    // Step 1b — an outstanding clue request blocks the Racer.
    //
    // When the Racer spends a credit it is waiting on a human, exactly as it
    // waits on an answer. findPendingEntry only recognises unanswered
    // QUESTIONS, so without this the Racer would take another turn
    // immediately and the Composer would never get to write the clue.
    // -------------------------------------------------------------------------
    if (pendingClueRequest(game)) {
      const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
      if (!saved.ok) {
        // Structurally shouldn't happen while holding the lock — see the
        // final revision-CAS save below for the same defensive check.
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

    // -------------------------------------------------------------------------
    // Step 2/3/4 setup — the Racer's turn, on narrowed public state only.
    // -------------------------------------------------------------------------
    // V2.8.4.2 — correction-budget integrity. Uses the durable high-water
    // mark, not the possibly-lower recomputed question_count, so a
    // correction that discarded trailing answered questions cannot buy back
    // turns that were already spent. See lib/rewind.ts's effectiveConsumed.
    const forceFinal = effectiveConsumed(game) >= game.max_questions;

    // -------------------------------------------------------------------------
    // V2.8.4 — Runtime Phase One v6.1. Deterministic sandbox classification,
    // zero provider calls. lib/phaseOne.ts replays game.qa_log fresh on every
    // call — nothing here needs to invalidate or track a separate position:
    // a correction's rewind already truncates qa_log before the next /turn
    // call reaches this point, so the next derivation is automatically
    // correct. `forceFinal` bypasses Phase One deliberately — Phase One never
    // guesses, so a forced final turn must always reach the model Racer,
    // carrying whatever partial classification exists so far.
    // -------------------------------------------------------------------------
    const phaseOneState = derivePhaseOneState(game.qa_log, game.game_language);
    if (!phaseOneState.complete && phaseOneState.unresolved) {
      // V2.8.4.1 correction — REFERENT SCOPE, doubly ambiguous (IS-IS on
      // both the primary question and its deterministic clarification).
      // Referent scope is the Setter's own choice, not an external fact —
      // Phase One does not guess a value here, and this must never reach the
      // provider. Nothing further to generate, but the human's own just-
      // recorded IS-IS answer (Step 1, above) must still be persisted —
      // this is the same save every other no-new-turn exit path in this
      // route already performs (see Step 1b, just above). The Setter
      // resolves this the ordinary way, by correcting one of the two scope
      // answers.
      const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
      if (!saved.ok) {
        // eslint-disable-next-line no-console
        console.error(
          `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId}) ` +
            `during the unresolved-referent-scope block; expected ${revisionAtLockTime}, actual ${saved.revision}`
        );
        const canonical = await getGame(gameId);
        return staleTurn(canonical ?? game);
      }
      game.revision = saved.revision;
      return respond(game);
    }
    if (!phaseOneState.complete && !forceFinal) {
      const entry = newLogEntry(game.qa_log.length + 1);
      entry.turn_type = "question";
      entry.question_text = phaseOneState.nextQuestionText;
      entry.racer_output_raw = JSON.stringify({
        action: "question",
        question_text: phaseOneState.nextQuestionText,
        guess_text: null,
        rationale: "phase_one_deterministic",
      });
      // model_id / model_provider / prompt_version / latency_ms stay at
      // newLogEntry's own defaults (null) — the schema's existing, honest
      // "no model authored this turn" representation. No sentinel invented.
      game.qa_log.push(entry);

      const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
      if (!saved.ok) {
        // Same defensive check as Step 5 below — structurally shouldn't
        // happen while holding the turn lock.
        // eslint-disable-next-line no-console
        console.error(
          `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId}) ` +
            `during Phase One; expected ${revisionAtLockTime}, actual ${saved.revision}`
        );
        const canonical = await getGame(gameId);
        return staleTurn(canonical ?? game);
      }
      game.revision = saved.revision;
      return respond(game);
    }

    // -------------------------------------------------------------------------
    // V2.8.5 — the "+1" corridor (lib/sandboxClarification.ts). Phase One
    // classified this game "unclassified": before Layer Two's adaptive
    // routing ever reaches the model, ask the Setter privately which
    // intended sense governs. Consumes no Racer question (the Step 1
    // increment above is skipped for these entries specifically) and never
    // reaches the Racer's transcript (lib/racerState.ts filters them out) —
    // only the resulting sandbox contract does, via the ordinary
    // racerState.phase_one summary below.
    // -------------------------------------------------------------------------
    let effectiveSandbox = phaseOneState.sandbox;
    let clarificationMixedSenses: [string, string] | null = null;
    if (phaseOneState.complete && phaseOneState.sandbox === "unclassified" && !forceFinal) {
      const clarificationState = deriveSandboxClarificationState(game.qa_log, game.game_language);

      if (!clarificationState.complete) {
        const entry = newLogEntry(game.qa_log.length + 1);
        entry.question_text = clarificationState.nextQuestionText;
        entry.racer_output_raw = sandboxClarificationRawOutput(clarificationState.nextQuestionText);
        game.qa_log.push(entry);

        const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
        if (!saved.ok) {
          // eslint-disable-next-line no-console
          console.error(
            `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId}) ` +
              `during the +1 sandbox-clarification corridor; expected ${revisionAtLockTime}, actual ${saved.revision}`
          );
          const canonical = await getGame(gameId);
          return staleTurn(canonical ?? game);
        }
        game.revision = saved.revision;
        return respond(game);
      }

      if (clarificationState.failed) {
        // Section 14 — no coherent contract could be established. The
        // Composer's own just-recorded answer must still be persisted, but
        // no further turn is generated and the game does not resolve to any
        // outcome — reframing/restart is required, exactly as specified,
        // never unrestricted guessing.
        const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
        if (!saved.ok) {
          // eslint-disable-next-line no-console
          console.error(
            `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId}) ` +
              `during the +1 sandbox-clarification corridor's failure path`
          );
          const canonical = await getGame(gameId);
          return staleTurn(canonical ?? game);
        }
        game.revision = saved.revision;
        return NextResponse.json(
          {
            error: "sandbox_clarification_failed",
            message: SANDBOX_CLARIFICATION_FAILED_MESSAGE[game.game_language],
            game,
          },
          { status: 409 }
        );
      }

      effectiveSandbox = clarificationState.resolvedSandbox;
      clarificationMixedSenses = clarificationState.mixedSenses;
    }

    // -------------------------------------------------------------------------
    // V2.8.5 — Layer Two traversal state, derived EARLY (before the mandatory
    // gate check below). V2.8.5 FINAL ENGINE-CONTRACT CORRECTION (finding 2)
    // — this must happen before the gate check specifically so a successful
    // sandbox repair's ACTIVE sandbox (not Phase One's original one) is what
    // gets gated: a repair from Physical into Living/Place is brand new
    // territory this game has never faced a gate for, and skipping that gate
    // would let the repaired card activate without ever asking the
    // whole-organism/Earth-membership question section 10/12 requires.
    // -------------------------------------------------------------------------
    let layerTwoState: LayerTwoState | undefined;
    if (phaseOneState.complete && effectiveSandbox !== null && effectiveSandbox !== "unclassified") {
      layerTwoState = deriveLayerTwoState(game.qa_log, effectiveSandbox);
    }
    const activeSandboxForGate = layerTwoState?.activeSandbox ?? effectiveSandbox;

    // -------------------------------------------------------------------------
    // V2.8.5 — Living/Place mandatory deterministic opening gates (sections
    // 10, 12). Zero model involvement, exactly like Phase One's own spine —
    // injected before Layer Two's adaptive routing ever reaches the model,
    // and never on the forced-final turn (which must always reach the model
    // to produce the mandatory guess). Gated on the ACTIVE sandbox (which a
    // successful repair may have changed), never the raw Phase One result.
    // -------------------------------------------------------------------------
    if ((activeSandboxForGate === "living" || activeSandboxForGate === "place") && !forceFinal) {
      const gate = nextMandatoryGate(
        game.qa_log,
        activeSandboxForGate,
        // Guaranteed non-null here: activeSandboxForGate can only be
        // "living"/"place" if effectiveSandbox itself was ("living"/"place",
        // hence non-null) OR layerTwoState exists (which requires
        // effectiveSandbox !== null to have been derived at all).
        effectiveSandbox!,
        phaseOneState.specificity,
        game.game_language
      );
      if (gate) {
        const entry = newLogEntry(game.qa_log.length + 1);
        entry.question_text = gate.questionText;
        entry.racer_output_raw = JSON.stringify({
          action: "question",
          question_text: gate.questionText,
          guess_text: null,
          rationale: "layer_two_deterministic",
          ...gate.meta,
        });
        game.qa_log.push(entry);

        const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
        if (!saved.ok) {
          // eslint-disable-next-line no-console
          console.error(
            `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId}) ` +
              `during a Layer Two mandatory gate; expected ${revisionAtLockTime}, actual ${saved.revision}`
          );
          const canonical = await getGame(gameId);
          return staleTurn(canonical ?? game);
        }
        game.revision = saved.revision;
        return respond(game);
      }
    }

    const racerState = toRacerPublicState(game);
    if (phaseOneState.complete && effectiveSandbox !== null) {
      // V2.8.5 — Layer Two only applies once a real sandbox is in effect;
      // "unclassified" without a resolved +1 contract never reaches here
      // (the corridor above always returns first in that case).
      if (layerTwoState) {
        // ENGINE-CONTRACT CORRECTION (defect 3) — racerState.phase_one.sandbox
        // reflects the REPLAY-DERIVED effective sandbox (originalSandbox,
        // unless a repair succeeded with YES), never the historical Phase One
        // result directly. Phase One's own record (phaseOneState.sandbox,
        // still exactly `effectiveSandbox` here before any repair) is never
        // overwritten anywhere — this is a card-selection value only.
        racerState.phase_one = {
          sandbox: layerTwoState.activeSandbox,
          specificity: phaseOneState.specificity,
          mixed_spine_questions: phaseOneState.mixedSpineQuestions,
        };
        racerState.layer_two = {
          activeDimension: layerTwoState.activeDimension,
          stalledDimensions: Array.from(layerTwoState.stalledDimensions),
          blockedPropositions: Array.from(layerTwoState.blockedPropositions),
          typicalOnlySupported: Array.from(layerTwoState.typicalOnlySupported),
          contestedPropositions: Array.from(layerTwoState.contestedPropositions),
          pendingPremiseAudit: layerTwoState.pendingPremiseAudit,
          sandboxRepairUsed: layerTwoState.sandboxRepairUsed,
          secondarySense: clarificationMixedSenses ? clarificationMixedSenses[1] : null,
          originalSandbox: layerTwoState.originalSandbox,
          activeSandbox: layerTwoState.activeSandbox,
          repairContested: layerTwoState.repairContested,
          livingRoute:
            layerTwoState.activeSandbox === "living" ? resolveLivingRoute(game.qa_log, phaseOneState.specificity) : null,
          placeRoute: layerTwoState.activeSandbox === "place" ? resolvePlaceRoute(game.qa_log) : null,
        };
      } else {
        racerState.phase_one = {
          sandbox: effectiveSandbox,
          specificity: phaseOneState.specificity,
          mixed_spine_questions: phaseOneState.mixedSpineQuestions,
        };
      }
    }

    // V2.5-B3 — WHO is playing this seat, read from the game and not from the
    // request. Fixed at creation; every turn of a game reaches the same provider.
    //
    // A stored value that is no longer a registered provider REFUSES the turn.
    // The alternative — quietly playing the rest of the game on Anthropic — would
    // produce one game whose turns were played by two different models while the
    // transcript read as one continuous player. That is worse than a stalled
    // game: it is evidence that looks correct and is not.
    let racerProvider: ModelProviderId;
    if (game.racer_provider === null || game.racer_provider === undefined) {
      racerProvider = DEFAULT_RACER_PROVIDER;
    } else if (isModelProviderId(game.racer_provider)) {
      racerProvider = game.racer_provider;
    } else {
      // eslint-disable-next-line no-console
      console.error(
        `[barkoba] game ${game.game_id} names unknown racer_provider ` +
          `"${game.racer_provider}" — refusing rather than substituting a model.`
      );
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
    // Steps 2–4, retried on an exact-duplicate question. This calls the exact
    // same loop implementation (lib/duplicateQuestionGuard.ts) that
    // test/duplicateQuestionGuard.test.ts exercises against a mock producer —
    // there is one implementation of the guard, not a route copy and a tested
    // description of it. The prior main-branch questions are captured once,
    // before the loop: no attempt is persisted to qa_log until one is accepted
    // below, so the comparison set is stable across retries. Every attempt
    // (including the duplicate-guard's own failure/exhaustion exits) runs
    // inside the SAME turn-lock section as Step 1 above, and saves through
    // the SAME revision-CAS primitive — the guard and the My Car Key
    // integrity binding are not two independently-protected mechanisms
    // bolted together, they share the one save path that actually holds the
    // integrity invariant.
    // -------------------------------------------------------------------------
    const priorQuestions = priorAskedQuestions(game.qa_log);

    // S2 / RB-2 — 1-based position within this loop, for telemetry only.
    // MAX_DUPLICATE_QUESTION_ATTEMPTS stays 3; this does not change how many
    // attempts the guard may make, only how much shared provider time each
    // one may draw on (runOneRacerAttempt's own budget gate).
    let attemptNumber = 0;

    const guardResult = await runWithDuplicateQuestionGuard<RacerAttempt, NextResponse>(
      priorQuestions,
      MAX_DUPLICATE_QUESTION_ATTEMPTS,
      async () => {
        attemptNumber += 1;
        const outcome = await runOneRacerAttempt(
          game,
          racerState,
          forceFinal,
          racerProvider,
          gameId,
          revisionAtLockTime,
          providerDeadlineAt,
          attemptNumber,
          layerTwoState
        );
        if (!outcome.ok) return { ok: false, failure: outcome.response };

        // S2 / RB-2 — finalize THIS attempt's telemetry now: only here is the
        // duplicate-guard's verdict (accepted vs duplicate_rejected) known.
        // Recomputing it with the guard's own exported isDuplicateQuestion
        // (not a copy) is cheap, pure, in-memory string comparison — the
        // guard immediately below makes the SAME, authoritative check;
        // this only decides what gets written to telemetry.
        const { action, question_text } = outcome.attempt.turn;
        const isDuplicate =
          action === "question" && !!question_text && isDuplicateQuestion(question_text, priorQuestions);
        await recordOperationCompleted(outcome.attempt.telemetryHandle, {
          status: isDuplicate ? "duplicate_rejected" : "accepted",
          latencyMs: outcome.attempt.attemptLatencyMs,
          errorClass: null,
          // S2 review fix — a successful call is the first point the
          // RESOLVED model is known; overwrite the requested-model value
          // this row was inserted with. resolvedModel differs from the
          // requested id whenever a configured alias resolves to a dated
          // snapshot (see racer.ts's own provenance doc).
          modelId: outcome.attempt.provenance.model_id,
        });

        return { ok: true, candidate: outcome.attempt };
      },
      (attempt) => attempt.turn
    );

    for (const blockedQuestion of guardResult.blockedQuestions) {
      // eslint-disable-next-line no-console
      console.warn(
        `[barkoba] duplicate-question guard: blocked exact-repeat candidate on game ` +
          `${game.game_id}: "${blockedQuestion}"`
      );
    }

    if (guardResult.status === "attempt_failed") {
      return guardResult.failure;
    }

    if (guardResult.status === "exhausted") {
      // Retry cap exhausted and every candidate was an exact duplicate. Reuse
      // the existing safe non-emission path unchanged: preserve the recorded
      // answer, emit nothing to the Composer, never fabricate a turn or invent
      // a new gameplay outcome to make this pass. Never a concede, never a
      // consumed final guess — nothing below appends a turn or transitions
      // phase.
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
          error: "racer_unavailable",
          message: "Az ellenfeled most nem tudott lépni. Próbáld újra.",
          game,
        },
        { status: 502 }
      );
    }

    const { turn, provenance, flagged, intentOutcome, preRevisionQuestion } = guardResult.candidate;

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
    // S2 / RB-2 — the provider attempt that PRODUCED this accepted question.
    // The durable corpus.turn_operations table (migrations/0012) records
    // every attempt including rejected duplicates and failures; this field
    // records only the one that won. Not a competing latency field — the
    // dormant column QuestionLogEntry already had, now populated.
    entry.latency_ms = guardResult.candidate.attemptLatencyMs;
    // The other dormant fields (quality_score, information_gain,
    // strategy_classification, integrity_flag, confidence) stay null. They
    // are schema-ready, not implemented — populating them is a separate,
    // explicit decision.

    game.qa_log.push(entry);

    if (turn.action === "guess" || turn.action === "concede") {
      game.phase = "resolving";
      game.final_action = turn.action;
      game.final_guess_text = turn.guess_text;
    }

    const saved = await saveGameIfRevisionMatches(game, revisionAtLockTime);
    if (!saved.ok) {
      // Structurally shouldn't happen: this whole block runs while holding
      // the per-game turn lock, so nothing else could have advanced the
      // revision since revisionAtLockTime was read. Reaching this means the
      // lock was somehow bypassed or its TTL expired mid-request — a defect
      // worth investigating, not a normal user-facing outcome. Fail exactly
      // like an ordinary stale request rather than silently overwriting
      // whatever DID land.
      // eslint-disable-next-line no-console
      console.error(
        `[barkoba] unexpected revision mismatch while holding the turn lock (game ${gameId}); ` +
          `expected ${revisionAtLockTime}, actual ${saved.revision}`
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
