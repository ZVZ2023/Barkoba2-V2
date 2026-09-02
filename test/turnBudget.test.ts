import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TURN_BUDGET_CONFIG,
  decideAttemptBudget,
  isLocalTimeoutError,
  runWithAbortTimeout,
} from "../lib/turnBudget";

// ---------------------------------------------------------------------------
// S2 / RB-2 — pure budget arithmetic, no real 45-300 second waits.
// ---------------------------------------------------------------------------

// --- REQUIRED 4: no new attempt starts with less than 45s remaining --------

test("REQUIRED 4: exactly at the 45s floor, an attempt IS allowed", () => {
  const now = 1_000_000;
  const deadline = now + TURN_BUDGET_CONFIG.minRemainingToStartMs; // exactly 45s remaining
  const decision = decideAttemptBudget(deadline, now);
  assert.equal(decision.allowed, true);
});

test("REQUIRED 4: one millisecond under the 45s floor, no attempt starts", () => {
  const now = 1_000_000;
  const deadline = now + TURN_BUDGET_CONFIG.minRemainingToStartMs - 1;
  const decision = decideAttemptBudget(deadline, now);
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowanceMs, 0, "nothing to enforce when nothing may start");
});

test("REQUIRED 4: the deadline already passed -- no attempt starts", () => {
  const now = 1_000_000;
  const decision = decideAttemptBudget(now - 1, now);
  assert.equal(decision.allowed, false);
});

// --- REQUIRED 6: each attempt gets min(150s, remaining budget) -------------

test("REQUIRED 6: ample remaining budget caps the attempt at 150s, never more", () => {
  const now = 0;
  const deadline = TURN_BUDGET_CONFIG.sharedDeadlineMs; // full 240s remaining
  const decision = decideAttemptBudget(deadline, now);
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowanceMs, TURN_BUDGET_CONFIG.perAttemptMaxMs);
});

test("REQUIRED 6: scarce remaining budget (but above the floor) allows exactly what remains, not 150s", () => {
  const now = 0;
  const deadline = 60_000; // 60s remaining -- above the 45s floor, below the 150s cap
  const decision = decideAttemptBudget(deadline, now);
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowanceMs, 60_000);
});

// --- REQUIRED 3: total provider time cannot exceed the shared 240s deadline

test("REQUIRED 3: a sequence of attempts, each drawing on the SAME absolute deadline, can never collectively exceed it", () => {
  // Simulate three attempts, each of which "took" 80s of wall-clock time
  // (fast enough to matter, per REQUIRED 2 below). Time already consumed is
  // reflected automatically because `now` advances between calls -- no
  // separate bookkeeping of "time spent so far" exists or is needed.
  let now = 0;
  const deadline = now + TURN_BUDGET_CONFIG.sharedDeadlineMs; // 240s absolute

  const d1 = decideAttemptBudget(deadline, now);
  assert.equal(d1.allowed, true);
  now += 80_000; // attempt 1 "took" 80s

  const d2 = decideAttemptBudget(deadline, now);
  assert.equal(d2.allowed, true);
  assert.ok(d2.remainingMs <= TURN_BUDGET_CONFIG.sharedDeadlineMs - 80_000);
  now += 80_000; // attempt 2 "took" another 80s -- 160s consumed, 80s left

  const d3 = decideAttemptBudget(deadline, now);
  assert.equal(d3.allowed, true, "80s remaining is still above the 45s floor");
  assert.equal(d3.allowanceMs, 80_000, "capped by what remains, not by the 150s per-attempt max");
  now += 80_000; // attempt 3 "took" another 80s -- 240s consumed, deadline reached

  const d4 = decideAttemptBudget(deadline, now);
  assert.equal(d4.allowed, false, "the shared deadline is exhausted -- no fourth attempt");
  assert.ok(now <= deadline + 1, "total consumed time never exceeds the shared deadline by construction");
});

// --- REQUIRED 7/8 support: the abort-timeout primitive ---------------------

test("REQUIRED 8: a slow operation is aborted and classified as a local timeout", async () => {
  const neverSettlesUntilAborted = (signal: AbortSignal) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });

  await assert.rejects(
    () => runWithAbortTimeout(5, neverSettlesUntilAborted), // 5ms, not 150s -- controlled clock
    (err: unknown) => {
      assert.equal(isLocalTimeoutError(err), true);
      return true;
    }
  );
});

test("REQUIRED 8: a fast-resolving operation is NOT aborted, and its timer is cleared", async () => {
  let clearedCount = 0;
  const originalClearTimeout = global.clearTimeout;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).clearTimeout = ((id: NodeJS.Timeout) => {
    clearedCount += 1;
    return originalClearTimeout(id);
  }) as typeof clearTimeout;

  try {
    const result = await runWithAbortTimeout(50, async (signal) => {
      assert.equal(signal.aborted, false, "must not be aborted before the fast operation finishes");
      return "done";
    });
    assert.equal(result, "done");
  } finally {
    global.clearTimeout = originalClearTimeout;
  }

  assert.equal(clearedCount, 1, "the timer must be cleared exactly once, in finally");
});

test("isLocalTimeoutError does not misclassify an ordinary error as a timeout", () => {
  assert.equal(isLocalTimeoutError(new Error("xAI API error (500): boom")), false);
  assert.equal(isLocalTimeoutError("not even an Error"), false);
  assert.equal(isLocalTimeoutError(null), false);
});

// ---------------------------------------------------------------------------
// Ordering pin: sharedDeadline < route maxDuration < TURN_LOCK_TTL_SECONDS.
//
// REQUIRED 15's real claim -- that the lock stays held past the 270s route
// boundary and up to its own 300s TTL -- cannot be proven by waiting 300
// real seconds in a test. What CAN be proven, and is the actual safety
// property, is that the three literals are declared in the required order
// and stay that way; lib/gameStore.ts's acquireTurnLock/casSetWithRevision
// mechanics are exercised for real (fast) concurrency in
// test/turnIntegrityHotfix.test.ts's own CONCURRENCY test, which still
// passes unmodified after S2.
// ---------------------------------------------------------------------------

const ROUTE_SOURCE = readFileSync("app/api/game/[id]/turn/route.ts", "utf8");

test("REQUIRED (timing relationship): maxDuration is a literal 270, statically analyzable", () => {
  assert.match(ROUTE_SOURCE, /export const maxDuration = 270;/);
});

test("REQUIRED (timing relationship): TURN_LOCK_TTL_SECONDS is an independent literal 300, no longer tied to maxDuration", () => {
  assert.match(ROUTE_SOURCE, /const TURN_LOCK_TTL_SECONDS = 300;/);
  assert.doesNotMatch(
    ROUTE_SOURCE,
    /const TURN_LOCK_TTL_SECONDS = maxDuration;/,
    "the pre-S2 coupling must be gone"
  );
});

test("REQUIRED 15 (ordering pin): sharedDeadline(240s) < maxDuration(270s) < TURN_LOCK_TTL_SECONDS(300s)", () => {
  const sharedDeadlineSeconds = TURN_BUDGET_CONFIG.sharedDeadlineMs / 1000;
  const maxDurationMatch = ROUTE_SOURCE.match(/export const maxDuration = (\d+);/);
  const lockTtlMatch = ROUTE_SOURCE.match(/const TURN_LOCK_TTL_SECONDS = (\d+);/);
  assert.ok(maxDurationMatch && lockTtlMatch, "could not locate both literals in the route source");

  const maxDurationSeconds = Number(maxDurationMatch![1]);
  const lockTtlSeconds = Number(lockTtlMatch![1]);

  assert.equal(sharedDeadlineSeconds, 240);
  assert.equal(maxDurationSeconds, 270);
  assert.equal(lockTtlSeconds, 300);
  assert.ok(sharedDeadlineSeconds < maxDurationSeconds, "shared deadline must be < maxDuration");
  assert.ok(maxDurationSeconds < lockTtlSeconds, "maxDuration must be < the lock TTL");
});

test("MAX_DUPLICATE_QUESTION_ATTEMPTS remains 3 -- S2 does not touch the duplicate-guard ceiling", () => {
  assert.match(ROUTE_SOURCE, /const MAX_DUPLICATE_QUESTION_ATTEMPTS = 3;/);
});
