import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createWaitingMessageRotation,
  shuffle,
  stageForElapsedMs,
  thinkingStatusText,
  THINKING_STAGE_BOUNDARIES_MS,
  THINKING_STAGE_COPY,
  WAITING_MESSAGE_ROTATION_MS,
  WAITING_MESSAGES,
  type ThinkingStage,
} from "../lib/thinkingIndicator";

// ---------------------------------------------------------------------------
// V2.8.4.1 — three-stage AI-activity indicator: pure elapsed-time -> stage
// logic. This project has no jsdom/testing-library dependency, so — matching
// lib/turnRecovery.ts and lib/turnRequestGuard.ts's own established pattern —
// the actual decision logic lives in a pure module and is driven here with
// fixed millisecond values standing in for fake timers. The React component
// (app/components/ThinkingIndicator.tsx) is a thin, directly-reviewed wrapper
// that calls this same function against a real clock.
// ---------------------------------------------------------------------------

test("stage 1 (eager): 0ms up to just under 20s", () => {
  assert.equal(stageForElapsedMs(0), "eager");
  assert.equal(stageForElapsedMs(1), "eager");
  assert.equal(stageForElapsedMs(19_999), "eager");
});

test("stage 2 (focused): exactly 20s up to just under 40s", () => {
  assert.equal(stageForElapsedMs(20_000), "focused");
  assert.equal(stageForElapsedMs(20_001), "focused");
  assert.equal(stageForElapsedMs(39_999), "focused");
});

test("stage 3 (deep): exactly 40s and beyond, with no upper bound -- the third stage does not stop at 60s or any other fixed ceiling", () => {
  assert.equal(stageForElapsedMs(40_000), "deep");
  assert.equal(stageForElapsedMs(60_000), "deep");
  assert.equal(stageForElapsedMs(600_000), "deep");
  assert.equal(stageForElapsedMs(Number.MAX_SAFE_INTEGER), "deep");
});

test("the boundaries are exactly 20s and 40s, matching the ticket's stage definitions", () => {
  assert.equal(THINKING_STAGE_BOUNDARIES_MS.focused, 20_000);
  assert.equal(THINKING_STAGE_BOUNDARIES_MS.deep, 40_000);
});

test("every stage has both an English and a Hungarian status line, and none are empty", () => {
  for (const lang of ["en", "hu"] as const) {
    for (const stage of ["eager", "focused", "deep"] as const) {
      const text = THINKING_STAGE_COPY[lang][stage];
      assert.equal(typeof text, "string");
      assert.ok(text.length > 0, `${lang}/${stage} must have real copy`);
    }
  }
});

test("no stage's copy claims a percentage or guaranteed completion", () => {
  for (const lang of ["en", "hu"] as const) {
    for (const stage of ["eager", "focused", "deep"] as const) {
      const text = THINKING_STAGE_COPY[lang][stage];
      assert.doesNotMatch(text, /%/, `${lang}/${stage} must not display a fake percentage`);
    }
  }
});

test("thinkingStatusText composes stageForElapsedMs and the copy table consistently", () => {
  assert.equal(thinkingStatusText("en", 0), THINKING_STAGE_COPY.en.eager);
  assert.equal(thinkingStatusText("hu", 25_000), THINKING_STAGE_COPY.hu.focused);
  assert.equal(thinkingStatusText("en", 90_000), THINKING_STAGE_COPY.en.deep);
});

// ---------------------------------------------------------------------------
// V2.8.4.2 — EXPANDED WAITING-MESSAGE LIBRARY. Decorative, rotating, purely
// visual copy -- separate from THINKING_STAGE_COPY above, which remains the
// stable, infrequently-changing aria-live status (see
// app/components/ThinkingIndicator.tsx's own module doc for why there are
// two channels rather than one).
// ---------------------------------------------------------------------------

const STAGES: readonly ThinkingStage[] = ["eager", "focused", "deep"];

test("at least 8 curated pairs per stage, at least 24 total", () => {
  let total = 0;
  for (const stage of STAGES) {
    assert.ok(WAITING_MESSAGES[stage].length >= 8, `${stage} must have at least 8 pairs`);
    total += WAITING_MESSAGES[stage].length;
  }
  assert.ok(total >= 24, `expected at least 24 pairs total, got ${total}`);
});

test("every pair has non-empty EN and HU text", () => {
  for (const stage of STAGES) {
    for (const pair of WAITING_MESSAGES[stage]) {
      assert.ok(pair.en.trim().length > 0, `${stage}: empty EN pair`);
      assert.ok(pair.hu.trim().length > 0, `${stage}: empty HU pair`);
    }
  }
});

test("no message implies false progress, a percentage, a guaranteed time, or secret/target-specific knowledge", () => {
  const bannedPatterns = [
    /%/,
    /\bdid you know\b/i,
    /\balmost (done|there|finished)\b/i,
    /\d+\s*(seconds?|minutes?|percent)\b/i,
    /\bguarantee/i,
  ];
  for (const stage of STAGES) {
    for (const pair of WAITING_MESSAGES[stage]) {
      for (const lang of ["en", "hu"] as const) {
        for (const pattern of bannedPatterns) {
          assert.doesNotMatch(pair[lang], pattern, `${stage}/${lang}: "${pair[lang]}" matches banned pattern ${pattern}`);
        }
      }
    }
  }
});

test("WAITING_MESSAGES is a static constant with no parameters -- structurally, no code path exists for a target or any per-game data to reach it", () => {
  const src = readFileSync("lib/thinkingIndicator.ts", "utf8");
  assert.match(src, /export const WAITING_MESSAGES: Record<ThinkingStage, readonly WaitingMessagePair\[\]> = \{/);
  assert.doesNotMatch(src, /import.*secretStore|import.*GameRecord/);
});

test("shuffle returns a permutation of the same items and does not mutate the input", () => {
  const items = [1, 2, 3, 4, 5];
  const copy = [...items];
  const shuffled = shuffle(items, () => 0.999999); // deterministic-ish, exercises the swap logic
  assert.deepEqual(items, copy, "input must not be mutated");
  assert.equal(shuffled.length, items.length);
  assert.deepEqual([...shuffled].sort(), [...items].sort());
});

test("shuffle with random() always returning 0 still produces every element exactly once", () => {
  const items = ["a", "b", "c", "d"];
  const shuffled = shuffle(items, () => 0);
  assert.deepEqual([...shuffled].sort(), [...items].sort());
});

test("createWaitingMessageRotation: no repeat within one full pass through a stage's pool", () => {
  const rotation = createWaitingMessageRotation();
  const poolSize = WAITING_MESSAGES.eager.length;
  const seen = new Set<string>();
  for (let i = 0; i < poolSize; i += 1) {
    const pair = rotation.next("eager");
    assert.ok(!seen.has(pair.en), `repeated "${pair.en}" before the pool was exhausted`);
    seen.add(pair.en);
  }
  assert.equal(seen.size, poolSize, "every message in the pool must have been shown exactly once");
});

test("createWaitingMessageRotation: reshuffles a fresh cycle once the pool is exhausted, rather than stopping", () => {
  const rotation = createWaitingMessageRotation();
  const poolSize = WAITING_MESSAGES.eager.length;
  const firstCycle = new Set<string>();
  for (let i = 0; i < poolSize; i += 1) firstCycle.add(rotation.next("eager").en);
  // The pool is now exhausted; the NEXT draw must still return a valid pair
  // from the same stage's pool (a reshuffle), not throw or return undefined.
  const afterExhaustion = rotation.next("eager");
  assert.ok(WAITING_MESSAGES.eager.some((p) => p.en === afterExhaustion.en));
});

test("createWaitingMessageRotation: each stage has its own independent pool -- exhausting one does not affect another", () => {
  const rotation = createWaitingMessageRotation();
  for (let i = 0; i < WAITING_MESSAGES.eager.length; i += 1) rotation.next("eager");
  // focused's pool must still be fully available, untouched by eager's draws.
  const focusedSeen = new Set<string>();
  for (let i = 0; i < WAITING_MESSAGES.focused.length; i += 1) {
    focusedSeen.add(rotation.next("focused").en);
  }
  assert.equal(focusedSeen.size, WAITING_MESSAGES.focused.length);
});

test("createWaitingMessageRotation: current() reads without advancing; next() advances", () => {
  const rotation = createWaitingMessageRotation();
  const a = rotation.current("deep");
  const b = rotation.current("deep");
  assert.deepEqual(a, b, "current() must be stable until next() is called");
  const c = rotation.next("deep");
  const d = rotation.current("deep");
  assert.deepEqual(c, d, "current() reflects whatever next() most recently drew");
});

test("a NEW rotation instance starts a fresh episode, independent of any previous instance's history", () => {
  const first = createWaitingMessageRotation();
  const firstDraw = first.next("eager");
  const second = createWaitingMessageRotation();
  // The second episode's pool is fresh -- it is not required to differ from
  // the first draw (both draw from the same finite pool), but it must be a
  // valid, independently-initialized pool, not an error or empty result.
  const secondDraw = second.next("eager");
  assert.ok(WAITING_MESSAGES.eager.some((p) => p.en === secondDraw.en));
  assert.ok(WAITING_MESSAGES.eager.some((p) => p.en === firstDraw.en));
});

test("the rotation cadence is calm, not chatty -- several seconds, not sub-second", () => {
  assert.ok(WAITING_MESSAGE_ROTATION_MS >= 3000, "must not rotate faster than a few seconds");
  assert.ok(WAITING_MESSAGE_ROTATION_MS <= 8000, "must not be so slow it reads as static");
});

// --- Component-level (source-checked): stable aria-live status is separate -
// --- from the decorative rotation, so rotation cannot flood a screen reader.

const TI = readFileSync("app/components/ThinkingIndicator.tsx", "utf8");

test("the decorative rotating message is aria-hidden, never inside the aria-live region", () => {
  assert.match(TI, /aria-hidden="true"[\s\S]{0,80}\{messagePair\[language\]\}/);
});

test("exactly one stable aria-live status exists, driven by THINKING_STAGE_COPY (unchanged since v2.8.4.1), not the rotating library", () => {
  assert.match(TI, /role="status" aria-live="polite"/);
  const liveRegionCount = (TI.match(/aria-live="polite"/g) ?? []).length;
  assert.equal(liveRegionCount, 1, "exactly one live region -- the rotation must not create its own");
  assert.match(TI, /aria-live="polite"[\s\S]{0,40}>\s*\{THINKING_STAGE_COPY\[language\]\[stage\]\}/);
});

test("reduced-motion still disables the spin animation, unchanged from v2.8.4.1", () => {
  assert.match(TI, /motion-reduce:animate-none/);
});
