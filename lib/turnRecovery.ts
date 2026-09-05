import type { GamePhase } from "./types";

// ---------------------------------------------------------------------------
// V2.5-B4 — when may the client ask the Racer for a turn by itself?
//
// Pure, no I/O, no React — the same reason lib/rewind.ts and
// lib/resolveResult.ts are pure. This predicate IS the thing that broke, so it
// is unit-tested rather than implied by the control flow of an effect nobody
// can run in a test.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS REPAIRS (GROK-02 / GROK-03)
// ---------------------------------------------------------------------------
//
// The auto-turn effect was guarded by a ref keyed on qa_log length:
//
//     if (autoTurnFor.current === game.qa_log.length) return;
//     autoTurnFor.current = game.qa_log.length;   // set BEFORE the request
//     void sendTurn();                            // never reset on failure
//
// The guard was set before the request and cleared by nothing. A failed turn
// leaves qa_log unchanged, so the guard still matches the current length and
// the effect can never fire again. The game is dead with no way back — there
// was no retry control either.
//
// It bites hardest after a correction, and that is not a coincidence. During
// ordinary play the human's IGEN/NEM button calls the turn directly, so the
// guard was never claimed for that length and the effect can still fire once.
// After a rewind the EFFECT ITSELF fires the turn, claims the guard, and a
// single failure is therefore terminal. Deterministic, and exactly the reported
// symptom: the correction lands, history updates, no next question ever comes.
//
// The code is provider-agnostic; only the failure RATE is provider-specific.
// Claude was fast and reliable enough that the latent bug effectively never
// fired. Grok's latency is what exposed it.
//
// ---------------------------------------------------------------------------
// WHY CLEARING THE GUARD IS NOT ENOUGH ON ITS OWN
// ---------------------------------------------------------------------------
//
// Clearing the ref on failure and stopping there would be worse than the bug.
// The effect re-runs on the state change that failure itself causes, sees an
// empty guard and an unchanged log, and fires again — immediately, forever,
// against a provider that is already failing or timing out. That is a blind
// retry loop, and on a metered API it is an expensive one.
//
// So recovery is split in two, and the distinction is the whole design:
//
//   `lastAutoTurnAt` — has the client ALREADY asked for this state?
//                      Cleared on failure so a stale length can never wedge
//                      the game again.
//   `turnFailed`     — did the last attempt fail? Blocks the AUTOMATIC path
//                      only, and is cleared by an explicit human retry.
//
// Automatic recovery for the ordinary case, human-triggered recovery for the
// failing one. No retry ever happens without either fresh state or a person
// asking for it.
// ---------------------------------------------------------------------------

export interface AutoTurnState {
  phase: GamePhase;
  /** A question is on screen awaiting the human's YES/NO/AMBIGUOUS. */
  hasPendingQuestion: boolean;
  /** The Racer spent a clue credit and is waiting on words, not an answer. */
  hasPendingClueRequest: boolean;
  /** A request is already in flight. */
  busy: boolean;
  /** The last turn attempt failed and no human has asked to try again. */
  turnFailed: boolean;
  /**
   * V2.8.7.1 — the "+1" sandbox-clarification corridor reported no coherent
   * contract (app/api/game/[id]/turn/route.ts's sandbox_clarification_failed).
   * The failed answer IS persisted (composer_response !== null) and nothing
   * is pending, so without this the effect would see exactly the "ask for
   * the next turn" shape and fire again immediately — hitting the identical,
   * deterministic (zero-model-call) failure in a tight loop, and burying the
   * correction control this same state is supposed to leave reachable.
   * Cleared the same way `turnFailed` is: by the human acting (here, a
   * successful correction), never automatically.
   */
  sandboxClarificationFailed: boolean;
  /** qa_log length the effect last fired for, or null if it has not. */
  lastAutoTurnAt: number | null;
  qaLogLength: number;
}

/**
 * May the client ask the Racer for a turn without being told to?
 *
 * True in exactly two situations: the opening move, and the resume after a
 * rewind — both of which leave the game live with nothing pending.
 */
export function shouldAutoRequestTurn(state: AutoTurnState): boolean {
  if (state.phase !== "questioning") return false;
  // Both mean the game is waiting on the HUMAN, not on the Racer.
  if (state.hasPendingQuestion) return false;
  if (state.hasPendingClueRequest) return false;
  if (state.busy) return false;
  // A failed attempt suspends the automatic path until a person retries.
  // Without this, clearing the guard below would turn one failure into a loop.
  if (state.turnFailed) return false;
  // Same reasoning, for the "+1" corridor's own terminal, non-retryable
  // failure — see the field's own doc. A person correcting one of the
  // flagged answers is what clears this, never the effect itself.
  if (state.sandboxClarificationFailed) return false;
  // Already asked for this exact state.
  if (state.lastAutoTurnAt === state.qaLogLength) return false;
  return true;
}

/**
 * Is a human-visible retry control warranted?
 *
 * Only when the game is still playable and waiting on the Racer. A failure on a
 * game that has moved to `resolving` belongs to ResultPanel's own retry, and
 * offering two retry controls for two different requests is how a player ends
 * up pressing the wrong one.
 */
export function shouldOfferTurnRetry(state: AutoTurnState): boolean {
  if (!state.turnFailed) return false;
  if (state.phase !== "questioning") return false;
  if (state.busy) return false;
  // If a question is already on screen the human has a move to make; the failed
  // request was superseded and a retry button would be noise.
  if (state.hasPendingQuestion) return false;
  return true;
}

// ---------------------------------------------------------------------------
// V2.8.5.1 — foreground reconciliation. Pure, no React, no DOM: the same
// reason the two predicates above are pure. Extracted so
// GameClient.tsx's `visibilitychange` handler is a thin application of a
// tested decision, exactly like shouldAutoRequestTurn/shouldOfferTurnRetry
// already are for the auto-turn effect.
//
// THE DEFECT THIS REPAIRS — see lib/turnRequestGuard.ts's
// CLIENT_TURN_TIMEOUT_MS doc for the full "silent stall" forensic. The OLD
// handler's `if (busy) return` trusted that an in-flight request always
// eventually settles; a mobile browser silently discarding a backgrounded
// fetch (neither resolving nor rejecting) makes that false. This predicate
// gives the handler a way to tell "still legitimately running" apart from
// "has been running far longer than any real attempt ever takes" WITHOUT
// relying on `busy` alone, and without relying on this tab's own JS timers
// (which backgrounding can throttle or pause) to have fired.
// ---------------------------------------------------------------------------

export interface StaleRequestCheck {
  busy: boolean;
  /** When the current /turn request began, or null if none is in flight. */
  activeRequestStartedAt: number | null;
  now: number;
  /** CLIENT_TURN_TIMEOUT_MS from lib/turnRequestGuard.ts, passed in rather than imported so this module stays free of that one's own dependency surface. */
  timeoutMs: number;
}

/**
 * Should returning to the foreground force-abort and reconcile a currently
 * busy request? True only when a request is ACTUALLY in flight
 * (`activeRequestStartedAt` non-null) and it has been running at least
 * `timeoutMs` — i.e., it is already eligible for the SAME timeout
 * runOwnedTurnRequest's own internal timer enforces, just possibly not yet
 * fired because this tab's timers were throttled while hidden. Never true
 * for a fresh, legitimately-still-running request, and never true when
 * nothing is in flight at all (the existing not-busy reconciliation path in
 * GameClient.tsx already covers that case).
 */
export function shouldReconcileStaleRequestOnForeground(check: StaleRequestCheck): boolean {
  if (!check.busy) return false;
  if (check.activeRequestStartedAt === null) return false;
  return check.now - check.activeRequestStartedAt >= check.timeoutMs;
}
