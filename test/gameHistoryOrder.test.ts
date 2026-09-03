import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { completedHistoryForDisplay } from "../lib/gameHistoryOrder";

// ---------------------------------------------------------------------------
// V2.8.4.2 — DESCENDING COMPLETED-QUESTION HISTORY.
//
// completedHistoryForDisplay is the ENTIRE feature: a pure reversal for
// rendering only. No rendering harness exists in this project, so the source
// file is also checked as text (matching test/guessCheckpoint.test.ts's own
// established convention) to prove the active area renders before the
// history list, and that nothing but the display call site was touched.
// ---------------------------------------------------------------------------

test("returns entries newest-first", () => {
  const chronological = ["Q1", "Q2", "Q3", "Q4"];
  assert.deepEqual(completedHistoryForDisplay(chronological), ["Q4", "Q3", "Q2", "Q1"]);
});

test("never mutates the source array", () => {
  const chronological = ["Q1", "Q2", "Q3"];
  const copy = [...chronological];
  completedHistoryForDisplay(chronological);
  assert.deepEqual(chronological, copy, "the input array's own order must be untouched");
});

test("contains every entry exactly once -- no duplication, no omission", () => {
  const chronological = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const display = completedHistoryForDisplay(chronological);
  assert.equal(display.length, chronological.length);
  const displayIds = display.map((e) => e.id).sort();
  const sourceIds = chronological.map((e) => e.id).sort();
  assert.deepEqual(displayIds, sourceIds);
});

test("is its own array -- not the same reference as the input", () => {
  const chronological = ["Q1", "Q2"];
  const display = completedHistoryForDisplay(chronological);
  assert.notEqual(display, chronological);
});

test("an empty history reverses to an empty history", () => {
  assert.deepEqual(completedHistoryForDisplay([]), []);
});

test("a single completed question is unaffected by reversal", () => {
  assert.deepEqual(completedHistoryForDisplay(["Q1"]), ["Q1"]);
});

// --- Source-level: active area precedes history; qa_log itself is never ----
// --- reversed; the chronological `turns` array remains the source of truth.-

const GC = readFileSync("app/game/[id]/GameClient.tsx", "utf8");

test("the active area (pending question / clue / guess checkpoint) renders BEFORE completedHistoryForDisplay in source order, matching DOM order", () => {
  const activeAreaAt = GC.indexOf("ACTIVE AREA, always first");
  const historyCallAt = GC.indexOf("completedHistoryForDisplay(turns).map");
  assert.ok(activeAreaAt >= 0, "active area block must exist");
  assert.ok(historyCallAt > activeAreaAt, "history must be rendered after the active area, not before it");
});

test("completedHistoryForDisplay is used for RENDERING ONLY -- turns/game.qa_log/numbers/discardCount/correction logic all read the chronological source, never a reversed one", () => {
  // Exactly one call site: the .map() that renders history. Every other
  // consumer of the log (turn numbering, discard-count math, the pending-
  // question lookup, the correction window) must keep reading `turns` or
  // `game.qa_log` directly.
  const callSites = (GC.match(/completedHistoryForDisplay\(/g) ?? []).length;
  assert.equal(callSites, 1, "completedHistoryForDisplay must be called exactly once");
  assert.match(GC, /const numbers = questionNumbers\(game\.qa_log\)/, "turn numbering must read the stored, chronological qa_log");
  assert.match(GC, /function discardCount\(game: GameRecord, turnIndex: number\)/);
  assert.match(
    readFileSync("lib/gameHistoryOrder.ts", "utf8"),
    /export function completedHistoryForDisplay<T>\(turns: readonly T\[\]\): T\[\]/,
    "the reversal helper must stay GENERIC -- it cannot know about GameRecord/qa_log's shape, only reverse whatever array it is given"
  );
});

test("lib/gameHistoryOrder.ts has no imports at all -- a generic reversal cannot reach storage, corpus, replay, or Phase One derivation", () => {
  const src = readFileSync("lib/gameHistoryOrder.ts", "utf8");
  assert.doesNotMatch(src, /^import /m);
});
