import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stageForElapsedMs,
  thinkingStatusText,
  THINKING_STAGE_BOUNDARIES_MS,
  THINKING_STAGE_COPY,
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
