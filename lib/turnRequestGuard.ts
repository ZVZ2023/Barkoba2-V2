import { pendingClueRequest } from "./clueCredits";
import type { GamePhase, GameRecord, QuestionLogEntry } from "./types";
import type { GameView, ViewTurn } from "./gameView";

// ---------------------------------------------------------------------------
// S1 / RB-1 — client-side request ownership and canonical-truth reconciliation.
//
// Pure, no React, no fetch — the same reason lib/turnRecovery.ts's
// shouldAutoRequestTurn/shouldOfferTurnRetry and
// lib/duplicateQuestionGuard.ts's runWithDuplicateQuestionGuard are pure:
// this IS the thing that broke (GameClient.sendTurn() has no
// request-ownership/staleness guard), so it is unit-tested directly rather
// than implied by the control flow of a React effect nobody can run in this
// project's test suite (no jsdom/testing-library dependency exists here).
// app/game/[id]/GameClient.tsx calls this SAME function against real
// fetch()/setState; test/turnRequestGuard.test.ts drives it with mocks.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS REPAIRS
// ---------------------------------------------------------------------------
//
// sendTurn() had no way to tell "am I still the request that gets to decide
// what the screen shows?" A slower, older request's `catch`/`finally` could
// fire AFTER a newer request had already applied canonical server state,
// silently clobbering it with a stale "Hálózati hiba — próbáld újra." banner
// and a stale `turnFailed`/`busy`.
//
// A SECOND, RELATED GAP: on a transport failure (rejected fetch, non-JSON
// body, or a body missing the `game` field every real /turn response
// carries), the client assumed failure outright, even though the server may
// already have saved the turn — the exact incident this ticket's forensic
// audit reconstructed (Q1 generated and persisted server-side while the
// client's own connection had already given up).
//
// ---------------------------------------------------------------------------
// THE FIX, IN TWO PARTS
// ---------------------------------------------------------------------------
//
// 1. RequestOwnership — a monotonic counter. Every call to sendTurn "begins"
//    a new token; only the MOST RECENTLY begun token may mutate anything.
//    Deliberately NOT built on AbortController: aborting a browser fetch
//    proves nothing about whether the server (or the model call behind it)
//    actually stopped, so an aborted request could still complete and save —
//    exactly the scenario this ticket's audit found. Ownership therefore
//    governs which callback's RESULT is trusted, not whether the underlying
//    work continues.
//
// 2. runOwnedTurnRequest — on a transport-level failure (see above), performs
//    ONE canonical read through GET /api/game/[id]/view (never a second
//    /turn call) and applies its result only if it shows genuine progress
//    (a pending question, a pending clue, an advanced qa_log, or an advanced
//    phase). If reconciliation shows nothing changed, or reconciliation
//    itself fails, the existing recoverable-error / explicit-retry behavior
//    is preserved unchanged — no automatic retry loop is introduced.
// ---------------------------------------------------------------------------

export interface RequestOwnership {
  /** Claim ownership for a new request. Returns a token identifying it. */
  begin(): number;
  /** Is `token` still the most recently begun request? */
  isCurrent(token: number): boolean;
}

/**
 * A fresh, independent ownership tracker — one per mounted game screen.
 * Deliberately not a React hook: it holds no more state than a plain counter
 * needs, so it is trivial to construct in a test with no `renderHook`.
 */
export function createRequestOwnership(): RequestOwnership {
  let latest = 0;
  return {
    begin(): number {
      latest += 1;
      return latest;
    },
    isCurrent(token: number): boolean {
      return token === latest;
    },
  };
}

// ---------------------------------------------------------------------------
// Canonical-truth reconciliation.
// ---------------------------------------------------------------------------

/**
 * The shape every real POST /api/game/[id]/turn response carries, success or
 * documented failure alike (see app/api/game/[id]/turn/route.ts — every exit
 * path returns `{ game, ... }`, and every error path additionally carries
 * `error`/`message`). A response missing `game` entirely is therefore never
 * a documented server outcome — it is exactly the "unusable response body"
 * case reconciliation exists for.
 */
export interface TurnResponseBody {
  game?: GameRecord;
  error?: string;
  message?: string;
}

/** One attempt's raw HTTP facts, already JSON-parsed by the caller's `io`. */
export interface TurnRequestResult {
  ok: boolean;
  data: TurnResponseBody | null | undefined;
}

export interface ViewRequestResult {
  ok: boolean;
  view: GameView | null;
}

/**
 * The transport seam. Both methods are expected to REJECT on any transport or
 * parse failure (a rejected fetch, a non-JSON body) — runOwnedTurnRequest
 * treats a rejection and a resolved-but-unusable body identically, per S1's
 * requirement that both route to the same reconciliation path.
 */
export interface TurnRequestIO {
  /**
   * V2.8.5.1 — `signal` aborts the underlying transport when this module's
   * own CLIENT_TURN_TIMEOUT_MS elapses, or when GameClient.tsx's
   * `visibilitychange` handler decides a busy request is stale (see
   * `ActiveRequestHandle` below). The caller (GameClient.tsx) MUST forward
   * this to its `fetch()` call for either abort path to have any real
   * effect on the actual network request.
   */
  requestTurn(signal: AbortSignal): Promise<TurnRequestResult>;
  requestView(): Promise<ViewRequestResult>;
}

/**
 * V2.8.5.1 — a live request's abort handle plus when it began, so a caller
 * (GameClient.tsx's `visibilitychange` handler) can decide independently
 * whether THIS specific in-flight request has been running long enough to
 * be considered stale, and abort it directly if so — reusing the exact same
 * ownership-gated abort→reconcile path CLIENT_TURN_TIMEOUT_MS itself
 * triggers, rather than a second, competing mechanism.
 */
export interface ActiveRequestHandle {
  abort(): void;
  startedAt: number;
}

/** Every piece of state S1 requires to be ownership-guarded. */
export interface TurnRequestState {
  getGame(): GameRecord;
  setGame(game: GameRecord): void;
  setError(message: string | null): void;
  setTurnFailed(failed: boolean): void;
  setBusy(busy: boolean): void;
  setAmbiguousMode(active: boolean): void;
  setExplanation(text: string): void;
  /** The auto-turn effect's own `autoTurnFor.current = null`. */
  clearAutoTurnGuard(): void;
  /**
   * V2.8.4.1 — the server's turn lock is already held by another in-flight
   * request (see acquireTurnLock in app/api/game/[id]/turn/route.ts),
   * typically a still-finishing provider call from a prior attempt. This is
   * transient, not a failure: true schedules a quiet, bounded retry rather
   * than a dead-looking error banner requiring a manual tap. See
   * GameClient.tsx's own awaitingTurnLock effect.
   */
  setTurnInProgress(inProgress: boolean): void;
  /**
   * V2.8.5 ENGINE-CONTRACT CORRECTION (defect 5) — the "+1" private
   * sandbox-clarification corridor (lib/sandboxClarification.ts) reached its
   * truthful "no coherent contract" terminal state. Optional and additive:
   * existing callers/tests that never construct this scenario need not
   * implement it, and its absence falls back to the pre-existing generic
   * error banner exactly as before.
   */
  setSandboxClarificationFailed?(failed: boolean): void;
  /**
   * V2.8.5.1 — registers/clears the CURRENT request's abort handle so
   * GameClient.tsx's `visibilitychange` handler can abort a stale one
   * directly (see ActiveRequestHandle). Optional and additive: existing
   * callers/tests that never need foreground-staleness recovery need not
   * implement it, and its absence simply means CLIENT_TURN_TIMEOUT_MS's own
   * internal timer is the only thing that can ever abort the request.
   */
  registerActiveRequest?(handle: ActiveRequestHandle): void;
  clearActiveRequest?(): void;
}

export const NETWORK_ERROR_MESSAGE = "Hálózati hiba — próbáld újra.";

/**
 * V2.8.6 R1 Commit 2 — the documented identity/seat application errors
 * /turn, /correct, /ask and /clue can now return. Every one of them omits
 * `game` from its response body by design (see the R1 security commit and
 * its FIXED NULL-SEAT POLICY: an unauthorized caller learns nothing about
 * the game, not even its shape) — which is exactly what the ORIGINAL
 * `!result.data.game` check below could not tell apart from a genuine
 * transport failure. This is the seam that closes that gap: a response
 * carrying one of these codes is a real, documented server answer and must
 * never be treated as "the request didn't really happen."
 *
 * `identity_unavailable` is included even though no server route emits it
 * yet (that lands in R1 Commit 3) — recognizing it here now means the
 * client is never a release behind the server's own error taxonomy.
 */
export const AUTH_APPLICATION_ERRORS = new Set([
  "unauthenticated",
  "not_a_participant",
  "wrong_seat",
  "restart_required",
  "identity_unavailable",
  // V2.8.6 R2 — /ask's edit_turn_index local time-budget gate (see
  // app/api/game/[id]/ask/route.ts). Not an auth failure, but the same
  // "documented, non-retryable application outcome, never a transport
  // failure" treatment applies: the response always carries `game`, must
  // never be reconciled through /view, and must never be auto-retried.
  "budget_exhausted",
]);

export function isAuthApplicationError(error: unknown): boolean {
  return typeof error === "string" && AUTH_APPLICATION_ERRORS.has(error);
}

/**
 * V2.8.5.1 — the client's own bound on how long a single /turn request may
 * run before this module gives up waiting and reconciles through canonical
 * truth instead. Chosen from EXISTING server-side timing, not invented:
 * app/api/game/[id]/turn/route.ts documents the ordering
 * sharedDeadlineMs (240s, lib/turnBudget.ts) < maxDuration (270s, the
 * route's own Vercel execution ceiling — the platform kills the function by
 * then, no matter what) < TURN_LOCK_TTL_SECONDS (300s, when a legitimate
 * retry may safely re-acquire the lock). 300_000ms matches that last value
 * deliberately: by the time THIS client gives up, the SERVER's own lock
 * would already have expired too, so an explicit retry after this timeout
 * can never race a still-legitimately-running attempt on the lock alone —
 * the existing turn_in_progress handling covers the remaining overlap.
 *
 * THE DEFECT THIS REPAIRS — the "silent stall" forensic (game
 * 6c55682c-b60d-414b-8c0c-1b6a1c8248d8, V2.8.5 production). Before this,
 * `await io.requestTurn()` below had no bound at all: a fetch a backgrounded
 * mobile browser silently suspended or discarded (neither resolving nor
 * rejecting, ever) left `busy` stuck true forever, which in turn defeated
 * GameClient.tsx's own `visibilitychange` reconciliation (guarded by
 * `if (busy) return`, on the — here false — assumption that an in-flight
 * request always eventually settles). No error, no retry, no thinking
 * indicator, no progress: a game frozen with no way back.
 */
export const CLIENT_TURN_TIMEOUT_MS = 300_000;

/**
 * V2.8.6 R2 — /ask's own client-side wait bound, mirroring
 * CLIENT_TURN_TIMEOUT_MS's derivation but scaled to /ask's own numbers:
 * app/api/game/[id]/ask/route.ts sets maxDuration=90s and its own turn-lock
 * TTL to 120s. 120_000ms matches the lock TTL for the same reason
 * CLIENT_TURN_TIMEOUT_MS matches /turn's: by the time this client gives up,
 * the server's own lock would already have expired too, so a retry after
 * this timeout cannot race a still-legitimately-running attempt on the lock
 * alone.
 */
export const ASK_CLIENT_TIMEOUT_MS = 120_000;

/**
 * V2.8.6 R2 — /clue's own client-side wait bound. app/api/game/[id]/clue/
 * route.ts keeps maxDuration=60s (unchanged) and sets its turn-lock TTL to
 * 90s; both clue directions share it. Same derivation as ASK_CLIENT_TIMEOUT_MS.
 */
export const CLUE_CLIENT_TIMEOUT_MS = 90_000;

/**
 * Reconstruct a GameRecord-shaped QuestionLogEntry from a role-narrowed
 * ViewTurn. GameView deliberately omits every GameRecord-only field
 * (provenance, edit history, the dormant Game-Intelligence columns) — see
 * lib/gameView.ts's own module doc on why that narrowing is structural, not
 * an oversight. None of the omitted fields are read anywhere in
 * GameClient.tsx's rendering, so a synthesized placeholder is exactly as
 * correct as the real value for this purpose. `existing`, when the client
 * already knew this turn_index, is preferred wholesale for those fields so a
 * turn already on screen keeps its real id (a stable React key) rather than
 * being silently reissued a new one on every reconciliation.
 */
function toQuestionLogEntry(turn: ViewTurn, existing: QuestionLogEntry | undefined): QuestionLogEntry {
  if (existing) {
    return {
      ...existing,
      turn_type: turn.turn_type,
      question_text: turn.question_text,
      guess_text: turn.guess_text,
      clue_text: turn.clue_text,
      composer_response: turn.composer_response,
      ambiguous_explanation: turn.ambiguous_explanation,
    };
  }
  return {
    id: `view:${turn.turn_index}`,
    turn_index: turn.turn_index,
    turn_type: turn.turn_type,
    racer_output_raw: "",
    question_text: turn.question_text,
    guess_text: turn.guess_text,
    composer_response: turn.composer_response,
    ambiguous_explanation: turn.ambiguous_explanation,
    guess_detector_flagged: false,
    guess_detector_method: null,
    timestamp: "",
    guess_intent_outcome: null,
    clue_text: turn.clue_text,
    ambiguous_consumed_credit: false,
    original_question_text: null,
    edit_status: null,
    edit_reason: null,
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

/**
 * Merge a GET /view read into the last known-good GameRecord.
 *
 * S1 REVIEW FOLLOW-UP — CORRECTED. The original version of this function
 * deliberately preserved the client's old `revision`, reasoning that the
 * existing stale_turn path would self-correct on the next mutation attempt.
 * A focused test proved that "self-correction" is not benign: it means the
 * player's next answer is REJECTED (409 stale_turn) on its first submit, the
 * server never records it, and GameClient's existing stale_turn handling
 * does not resubmit automatically — the player must notice the question
 * reappeared and answer AGAIN, and any typed IS-IS explanation is discarded
 * in the meantime (see test/staleRevisionReconciliation.test.ts). CONFIRMED
 * DEFECT, not confirmed-benign.
 *
 * The fix: GameView now carries `record_revision`, the ACTUAL
 * GameRecord.revision (the V2.8.1 My Car Key CAS counter) — a field
 * DISTINCT from `view.revision` (lib/gameView.ts's own derived
 * qa_log-length/answered-count poll marker, load-bearing for Human↔Human's
 * /hh/turn staleness check and never repurposed here). Applying the real
 * value obtained from the SAME /view call already made during
 * reconciliation — no second request — means the very next answer the
 * player submits is accepted on its first try, exactly as if the original
 * /turn response had reached the client successfully.
 */
export function mergeViewIntoGame(current: GameRecord, view: GameView): GameRecord {
  const existingByIndex = new Map(current.qa_log.map((entry) => [entry.turn_index, entry]));
  const qa_log = view.turns.map((turn) => toQuestionLogEntry(turn, existingByIndex.get(turn.turn_index)));

  return {
    ...current,
    revision: view.record_revision,
    phase: view.phase as GamePhase,
    question_count: view.question_count,
    ambiguous_count: view.ambiguous_count,
    qa_log,
    final_action: view.final_action,
    final_guess_text: view.final_guess_text,
    result: view.result,
    adjudication_notes: view.adjudication_notes,
    integrity_notes: view.integrity_notes,
    revealed_target: view.revealed_target,
  };
}

/** The pending (unanswered) question entry, or null — mirrors pendingClueRequest's shape. */
function pendingQuestionEntry(game: GameRecord): QuestionLogEntry | null {
  const last = game.qa_log[game.qa_log.length - 1];
  if (last && last.turn_type === "question" && last.composer_response === null) return last;
  return null;
}

/**
 * Did reconciliation actually show progress? True for any of S1's four
 * named signals: a NEW pending question, a NEW pending clue request, an
 * advanced qa_log, or an advanced phase — PLUS an advanced `revision` (the
 * real GameRecord.revision, now that mergeViewIntoGame applies it from
 * `view.record_revision`; see the S1-review-follow-up doc on that
 * function). Checked explicitly rather than assumed-subsumed: a write that
 * bumps revision without changing qa_log length or phase is possible in
 * principle (a correction that replaces content without truncating the
 * log), and reconciliation should recognize it as progress too.
 *
 * CONFIRMED-DEFECT FIX — pending-question and pending-clue checks are
 * RELATIVE to `before`, not absolute facts about `after`. The original
 * absolute check ("is anything pending in `after`?") returned true even
 * when the SAME still-unanswered question was pending in `before` too —
 * exactly the case where the player's own answer was lost in transit and
 * reconciliation must NOT silently clear the error, because nothing
 * actually advanced. A pending item counts as progress only when its
 * turn_index differs from whatever (if anything) was already pending at
 * `before` — a genuinely new question or clue, not a stale echo of the one
 * the player just tried and failed to answer.
 */
export function reconciliationShowsProgress(before: GameRecord, after: GameRecord): boolean {
  if (after.revision > before.revision) return true;
  if (after.qa_log.length > before.qa_log.length) return true;
  if (after.phase !== before.phase) return true;
  if (after.question_count > before.question_count) return true;

  const afterPendingQuestion = pendingQuestionEntry(after);
  if (afterPendingQuestion && afterPendingQuestion.turn_index !== pendingQuestionEntry(before)?.turn_index) {
    return true;
  }

  const afterPendingClue = pendingClueRequest(after);
  if (afterPendingClue && afterPendingClue.turn_index !== pendingClueRequest(before)?.turn_index) {
    return true;
  }

  return false;
}

/**
 * The full owned-request workflow: run the mutating /turn call, and on any
 * transport-level failure, reconcile against canonical truth exactly once
 * before deciding what the screen should show. Every state mutation below is
 * gated on the token that began this call still being the most recent one —
 * see RequestOwnership. A superseded call's success, failure, or reconciled
 * outcome therefore CANNOT overwrite what a newer call already established.
 */
export async function runOwnedTurnRequest(
  ownership: RequestOwnership,
  io: TurnRequestIO,
  state: TurnRequestState,
  // V2.8.5.1 — defaults to CLIENT_TURN_TIMEOUT_MS; overridable so a focused
  // test can exercise a real timeout firing without waiting 300 real
  // seconds, without resorting to a mutable shared config object (unlike
  // lib/turnBudget.ts's TURN_BUDGET_CONFIG, nothing here is shared across
  // concurrent requests, so a plain parameter is simpler and needs no
  // save/restore around a test).
  timeoutMs: number = CLIENT_TURN_TIMEOUT_MS
): Promise<void> {
  const token = ownership.begin();

  state.setBusy(true);
  state.setError(null);
  // This specific attempt hasn't reported anything yet -- if it turns out to
  // be another turn_in_progress, the branch below sets this true again.
  state.setTurnInProgress(false);

  let transportFailed = false;
  let result: TurnRequestResult | null = null;

  // V2.8.5.1 — bound the wait. `controller` is registered so an EXTERNAL
  // trigger (GameClient.tsx's visibilitychange handler, on a request it
  // judges stale) can abort the SAME request through the SAME path as this
  // module's own CLIENT_TURN_TIMEOUT_MS timer — one mechanism, two triggers,
  // never a second competing one. Aborting resolves to the ordinary
  // transport-failure branch below, which already reconciles through
  // canonical truth exactly once.
  const controller = new AbortController();
  const startedAt = Date.now();
  state.registerActiveRequest?.({ abort: () => controller.abort(), startedAt });
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    result = await io.requestTurn(controller.signal);
    // V2.8.6 R1 Commit 2 — a documented auth/identity application error is
    // never a transport failure, even though (by design) it carries no
    // `game`. Checked BEFORE the missing-`game` fallback below, which stays
    // exactly as it was for every other case: a truly malformed or unusable
    // body.
    const isDocumentedAuthError = !result.ok && isAuthApplicationError(result.data?.error);
    if (!isDocumentedAuthError && (!result.data || !result.data.game)) transportFailed = true;
  } catch {
    transportFailed = true;
  } finally {
    clearTimeout(timeoutId);
    // V2.8.5.1 — ownership-gated. Without this check, an OLDER (superseded)
    // request's own late settlement would unconditionally null out
    // activeRequestRef, clobbering a NEWER request's registration even
    // though that newer request is still genuinely in flight — silently
    // disabling the stale-foreground-abort path for it. Only the request
    // that is STILL current may clear what it registered.
    if (ownership.isCurrent(token)) {
      state.clearActiveRequest?.();
    }
  }

  if (!ownership.isCurrent(token)) return; // superseded — nothing below may run

  if (transportFailed) {
    await reconcileAfterFailure(ownership, token, io, state);
  } else if (result) {
    const data = result.data as TurnResponseBody;
    // V2.8.6 R1 Commit 2 — a documented auth/identity error carries no
    // `game` at all (by design — see AUTH_APPLICATION_ERRORS' own doc), so
    // this must never be unconditional. Every OTHER response this route
    // has ever returned always included `game`, so guarding it costs
    // nothing for any of them.
    if (data.game) state.setGame(data.game as GameRecord);
    if (!result.ok) {
      if (data.error === "stale_turn") {
        // V2.8.1 — a synchronization event, not a gameplay failure. Unchanged
        // from the pre-S1 behavior.
        state.setError(null);
        state.setTurnFailed(false);
      } else if (data.error === "turn_in_progress") {
        // V2.8.4.1 — another request already holds the server's turn lock
        // (see acquireTurnLock in the /turn route), most often a still-
        // finishing provider call from a prior attempt. `data.game` above is
        // already the canonical current state, so nothing is stale or lost;
        // this is not a gameplay failure and must not show one. GameClient's
        // awaitingTurnLock effect schedules exactly one quiet retry.
        state.setError(null);
        state.setTurnFailed(false);
        state.setTurnInProgress(true);
      } else if (data.error === "sandbox_clarification_failed") {
        // V2.8.5 ENGINE-CONTRACT CORRECTION (defect 5) — a truthful terminal
        // state, not a generic gameplay failure: no retry can help, and the
        // raw message must not be shown as though it were. GameClient renders
        // its own localized restart/reframe panel with New Game navigation.
        state.setError(null);
        state.clearAutoTurnGuard();
        state.setTurnFailed(false);
        state.setSandboxClarificationFailed?.(true);
      } else {
        state.setError(data.message || "Valami hiba történt.");
        state.clearAutoTurnGuard();
        state.setTurnFailed(true);
      }
    } else {
      state.setTurnFailed(false);
    }
  }

  if (ownership.isCurrent(token)) {
    state.setBusy(false);
    state.setAmbiguousMode(false);
    state.setExplanation("");
  }
}

/**
 * ONE canonical read, never a second /turn call. Applies the result only if
 * it shows genuine progress; otherwise (including when the read itself
 * fails) falls back to exactly the pre-S1 recoverable-failure behavior —
 * no automatic retry is scheduled from here or anywhere else in this module.
 */
async function reconcileAfterFailure(
  ownership: RequestOwnership,
  token: number,
  io: TurnRequestIO,
  state: TurnRequestState
): Promise<void> {
  const before = state.getGame();
  let view: GameView | null = null;
  let viewOk = false;

  try {
    const viewResult = await io.requestView();
    viewOk = viewResult.ok;
    view = viewResult.view;
  } catch {
    viewOk = false;
  }

  if (!ownership.isCurrent(token)) return; // superseded while reconciling

  if (viewOk && view) {
    const reconciled = mergeViewIntoGame(before, view);
    if (reconciliationShowsProgress(before, reconciled)) {
      state.setGame(reconciled);
      state.setError(null);
      state.setTurnFailed(false);
      return;
    }
  }

  state.setError(NETWORK_ERROR_MESSAGE);
  state.clearAutoTurnGuard();
  state.setTurnFailed(true);
}

// ---------------------------------------------------------------------------
// V2.8.5.2 — the SAME bounded-lifecycle pattern applied to /resolve.
//
// THE DEFECT THIS REPAIRS — production forensic, game
// a0b7743b-5599-45ac-9909-e1dd23a6316c: the Composer saw
// "Hálózati hiba a lezárásnál — próbáld újra." (the client's own fetch-threw
// fallback text) at a moment the server's own logs show a fully-completed,
// cleanly-answered request. resolveGame()'s fetch had no AbortController and
// no timeout at all — the exact gap CLIENT_TURN_TIMEOUT_MS closed for /turn
// in V2.8.5.1, never applied here. Reuses RequestOwnership,
// ActiveRequestHandle, mergeViewIntoGame, and reconciliationShowsProgress
// unchanged: /resolve's canonical "did it actually finish" signal is exactly
// the same phase-advanced-to-"complete" fact reconciliationShowsProgress
// already checks (`after.phase !== before.phase`), so no new reconciliation
// logic is needed, only a new (smaller, /resolve-shaped) request/state
// contract and the same abort-on-timeout wiring.
// ---------------------------------------------------------------------------

/**
 * V2.8.5.2 — bounds /resolve's own wait. app/api/game/[id]/resolve/route.ts
 * declares `export const maxDuration = 60` (Vercel's own execution ceiling
 * for this route — far shorter than /turn's 270s, since /resolve makes at
 * most one Adjudicator call plus up to two bounded Integrity Review
 * attempts, never an open-ended duplicate-question loop). 90_000ms gives a
 * documented 30s margin beyond that platform ceiling for network overhead —
 * the same style of margin app/api/game/[id]/turn/route.ts's own
 * maxDuration(270s) < TURN_LOCK_TTL_SECONDS(300s) documents, scaled to
 * /resolve's own (much shorter) legitimate duration rather than reused
 * verbatim from /turn's.
 */
export const RESOLVE_CLIENT_TIMEOUT_MS = 90_000;

/** The shape every real POST /api/game/[id]/resolve response carries. */
export interface ResolveResponseBody {
  game?: GameRecord;
  error?: string;
  message?: string;
}

export interface ResolveRequestResult {
  ok: boolean;
  data: ResolveResponseBody | null | undefined;
}

export interface ResolveRequestIO {
  /** See TurnRequestIO.requestTurn's doc — the same signal-forwarding requirement applies here. */
  requestResolve(signal: AbortSignal): Promise<ResolveRequestResult>;
  requestView(): Promise<ViewRequestResult>;
}

export const RESOLVE_NETWORK_ERROR_MESSAGE = "Hálózati hiba a lezárásnál — próbáld újra.";

/** Every piece of state S1's /resolve analogue requires to be ownership-guarded. */
export interface ResolveRequestState {
  getGame(): GameRecord;
  setGame(game: GameRecord): void;
  setResolveError(message: string | null): void;
  setResolving(resolving: boolean): void;
  /** The auto-resolve effect's own `resolveFired.current = false` — re-armed on any failure, exactly like clearAutoTurnGuard for /turn. */
  clearResolveGuard(): void;
  registerActiveRequest?(handle: ActiveRequestHandle): void;
  clearActiveRequest?(): void;
}

/**
 * The full owned-resolve workflow — see runOwnedTurnRequest's doc; this is
 * its /resolve-shaped twin, sharing the same ownership/reconciliation
 * primitives. A superseded call's success, failure, or reconciled outcome
 * cannot overwrite what a newer call already established, and a stale/late
 * settlement cannot clobber a newer request's active-handle registration
 * (same ownership-gated `clearActiveRequest` fix as V2.8.5.1's /turn path).
 */
export async function runOwnedResolveRequest(
  ownership: RequestOwnership,
  io: ResolveRequestIO,
  state: ResolveRequestState,
  timeoutMs: number = RESOLVE_CLIENT_TIMEOUT_MS
): Promise<void> {
  const token = ownership.begin();

  state.setResolving(true);
  state.setResolveError(null);

  let transportFailed = false;
  let result: ResolveRequestResult | null = null;

  const controller = new AbortController();
  const startedAt = Date.now();
  state.registerActiveRequest?.({ abort: () => controller.abort(), startedAt });
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    result = await io.requestResolve(controller.signal);
    if (!result.data || !result.data.game) transportFailed = true;
  } catch {
    transportFailed = true;
  } finally {
    clearTimeout(timeoutId);
    if (ownership.isCurrent(token)) {
      state.clearActiveRequest?.();
    }
  }

  if (!ownership.isCurrent(token)) return; // superseded — nothing below may run

  if (transportFailed) {
    await reconcileResolveAfterFailure(ownership, token, io, state);
  } else if (result) {
    const data = result.data as ResolveResponseBody;
    if (data.game) state.setGame(data.game);
    if (!result.ok) {
      // /resolve's error taxonomy (integrity_review_unavailable,
      // adjudicator_unavailable, budget_exhausted/unavailable, wrong_phase,
      // resolution_failed) is uniform from the client's point of view: every
      // one of them preserves the game unchanged server-side (still
      // "resolving") and is safely retryable — unlike /turn, there is no
      // stale_turn/turn_in_progress special case to distinguish here.
      state.setResolveError(data.message || "Nem sikerült lezárni a játékot.");
      state.clearResolveGuard();
    } else {
      state.setResolveError(null);
    }
  }

  if (ownership.isCurrent(token)) {
    state.setResolving(false);
  }
}

/**
 * ONE canonical read, never a second /resolve call. Applies the result only
 * if it shows genuine progress (here: the phase actually advanced to
 * "complete" server-side while the client was waiting) — the same
 * reconciliationShowsProgress this module already uses for /turn.
 */
async function reconcileResolveAfterFailure(
  ownership: RequestOwnership,
  token: number,
  io: ResolveRequestIO,
  state: ResolveRequestState
): Promise<void> {
  const before = state.getGame();
  let view: GameView | null = null;
  let viewOk = false;

  try {
    const viewResult = await io.requestView();
    viewOk = viewResult.ok;
    view = viewResult.view;
  } catch {
    viewOk = false;
  }

  if (!ownership.isCurrent(token)) return; // superseded while reconciling

  if (viewOk && view) {
    const reconciled = mergeViewIntoGame(before, view);
    if (reconciliationShowsProgress(before, reconciled)) {
      state.setGame(reconciled);
      state.setResolveError(null);
      return;
    }
  }

  state.setResolveError(RESOLVE_NETWORK_ERROR_MESSAGE);
  state.clearResolveGuard();
}

// ---------------------------------------------------------------------------
// V2.8.6 R2 — the Human↔Human /hh/turn analogue.
//
// Structurally different from runOwnedTurnRequest's own /turn-shaped
// contract in one deliberate way: app/api/game/[id]/hh/turn/route.ts
// returns `{ok, revision}` on success and never `game` or `view` at all
// (see that route's own module doc — the response only needs to say
// whether the write landed and at what real CAS revision). HumanClient.tsx
// already tracks a GameView, not a GameRecord, obtained through a SEPARATE
// GET /view call — there is no client-only overlay state (provenance,
// edit history) to merge onto it the way mergeViewIntoGame merges onto a
// GameRecord, so every path below that needs canonical state (success,
// stale_turn, an uncertain transport failure) converges on the same single
// action: fetch /view once, and apply whatever it returns outright.
// ---------------------------------------------------------------------------

/**
 * V2.8.6 R2 — /hh/turn's own client-side wait bound, matching its own 15s
 * turn-lock TTL (app/api/game/[id]/hh/turn/route.ts) — this route makes no
 * model call at all, so its legitimate duration is a KV read plus a CAS
 * write, nothing like /turn's/ask's/clue's much longer numbers.
 */
export const HH_TURN_CLIENT_TIMEOUT_MS = 15_000;

/** The shape every real POST /api/game/[id]/hh/turn response carries. */
export interface HhTurnResponseBody {
  ok?: boolean;
  error?: string;
  message?: string;
  /** The real GameRecord.revision CAS counter — present on success and on stale_turn only. */
  revision?: number;
}

export interface HhTurnRequestResult {
  ok: boolean;
  data: HhTurnResponseBody | null | undefined;
}

export interface HhTurnRequestIO {
  /** See TurnRequestIO.requestTurn's doc — the same signal-forwarding requirement applies here. */
  requestTurn(signal: AbortSignal): Promise<HhTurnRequestResult>;
  requestView(): Promise<ViewRequestResult>;
}

export interface HhTurnRequestState {
  getView(): GameView;
  setView(view: GameView): void;
  setError(message: string | null): void;
  setBusy(busy: boolean): void;
  /**
   * V2.8.6 R2 — /hh/turn's own turn_in_progress: another in-flight request
   * already holds this game's turn lock. Transient, not a failure — the
   * caller should poll/wait (e.g. let the existing /view poll continue, or
   * schedule one bounded quiet retry), never immediately replay the same
   * mutation. Mirrors runOwnedTurnRequest's own setTurnInProgress for /turn.
   */
  setTurnInProgress(inProgress: boolean): void;
  registerActiveRequest?(handle: ActiveRequestHandle): void;
  clearActiveRequest?(): void;
}

/** The last turn if it is an unresolved clue request — the GameView/ViewTurn analogue of pendingClueRequest. */
function pendingClueTurn(view: GameView): ViewTurn | null {
  const last = view.turns[view.turns.length - 1];
  if (last && last.turn_type === "clue" && last.clue_text === null) return last;
  return null;
}

/**
 * GameView analogue of reconciliationShowsProgress — same four signals
 * (revision, log length, phase, an advanced pending question/clue), applied
 * to GameView's own fields (record_revision is the real CAS counter here;
 * `revision` — the derived qa_log-length/answered-count poll marker — is
 * deliberately not used, for the same reason mergeViewIntoGame prefers
 * record_revision).
 */
export function gameViewShowsProgress(before: GameView, after: GameView): boolean {
  if (after.record_revision > before.record_revision) return true;
  if (after.turns.length > before.turns.length) return true;
  if (after.phase !== before.phase) return true;
  if (after.question_count > before.question_count) return true;
  const afterPending = after.pending_question_index;
  if (afterPending !== null && afterPending !== before.pending_question_index) return true;
  const afterClue = pendingClueTurn(after);
  if (afterClue && afterClue.turn_index !== pendingClueTurn(before)?.turn_index) return true;
  return false;
}

/**
 * ONE canonical read, applied outright — no merge, no progress check. Used
 * by the two paths whose OWN contract already guarantees genuine change
 * (a real success; a real, documented stale_turn) — see
 * reconcileHhTurnAfterFailure below for the uncertain-transport-failure
 * path, where a progress check still matters for what it decides about the
 * error banner.
 */
async function applyCanonicalView(
  ownership: RequestOwnership,
  token: number,
  io: HhTurnRequestIO,
  state: HhTurnRequestState
): Promise<void> {
  try {
    const viewResult = await io.requestView();
    if (!ownership.isCurrent(token)) return; // superseded while reading
    if (viewResult.ok && viewResult.view) {
      state.setView(viewResult.view);
    }
  } catch {
    // Best-effort. The existing /view poll (or a manual retry) picks this
    // back up; this path does not itself introduce a retry loop.
  }
}

/**
 * The full owned /hh/turn workflow. Every state mutation is gated on the
 * token that began this call still being the most recent one — see
 * RequestOwnership. A superseded call's success, failure, or reconciled
 * outcome therefore CANNOT overwrite what a newer call already established.
 */
export async function runOwnedHhTurnRequest(
  ownership: RequestOwnership,
  io: HhTurnRequestIO,
  state: HhTurnRequestState,
  timeoutMs: number = HH_TURN_CLIENT_TIMEOUT_MS
): Promise<void> {
  const token = ownership.begin();

  state.setBusy(true);
  state.setError(null);
  state.setTurnInProgress(false);

  let transportFailed = false;
  let result: HhTurnRequestResult | null = null;

  const controller = new AbortController();
  const startedAt = Date.now();
  state.registerActiveRequest?.({ abort: () => controller.abort(), startedAt });
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    result = await io.requestTurn(controller.signal);
    // V2.8.6 R2 — /hh/turn's contract is minimal by design (see the module
    // doc): a genuine documented response ALWAYS carries a string `error`
    // on failure, or a numeric `revision` on success — every one of its
    // failure codes, not merely the auth-taxonomy ones /turn's own
    // AUTH_APPLICATION_ERRORS check exists for (that set matters for
    // MESSAGE handling below, not for this shape check). Anything short of
    // that is exactly the "unusable response body" case reconciliation
    // exists for.
    const hasDocumentedShape = result.ok
      ? typeof result.data?.revision === "number"
      : typeof result.data?.error === "string";
    if (!hasDocumentedShape) transportFailed = true;
  } catch {
    transportFailed = true;
  } finally {
    clearTimeout(timeoutId);
    if (ownership.isCurrent(token)) {
      state.clearActiveRequest?.();
    }
  }

  if (!ownership.isCurrent(token)) return; // superseded — nothing below may run

  if (transportFailed) {
    await reconcileHhTurnAfterFailure(ownership, token, io, state);
  } else if (result) {
    const data = result.data as HhTurnResponseBody;
    if (!result.ok) {
      if (data.error === "turn_in_progress") {
        // Transient, not a failure — see HhTurnRequestState.setTurnInProgress's
        // own doc. Still worth ONE canonical read (a poll, not a replay of
        // the mutation): whatever request currently holds the lock may have
        // already landed by the time this one arrived.
        state.setError(null);
        state.setTurnInProgress(true);
        await applyCanonicalView(ownership, token, io, state);
      } else if (data.error === "stale_turn") {
        // A synchronization event, not a gameplay failure. The response
        // itself carries only the bare revision, never a view — fetch the
        // canonical narrowed state in ONE read and stop; no automatic replay.
        await applyCanonicalView(ownership, token, io, state);
      } else {
        // Every other documented failure (wrong_phase, awaiting_answer,
        // out_of_questions, a seat/auth code, ...): show the server's own
        // message. Never reconciled — a documented application error is
        // not evidence of a lost write.
        state.setError(data.message || "Nem sikerült elküldeni. Próbáld újra.");
      }
    } else {
      // Success — fetch canonical narrowed state once, per the contract.
      await applyCanonicalView(ownership, token, io, state);
    }
  }

  if (ownership.isCurrent(token)) {
    state.setBusy(false);
  }
}

/**
 * Reconciliation for an UNCERTAIN transport failure (a rejected fetch, a
 * non-JSON body, or a body missing the shape every real response carries —
 * see runOwnedHhTurnRequest's own hasDocumentedShape check). ONE canonical
 * read, never a second /hh/turn call. Unlike runOwnedTurnRequest's own
 * reconcileAfterFailure, the fresh view is applied EITHER way (there is no
 * stale local overlay to protect by withholding it) — only whether the
 * error banner stays visible depends on gameViewShowsProgress, so a
 * genuinely lost action is never silently hidden behind a falsely-cleared
 * error.
 */
async function reconcileHhTurnAfterFailure(
  ownership: RequestOwnership,
  token: number,
  io: HhTurnRequestIO,
  state: HhTurnRequestState
): Promise<void> {
  const before = state.getView();
  let view: GameView | null = null;
  let viewOk = false;

  try {
    const viewResult = await io.requestView();
    viewOk = viewResult.ok;
    view = viewResult.view;
  } catch {
    viewOk = false;
  }

  if (!ownership.isCurrent(token)) return; // superseded while reconciling

  if (viewOk && view) {
    state.setView(view);
    if (gameViewShowsProgress(before, view)) {
      state.setError(null);
      return;
    }
  }

  state.setError(NETWORK_ERROR_MESSAGE);
}
