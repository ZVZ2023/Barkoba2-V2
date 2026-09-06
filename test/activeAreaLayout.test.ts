import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.8.7.4 — DEFECT 1: ACTIVE DIALOGUE MUST PRECEDE THE TRANSCRIPT.
//
// Production evidence: in AI-Setter/human-Racer play (RacerClient.tsx), the
// active text box and Ask/Hint/Guess controls rendered AFTER the entire
// (already newest-first, V2.8.7.3) transcript, forcing the player to scroll
// down to submit a question and back up to read the answer.
//
// Required structure during active play, top to bottom:
//   1. Header and game status
//   2. Complete active interaction area
//   3. Newest answered turn
//   4. Earlier turns descending
//
// Required structure during a terminal state:
//   1. Result panel
//   2. Final/newest turn
//   3. Remaining turns descending
//   4. No active submission controls
//
// GameClient.tsx already followed this shape since V2.8.4.1 (its own
// "ACTIVE AREA, always first" comment) -- this file proves it explicitly
// alongside the two screens that did not, so all three are covered by the
// same assertions and cannot silently diverge again.
//
// No rendering harness exists in this project (see
// test/resultScreenProfileLeak.test.ts's own doc), so wiring is proven from
// source, matching this codebase's established convention.
// ---------------------------------------------------------------------------

const GAME_CLIENT = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
const RACER_CLIENT = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");
const HUMAN_CLIENT = readFileSync("app/game/[id]/HumanClient.tsx", "utf8");

// ---------------------------------------------------------------------------
// Active controls precede transcript history.
// ---------------------------------------------------------------------------

test("GameClient.tsx: the active area (pending question / clue / guess checkpoint) precedes the history render call", () => {
  const activeAreaAt = GAME_CLIENT.indexOf("ACTIVE AREA, always first");
  const historyAt = GAME_CLIENT.indexOf("completedHistoryForDisplay(turns).map");
  assert.ok(activeAreaAt > 0 && historyAt > activeAreaAt);
});

test("RacerClient.tsx: the ask/hint/guess controls precede the history render call", () => {
  const askBlockAt = RACER_CLIENT.indexOf("{live && !guessMode && (");
  const guessBlockAt = RACER_CLIENT.indexOf("{live && guessMode && (");
  const historyAt = RACER_CLIENT.indexOf("completedHistoryForDisplay(turns).map");
  assert.ok(askBlockAt > 0 && guessBlockAt > askBlockAt && historyAt > guessBlockAt);
});

test("HumanClient.tsx: the Composer's answer controls, the hint control, and the Racer's ask/guess controls all precede the <ol> transcript", () => {
  const answerBlockAt = HUMAN_CLIENT.indexOf('{live && iAmComposer && view.your_turn && (');
  const hintBlockAt = HUMAN_CLIENT.indexOf("{live && iAmComposer && (");
  const racerBlockAt = HUMAN_CLIENT.indexOf('{live && !iAmComposer && view.your_turn && (');
  const olAt = HUMAN_CLIENT.indexOf('<ol className="flex flex-col gap-2">');
  assert.ok(answerBlockAt > 0);
  assert.ok(hintBlockAt > answerBlockAt);
  assert.ok(racerBlockAt > hintBlockAt);
  assert.ok(olAt > racerBlockAt);
});

// ---------------------------------------------------------------------------
// Terminal result precedes history (already covered for the result panel
// itself in test/mobileRevealTranscriptOrder.test.ts) -- here: no active
// submission controls remain reachable once the game is complete, because
// every one of them is gated on `live`/`!over`, which becomes false exactly
// when the game reaches "complete".
// ---------------------------------------------------------------------------

test("GameClient.tsx: no active submission control can render once the game is complete -- every active-area conditional is itself gated on state that a completed game cannot satisfy", () => {
  // pendingQuestion/pendingClueRequest/pendingGuessCheckpoint all derive from
  // the LAST qa_log entry being unanswered/pending -- a completed game's log
  // ends in an adjudicated guess or concession, satisfying none of them.
  assert.match(GAME_CLIENT, /const pending = pendingQuestion\(game\)/);
  assert.match(GAME_CLIENT, /const clueWanted = pendingClueRequest\(game\)/);
  assert.match(GAME_CLIENT, /const guessCheckpoint = pendingGuessCheckpoint\(game\)/);
  // The correction control inside history is also phase-gated, not merely
  // hidden by coincidence.
  assert.match(GAME_CLIENT, /\(game\.phase === "questioning" \|\|/);
  assert.match(
    GAME_CLIENT,
    /guessRevealPending && guessCheckpoint!\.answeredEntry\.turn_index === entry\.turn_index\)\) &&/
  );
});

test("RacerClient.tsx: every active-area control is gated on `live` (game.phase === \"questioning\"), which is false once the game is complete", () => {
  assert.match(RACER_CLIENT, /const live = game\.phase === "questioning"/);
  // The three active-area blocks this defect moved: ask/hint/guess-mode-off,
  // guess-mode-on, and the busy/error/empty-state lines directly beside them.
  assert.match(RACER_CLIENT, /\{live && !guessMode && \(/);
  assert.match(RACER_CLIENT, /\{live && guessMode && \(/);
  assert.match(RACER_CLIENT, /\{live && error && \(/);
  assert.match(RACER_CLIENT, /\{turns\.length === 0 && live && \(/);
  // The correction editor's own trigger is gated the same way.
  assert.match(RACER_CLIENT, /\{live &&\s*\n\s*entry\.turn_index === turns\[turns\.length - 1\]\?\.turn_index &&/);
});

test("HumanClient.tsx: every active-area control is gated on `live` (questioning AND not awaiting the Racer) or `over`, either of which excludes the other in a completed game", () => {
  assert.match(HUMAN_CLIENT, /const over = view\.phase === "complete"/);
  assert.match(HUMAN_CLIENT, /const live = view\.phase === "questioning" && !view\.awaiting_racer/);
  assert.match(HUMAN_CLIENT, /\{live && iAmComposer && view\.your_turn && \(/);
  assert.match(HUMAN_CLIENT, /\{live && iAmComposer && \(/);
  assert.match(HUMAN_CLIENT, /\{live && !iAmComposer && view\.your_turn && \(/);
});

// ---------------------------------------------------------------------------
// Sanity: the restructuring did not duplicate any of the moved blocks --
// each active-area block, and the history render call, appears exactly once
// per file.
// ---------------------------------------------------------------------------

test("no active-area block or history call was duplicated by the restructuring", () => {
  const count = (src: string, needle: string) => (src.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;

  assert.equal(count(RACER_CLIENT, "{live && !guessMode && ("), 1);
  assert.equal(count(RACER_CLIENT, "{live && guessMode && ("), 1);
  assert.equal(count(RACER_CLIENT, "completedHistoryForDisplay(turns).map("), 1);
  assert.equal(count(RACER_CLIENT, "<p className=\"text-sm text-[var(--ink-soft)]\">Gondolkodik…</p>"), 1);
  assert.equal(count(RACER_CLIENT, "{live && error && ("), 1);

  assert.equal(count(HUMAN_CLIENT, '{live && iAmComposer && view.your_turn && ('), 1);
  assert.equal(count(HUMAN_CLIENT, "{live && iAmComposer && ("), 1);
  assert.equal(count(HUMAN_CLIENT, '{live && !iAmComposer && view.your_turn && ('), 1);
  assert.equal(count(HUMAN_CLIENT, 'completedHistoryForDisplay(view.turns).map('), 1);
  assert.equal(count(HUMAN_CLIENT, "{over && ("), 1);

  assert.equal(count(GAME_CLIENT, "{sandboxClarificationFailed && ("), 1);
  assert.equal(count(GAME_CLIENT, "{error && ("), 1);
  assert.equal(count(GAME_CLIENT, "completedHistoryForDisplay(turns).map("), 1);
});
