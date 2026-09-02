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
  requestTurn(): Promise<TurnRequestResult>;
  requestView(): Promise<ViewRequestResult>;
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
}

export const NETWORK_ERROR_MESSAGE = "Hálózati hiba — próbáld újra.";

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
  state: TurnRequestState
): Promise<void> {
  const token = ownership.begin();

  state.setBusy(true);
  state.setError(null);

  let transportFailed = false;
  let result: TurnRequestResult | null = null;

  try {
    result = await io.requestTurn();
    if (!result.data || !result.data.game) transportFailed = true;
  } catch {
    transportFailed = true;
  }

  if (!ownership.isCurrent(token)) return; // superseded — nothing below may run

  if (transportFailed) {
    await reconcileAfterFailure(ownership, token, io, state);
  } else if (result) {
    const data = result.data as TurnResponseBody;
    state.setGame(data.game as GameRecord);
    if (!result.ok) {
      if (data.error === "stale_turn") {
        // V2.8.1 — a synchronization event, not a gameplay failure. Unchanged
        // from the pre-S1 behavior.
        state.setError(null);
        state.setTurnFailed(false);
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
