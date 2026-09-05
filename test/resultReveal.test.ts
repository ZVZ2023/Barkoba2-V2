import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRevealScrollTop, shouldRevealResult } from "../lib/resultReveal";
import type { GamePhase } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.7.2 — auto-reveal the terminal result. Pure decision + arithmetic,
// directly tested; GameClient.tsx is a thin wrapper over these two functions
// (same pattern as lib/turnRecovery.ts / lib/thinkingIndicator.ts — this
// project has no jsdom/testing-library dependency).
// ---------------------------------------------------------------------------

const PHASES: GamePhase[] = ["questioning", "resolving", "complete"];

test("shouldRevealResult: fires exactly on the transition INTO complete", () => {
  assert.equal(shouldRevealResult({ previousPhase: "resolving", phase: "complete" }), true);
  assert.equal(shouldRevealResult({ previousPhase: "questioning", phase: "complete" }), true);
});

test("shouldRevealResult: does not fire while already complete (an unrelated re-render must not re-steal focus/scroll)", () => {
  assert.equal(shouldRevealResult({ previousPhase: "complete", phase: "complete" }), false);
});

test("shouldRevealResult: does not fire before resolution -- ordinary scrolling during play is untouched", () => {
  for (const previousPhase of PHASES) {
    for (const phase of PHASES) {
      if (phase === "complete") continue;
      assert.equal(
        shouldRevealResult({ previousPhase, phase }),
        false,
        `previousPhase=${previousPhase} phase=${phase}`
      );
    }
  }
});

test("shouldRevealResult: covers every terminal outcome equally -- the check is on phase alone, not on which game.result value produced it", () => {
  // game.result (racer_correct / racer_incorrect / composer_win_integrity_upheld
  // / racer_win_integrity_violation) is irrelevant to this decision: every one
  // of them is reached the same way, by phase becoming "complete". Confirmed
  // once here rather than per-outcome, since shouldRevealResult never reads
  // game.result at all.
  assert.equal(shouldRevealResult({ previousPhase: "resolving", phase: "complete" }), true, "racer_correct/racer_incorrect/concession/adjudication all reach this identically");
});

test("computeRevealScrollTop: places the heading just below a zero-height (no) header, with the default margin", () => {
  assert.equal(
    computeRevealScrollTop({ targetTop: 500, currentScrollY: 0, headerHeight: 0 }),
    488 // 0 + 500 - 0 - 12
  );
});

test("computeRevealScrollTop: subtracts the header's actual measured height, whether it is in-flow or fixed/sticky", () => {
  assert.equal(
    computeRevealScrollTop({ targetTop: 500, currentScrollY: 0, headerHeight: 80 }),
    408 // 0 + 500 - 80 - 12
  );
});

test("computeRevealScrollTop: adds the page's current scroll position -- targetTop is viewport-relative, not page-absolute", () => {
  assert.equal(
    computeRevealScrollTop({ targetTop: 120, currentScrollY: 2000, headerHeight: 80 }),
    2028 // 2000 + 120 - 80 - 12
  );
});

test("computeRevealScrollTop: never negative -- there is nothing above the top of the page to scroll past", () => {
  assert.equal(computeRevealScrollTop({ targetTop: 10, currentScrollY: 0, headerHeight: 200 }), 0);
});

test("computeRevealScrollTop: a custom margin is honored", () => {
  assert.equal(
    computeRevealScrollTop({ targetTop: 500, currentScrollY: 0, headerHeight: 80, marginPx: 40 }),
    380 // 0 + 500 - 80 - 40
  );
});
