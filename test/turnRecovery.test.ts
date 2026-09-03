import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldAutoRequestTurn, shouldOfferTurnRetry, shouldReconcileStaleRequestOnForeground } from "../lib/turnRecovery";
import type { AutoTurnState, StaleRequestCheck } from "../lib/turnRecovery";

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

// S1 / RB-1 — sendTurn() is now a thin transport/state adapter; the failure
// handling these two tests protect (clearing the auto-turn guard on both
// failure paths, and applying server state before checking res.ok) moved
// with it into lib/turnRequestGuard.ts's runOwnedTurnRequest, exactly the
// same "decision lives in a pure module, not asserted about source text"
// move this file's own header already made for shouldAutoRequestTurn. See
// test/turnRequestGuard.test.ts for the behavioral (not source-text)
// coverage of this — these two are kept as a cheap tripwire that the logic
// has not silently moved somewhere ungoverned.
const TURN_REQUEST_GUARD = readFileSync("lib/turnRequestGuard.ts", "utf8");

test("the client clears the guard on every failure path", () => {
  // Response-level failure (502 racer_unavailable, 429, 409), transport
  // failure (network drop, backgrounded tab, unusable body), and the "+1"
  // corridor's own terminal sandbox_clarification_failed state (V2.8.5
  // ENGINE-CONTRACT CORRECTION defect 5, added after this test was first
  // written — count corrected here to match) are three distinct code paths,
  // and the original GROK-02/03 bug was that none of them reset anything.
  const guardCalls = TURN_REQUEST_GUARD.match(/state\.clearAutoTurnGuard\(\)/g) ?? [];
  assert.equal(
    guardCalls.length,
    3,
    "the guard must be cleared on the response failure, the sandbox_clarification_failed terminal state, AND the reconciliation-exhausted path"
  );
  assert.equal(
    (TURN_REQUEST_GUARD.match(/state\.setTurnFailed\(true\)/g) ?? []).length,
    2,
    "both failure paths must record the failure"
  );
  // The ref itself necessarily stays component-local state (only the DECISION
  // of when to clear it moved); GameClient.tsx must expose exactly the one
  // clearAutoTurnGuard callback wiring it up, not a second inline copy of the
  // decision alongside it.
  assert.equal(
    (CLIENT.match(/autoTurnFor\.current = null/g) ?? []).length,
    2,
    "exactly clearAutoTurnGuard's own wiring plus retryTurn's human-initiated reset — no reintroduced inline failure-path copy"
  );
});

test("the client preserves server state on a failed turn", () => {
  // Every /turn error path returns the record with the human's answer already
  // recorded. Setting it before checking res.ok is what stops a failed
  // generation from discarding an answer or a correction.
  const setGameAt = TURN_REQUEST_GUARD.indexOf("state.setGame(data.game as GameRecord)");
  const checkAt = TURN_REQUEST_GUARD.indexOf("if (!result.ok)");
  assert.ok(setGameAt > 0 && checkAt > setGameAt, "state must be applied before the error check");
});

test("S1: sendTurn() delegates to the ownership-guarded orchestrator rather than re-implementing it inline", () => {
  assert.match(CLIENT, /runOwnedTurnRequest\(/);
  assert.match(CLIENT, /createRequestOwnership/);
  // The bug this closes: no code path in GameClient.tsx may set game/error/
  // turnFailed/busy directly from within sendTurn's own try/catch/finally
  // any more -- that is now runOwnedTurnRequest's job, via the `state`
  // adapter object, which is exactly what makes ownership enforceable.
  const sendTurn = CLIENT.slice(
    CLIENT.indexOf("const sendTurn = useCallback"),
    CLIENT.indexOf("const retryTurn = useCallback")
  );
  assert.doesNotMatch(sendTurn, /^\s*setGame\(/m, "setGame must not be called directly inside sendTurn any more");
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

// ---------------------------------------------------------------------------
// V2.8.5.1 — foreground reconciliation of a STALE busy request. See
// lib/turnRequestGuard.ts's CLIENT_TURN_TIMEOUT_MS doc for the "silent
// stall" forensic this repairs (game 6c55682c-b60d-414b-8c0c-1b6a1c8248d8,
// V2.8.5 production): a backgrounded mobile fetch that never settles left
// `busy` stuck true forever, and the old `if (busy) return` guard trusted
// that could never happen.
// ---------------------------------------------------------------------------

function staleCheck(overrides: Partial<StaleRequestCheck> = {}): StaleRequestCheck {
  return {
    busy: true,
    activeRequestStartedAt: 0,
    now: 0,
    timeoutMs: 300_000,
    ...overrides,
  };
}

test("REGRESSION TEST 4 — foregrounding during a FRESH request does not interfere: well within the timeout window, do nothing", () => {
  const now = 1_000_000;
  assert.equal(
    shouldReconcileStaleRequestOnForeground(
      staleCheck({ busy: true, activeRequestStartedAt: now - 1_000, now, timeoutMs: 300_000 })
    ),
    false
  );
});

test("REGRESSION TEST 5 — foregrounding during a STALE busy request reconciles: at or past the timeout, force reconciliation", () => {
  const now = 1_000_000;
  assert.equal(
    shouldReconcileStaleRequestOnForeground(
      staleCheck({ busy: true, activeRequestStartedAt: now - 300_000, now, timeoutMs: 300_000 })
    ),
    true,
    "exactly at the timeout boundary must already count as stale"
  );
  assert.equal(
    shouldReconcileStaleRequestOnForeground(
      staleCheck({ busy: true, activeRequestStartedAt: now - 600_000, now, timeoutMs: 300_000 })
    ),
    true
  );
});

test("not busy at all: never reconcile through this path, regardless of a leftover startedAt", () => {
  const now = 1_000_000;
  assert.equal(
    shouldReconcileStaleRequestOnForeground(
      staleCheck({ busy: false, activeRequestStartedAt: now - 600_000, now, timeoutMs: 300_000 })
    ),
    false
  );
});

test("busy but no active-request handle yet (registration race at the very start of a request): leave it alone rather than guess", () => {
  assert.equal(
    shouldReconcileStaleRequestOnForeground(
      staleCheck({ busy: true, activeRequestStartedAt: null, now: 1_000_000, timeoutMs: 300_000 })
    ),
    false
  );
});

test("REGRESSION TEST 6 — repeated visibility events cannot stack recovery: the decision is a pure function of (busy, startedAt, now), so querying it many times for the SAME stale request yields the same answer and no additional side effect is possible from the query itself", () => {
  const check = staleCheck({ busy: true, activeRequestStartedAt: 0, now: 300_000, timeoutMs: 300_000 });
  const results = Array.from({ length: 5 }, () => shouldReconcileStaleRequestOnForeground(check));
  assert.deepEqual(results, [true, true, true, true, true]);
});

test("REGRESSION TEST 6b — GameClient.tsx's stale-foreground path only aborts the existing request; it must never itself call sendTurn or runOwnedTurnRequest a second time", () => {
  const src = CLIENT;
  const visibilityBlock = src.slice(src.indexOf("function handleVisibility"), src.indexOf("document.addEventListener(\"visibilitychange\""));
  assert.match(visibilityBlock, /shouldReconcileStaleRequestOnForeground/);
  assert.match(visibilityBlock, /active\?\.abort\(\)/);
  assert.doesNotMatch(
    visibilityBlock,
    /sendTurn\(/,
    "the stale-foreground branch must only abort the existing request, never fire a fresh one itself"
  );
});

// ---------------------------------------------------------------------------
// V2.8.5.2 (D) — synchronous submission guard. Production forensic (game
// a0b7743b-5599-45ac-9909-e1dd23a6316c): dense clusters of 409s consistent
// with two answer submissions landing before React's `disabled={busy}`
// re-render could commit. A plain ref update is synchronous, unlike React
// state, so the guard must be checked and claimed BEFORE any `await` —
// verified two ways below: the general claim-release PATTERN works
// (pure, no React), and GameClient.tsx's sendTurn()/resolveGame() actually
// use it (source contract, since this file has no rendering harness for the
// component itself — the same discipline test 6b above already uses).
// ---------------------------------------------------------------------------

/** The exact claim-synchronously/release-on-completion pattern sendTurn() and resolveGame() both use, tested in isolation from React. */
async function withSynchronousGuard(ref: { current: boolean }, fn: () => Promise<void>): Promise<void> {
  if (ref.current) return;
  ref.current = true;
  try {
    await fn();
  } finally {
    ref.current = false;
  }
}

test("V2.8.5.2 (D) REQUIRED TEST — rapid repeated calls through the synchronous guard produce exactly one underlying invocation", async () => {
  const ref = { current: false };
  let calls = 0;
  const underlying = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  // Fire five "taps" back-to-back, without awaiting between them — the
  // scenario a real double/triple-tap produces before any state (or even a
  // microtask) can run in between.
  const attempts = [
    withSynchronousGuard(ref, underlying),
    withSynchronousGuard(ref, underlying),
    withSynchronousGuard(ref, underlying),
    withSynchronousGuard(ref, underlying),
    withSynchronousGuard(ref, underlying),
  ];
  await Promise.all(attempts);

  assert.equal(calls, 1, "only the FIRST tap's call may reach the underlying request — every other tap for the same active episode must return without one");
  assert.equal(ref.current, false, "ownership must be released once the owned request reaches its terminal state, allowing a genuinely later attempt to proceed");
});

test("V2.8.5.2 (D) REQUIRED TEST — once released, a genuinely later call is allowed through (this is a de-duplication guard, not a permanent lock)", async () => {
  const ref = { current: false };
  let calls = 0;
  const underlying = async () => {
    calls += 1;
  };
  await withSynchronousGuard(ref, underlying);
  await withSynchronousGuard(ref, underlying);
  assert.equal(calls, 2, "a call that begins after the previous one fully released must go through -- e.g. the quiet turn_in_progress retry, or a real Retry tap after a genuine failure");
});

test("V2.8.5.2 (D): GameClient.tsx's sendTurn() claims answerInFlightRef synchronously before any await, and releases it only once runOwnedTurnRequest settles", () => {
  const sendTurnBlock = CLIENT.slice(CLIENT.indexOf("const sendTurn = useCallback("), CLIENT.indexOf("const retryTurn = useCallback("));
  assert.match(sendTurnBlock, /if \(answerInFlightRef\.current\) return;/);
  assert.match(sendTurnBlock, /answerInFlightRef\.current = true;/);
  assert.match(sendTurnBlock, /answerInFlightRef\.current = false;/);
  // The guard must be the FIRST thing in the function body -- before the
  // runOwnedTurnRequest call it protects, not merely present somewhere in it.
  const guardIndex = sendTurnBlock.indexOf("if (answerInFlightRef.current) return;");
  const requestIndex = sendTurnBlock.indexOf("await runOwnedTurnRequest(");
  assert.ok(guardIndex >= 0 && requestIndex >= 0 && guardIndex < requestIndex);
});

test("V2.8.5.2 (C.5/D): GameClient.tsx's resolveGame() claims resolveInFlightRef synchronously before any await, and releases it only once runOwnedResolveRequest settles", () => {
  const resolveBlock = CLIENT.slice(CLIENT.indexOf("const resolveGame = useCallback("), CLIENT.indexOf("const guessCheckpoint ="));
  assert.match(resolveBlock, /if \(resolveInFlightRef\.current\) return;/);
  assert.match(resolveBlock, /resolveInFlightRef\.current = true;/);
  assert.match(resolveBlock, /resolveInFlightRef\.current = false;/);
  assert.match(resolveBlock, /runOwnedResolveRequest\(/);
  const guardIndex = resolveBlock.indexOf("if (resolveInFlightRef.current) return;");
  const requestIndex = resolveBlock.indexOf("await runOwnedResolveRequest(");
  assert.ok(guardIndex >= 0 && requestIndex >= 0 && guardIndex < requestIndex);
});
