import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldAutoRequestTurn, shouldOfferTurnRetry } from "../lib/turnRecovery";
import type { AutoTurnState } from "../lib/turnRecovery";

// ---------------------------------------------------------------------------
// V2.5-B4 — recovery from a failed Racer turn.
//
// GROK-02 and GROK-03 were one defect: the auto-turn guard was claimed before
// the request and cleared by nothing, so a single failure permanently disabled
// the only thing that could fire another turn. Grok's latency exposed it; the
// code was never provider-specific.
//
// The decision now lives in a pure module precisely so these cases can be
// executed rather than asserted about source text.
// ---------------------------------------------------------------------------

function state(overrides: Partial<AutoTurnState> = {}): AutoTurnState {
  return {
    phase: "questioning",
    hasPendingQuestion: false,
    hasPendingClueRequest: false,
    busy: false,
    turnFailed: false,
    lastAutoTurnAt: null,
    qaLogLength: 0,
    ...overrides,
  };
}

// --- the two situations the automatic path exists for ----------------------

test("the opening turn is requested automatically", () => {
  assert.equal(shouldAutoRequestTurn(state({ qaLogLength: 0 })), true);
});

test("play resumes automatically after a rewind", () => {
  // A correction leaves the log truncated, its last entry answered, nothing
  // pending — the same shape as the opening move.
  assert.equal(
    shouldAutoRequestTurn(state({ qaLogLength: 10, lastAutoTurnAt: 12 })),
    true
  );
});

// --- the situations it must stay out of ------------------------------------

test("no automatic turn while the human owes an answer", () => {
  assert.equal(shouldAutoRequestTurn(state({ hasPendingQuestion: true })), false);
});

test("no automatic turn while the Racer is waiting on a clue", () => {
  assert.equal(shouldAutoRequestTurn(state({ hasPendingClueRequest: true })), false);
});

test("no automatic turn while a request is already in flight", () => {
  assert.equal(shouldAutoRequestTurn(state({ busy: true })), false);
});

test("no automatic turn outside the questioning phase", () => {
  for (const phase of ["resolving", "complete", "pending_validation"] as const) {
    assert.equal(shouldAutoRequestTurn(state({ phase })), false, phase);
  }
});

test("the same state is never requested twice", () => {
  assert.equal(
    shouldAutoRequestTurn(state({ qaLogLength: 7, lastAutoTurnAt: 7 })),
    false
  );
});

// --- GROK-03: correction -> failed generation -> retry ---------------------

test("REGRESSION: a failed turn no longer wedges the game permanently", () => {
  // The exact sequence that killed Grok games.
  // 1. Correction truncates the log from 12 to 10 and re-arms the effect.
  let s = state({ qaLogLength: 10, lastAutoTurnAt: 12 });
  assert.equal(shouldAutoRequestTurn(s), true, "the resume must fire");

  // 2. The effect fires and claims the guard.
  s = { ...s, lastAutoTurnAt: 10 };

  // 3. The turn FAILS. qa_log is unchanged, so under the old code the guard
  //    still matched the length and nothing could ever fire again.
  //    Now the guard is cleared and the failure is recorded instead.
  s = { ...s, lastAutoTurnAt: null, turnFailed: true };

  // The automatic path stays shut — no blind retry against a failing provider.
  assert.equal(shouldAutoRequestTurn(s), false, "must not auto-retry into a loop");
  // But the human is offered a way back, which is what was missing entirely.
  assert.equal(shouldOfferTurnRetry(s), true, "a retry control must be offered");

  // 4. The human retries: turnFailed clears and the request goes out.
  s = { ...s, turnFailed: false };
  assert.equal(shouldAutoRequestTurn(s), true, "retry must be able to proceed");
});

test("REGRESSION: a stale guard from before a rewind cannot block the resume", () => {
  // The old guard was keyed on length alone, so any earlier failure that left
  // lastAutoTurnAt equal to a length the game later returned to would wedge it.
  // Clearing the ref on failure is what removes that whole class of stall.
  const s = state({ qaLogLength: 10, lastAutoTurnAt: null, turnFailed: false });
  assert.equal(shouldAutoRequestTurn(s), true);
});

test("a second failure re-suspends the automatic path rather than looping", () => {
  const s = state({ qaLogLength: 10, lastAutoTurnAt: null, turnFailed: true });
  assert.equal(shouldAutoRequestTurn(s), false);
  assert.equal(shouldOfferTurnRetry(s), true, "and the control is still there");
});

// --- GROK-02: backgrounding ------------------------------------------------

test("REGRESSION: an aborted request while backgrounded stays recoverable", () => {
  // The browser kills the in-flight fetch; there is no response, so game state
  // is untouched. The old code left the guard claimed and the game dead.
  const s = state({ qaLogLength: 4, lastAutoTurnAt: null, turnFailed: true });
  assert.equal(shouldAutoRequestTurn(s), false, "no automatic retry");
  assert.equal(shouldOfferTurnRetry(s), true, "human recovery available");
});

// --- when the retry control must NOT appear --------------------------------

test("no retry control when nothing has failed", () => {
  assert.equal(shouldOfferTurnRetry(state()), false);
});

test("no retry control while a request is in flight", () => {
  assert.equal(shouldOfferTurnRetry(state({ turnFailed: true, busy: true })), false);
});

test("no retry control once a question arrived anyway", () => {
  // The server may have completed the turn after the client lost the response.
  // The human has a move to make; a retry button would be noise.
  assert.equal(
    shouldOfferTurnRetry(state({ turnFailed: true, hasPendingQuestion: true })),
    false
  );
});

test("no turn retry control on a resolving game — ResultPanel owns that retry", () => {
  // Two retry controls for two different requests is how a player presses the
  // wrong one.
  assert.equal(shouldOfferTurnRetry(state({ turnFailed: true, phase: "resolving" })), false);
});

// --- the client must actually apply all of this ----------------------------

const CLIENT = readFileSync("app/game/[id]/GameClient.tsx", "utf8");

test("the client clears the guard on BOTH failure paths", () => {
  // Response-level failure (502 racer_unavailable, 429, 409) and transport
  // failure (network drop, backgrounded tab) are different code paths and the
  // original bug was that neither reset anything.
  const sendTurn = CLIENT.slice(
    CLIENT.indexOf("const sendTurn = useCallback"),
    CLIENT.indexOf("const retryTurn = useCallback")
  );
  assert.ok(sendTurn.length > 0, "could not isolate sendTurn");
  assert.equal(
    (sendTurn.match(/autoTurnFor\.current = null/g) ?? []).length,
    2,
    "the guard must be cleared on !res.ok AND in catch"
  );
  assert.equal(
    (sendTurn.match(/setTurnFailed\(true\)/g) ?? []).length,
    2,
    "both failure paths must record the failure"
  );
});

test("the client preserves server state on a failed turn", () => {
  // Every /turn error path returns the record with the human's answer already
  // recorded. Setting it before checking res.ok is what stops a failed
  // generation from discarding an answer or a correction.
  const sendTurn = CLIENT.slice(
    CLIENT.indexOf("const sendTurn = useCallback"),
    CLIENT.indexOf("const retryTurn = useCallback")
  );
  const setGameAt = sendTurn.indexOf("setGame(data.game as GameRecord)");
  const checkAt = sendTurn.indexOf("if (!res.ok)");
  assert.ok(setGameAt > 0 && checkAt > setGameAt, "state must be applied before the error check");
});

test("only the human clears turnFailed on the failing path", () => {
  assert.match(CLIENT, /const retryTurn = useCallback/);
  assert.match(CLIENT, /onClick=\{retryTurn\}/, "the control must be wired to the retry");
  // A correction is also a human action on a new state, so it re-arms too.
  assert.match(CLIENT, /setTurnFailed\(false\)/);
});

test("the effect delegates the decision rather than re-implementing it", () => {
  assert.match(CLIENT, /shouldAutoRequestTurn\(\{/);
  assert.match(CLIENT, /shouldOfferTurnRetry\(\{/);
  // The bug lived in an inline guard nobody could test. It must not come back.
  assert.doesNotMatch(
    CLIENT,
    /if \(autoTurnFor\.current === game\.qa_log\.length\) return;/,
    "the untestable inline guard must be gone"
  );
});
