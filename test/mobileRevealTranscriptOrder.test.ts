import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { completedHistoryForDisplay } from "../lib/gameHistoryOrder";

// ---------------------------------------------------------------------------
// V2.8.7.3 — MOBILE RESULT REVEAL + UNIVERSAL NEWEST-FIRST TRANSCRIPTS.
//
// Two confirmed field failures, ACROSS ALL THREE player-facing game screens
// (GameClient.tsx, RacerClient.tsx, HumanClient.tsx) -- not just the one
// GameClient.tsx originally shipped V2.8.7.2's reveal feature on:
//
//  DEFECT 1 (mobile reveal never actually landed, and never existed at all
//  on two of the three screens) is fixed by ONE shared hook,
//  app/components/useResultReveal.ts, called by all three screens -- see
//  test/resultAutoReveal.test.ts for the hook's own iOS-fix assertions. This
//  file proves the cross-cutting requirement: no screen may reimplement or
//  omit the mechanism, each result heading is a real focus target, and
//  moving the result earlier in the DOM (V2.8.7.3's first pass) is not a
//  substitute for actually scrolling to it (a player already scrolled deep
//  into a long game does not get walked back to the top by DOM order alone).
//
//  DEFECT 2 (inconsistent question order) is fixed by reusing ONE shared,
//  already-tested, generic helper -- lib/gameHistoryOrder.ts's
//  completedHistoryForDisplay -- in the two screens that did not already use
//  it: app/game/[id]/RacerClient.tsx (AI Setter / human Racer) and
//  app/game/[id]/HumanClient.tsx (human / human). GameClient.tsx (human
//  Setter / AI Racer) already used it since V2.8.4.2 -- see
//  test/gameHistoryOrder.test.ts. Every call site is UNCONDITIONAL on
//  game.phase, so newest-first applies identically during active play,
//  after completion, and on a reopened game from History -- there is no
//  separate "completed history" code path to fall out of sync.
//
// No rendering harness exists in this project (see
// test/resultScreenProfileLeak.test.ts's own doc), so wiring is proven from
// source, matching this codebase's established convention.
// ---------------------------------------------------------------------------

const GAME_CLIENT = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
const RACER_CLIENT = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");
const HUMAN_CLIENT = readFileSync("app/game/[id]/HumanClient.tsx", "utf8");
const GAME_VIEW = readFileSync("lib/gameView.ts", "utf8");
const RESULT_PANEL = readFileSync("app/game/[id]/ResultPanel.tsx", "utf8");

// ---------------------------------------------------------------------------
// #22 before #21 before #1 -- the pure helper itself, with turn-index-shaped
// data rather than the toy ["Q1".."Q4"] fixture gameHistoryOrder.test.ts
// already covers generically.
// ---------------------------------------------------------------------------

test("completedHistoryForDisplay: #22 renders before #21, which renders before #1", () => {
  const chronological = Array.from({ length: 22 }, (_, i) => ({ turn_index: i + 1 }));
  const display = completedHistoryForDisplay(chronological);
  assert.equal(display[0]?.turn_index, 22);
  assert.equal(display[1]?.turn_index, 21);
  assert.equal(display[display.length - 1]?.turn_index, 1);
  // #22 strictly before #21 strictly before #1, not merely "somewhere earlier".
  const indexOf22 = display.findIndex((e) => e.turn_index === 22);
  const indexOf21 = display.findIndex((e) => e.turn_index === 21);
  const indexOf1 = display.findIndex((e) => e.turn_index === 1);
  assert.ok(indexOf22 < indexOf21 && indexOf21 < indexOf1);
});

// ---------------------------------------------------------------------------
// Consistency: every direction that renders a transcript uses the SAME
// shared helper, not three direction-specific reimplementations. This is
// what makes "active and completed games use the same newest-first order"
// true by construction -- there is only one reversal function, called at
// render time regardless of game.phase, so a still-live game and a finished
// one are ordered by the identical code path.
// ---------------------------------------------------------------------------

test("all three transcript renderers import and call the ONE shared ordering helper -- no direction-specific reimplementation", () => {
  for (const [name, src] of [
    ["GameClient.tsx (human Setter / AI Racer)", GAME_CLIENT],
    ["RacerClient.tsx (AI Setter / human Racer)", RACER_CLIENT],
    ["HumanClient.tsx (human / human)", HUMAN_CLIENT],
  ] as const) {
    assert.match(src, /from "@\/lib\/gameHistoryOrder"/, `${name} must import the shared helper`);
    assert.match(
      src,
      /completedHistoryForDisplay\(/,
      `${name} must call the shared helper, not reimplement reversal inline`
    );
    assert.doesNotMatch(
      src,
      /\.reverse\(\)/,
      `${name} must not reverse anything directly -- completedHistoryForDisplay is the only reversal`
    );
  }
});

test("RacerClient.tsx: the transcript renders newest-first; the chronological `turns` array is untouched and still drives the last-turn edit-button check", () => {
  assert.match(RACER_CLIENT, /completedHistoryForDisplay\(turns\)\.map\(/);
  // The one other reader of `turns` (deciding which entry may still show the
  // "fix a typo" control) must keep reading the chronological array by name,
  // not a reversed one.
  assert.match(RACER_CLIENT, /entry\.turn_index === turns\[turns\.length - 1\]\?\.turn_index/);
});

test("HumanClient.tsx: the transcript renders newest-first; the server-projected view.turns stays chronological (canonical order), only the render call reverses it", () => {
  assert.match(HUMAN_CLIENT, /completedHistoryForDisplay\(view\.turns\)\.map\(/);
  // Exactly one call site -- view.turns itself is read chronologically
  // everywhere else this component uses it (there is no other consumer here).
  const callSites = (HUMAN_CLIENT.match(/completedHistoryForDisplay\(/g) ?? []).length;
  assert.equal(callSites, 1);
});

// ---------------------------------------------------------------------------
// Stored/log order is untouched. The canonical projection (lib/gameView.ts)
// still maps qa_log in stored, chronological order -- nothing about this
// repair touches persistence, replay, or the API surface, only what three
// client components iterate over when rendering.
// ---------------------------------------------------------------------------

test("lib/gameView.ts: the canonical turns projection stays chronological (stored order), unreversed", () => {
  assert.match(GAME_VIEW, /turns:\s*game\.qa_log\.map\(toViewTurn\)/);
  assert.doesNotMatch(GAME_VIEW, /\.reverse\(\)/);
});

test("lib/gameHistoryOrder.ts remains a generic, import-free reversal -- it cannot reach storage, corpus, replay, or Phase One derivation (unchanged invariant from V2.8.4.2)", () => {
  const src = readFileSync("lib/gameHistoryOrder.ts", "utf8");
  assert.doesNotMatch(src, /^import /m);
  assert.match(src, /export function completedHistoryForDisplay<T>\(turns: readonly T\[\]\): T\[\]/);
});

// ---------------------------------------------------------------------------
// On completion: result precedes the final turn, which precedes earlier
// turns in descending order -- across all three renderers.
// ---------------------------------------------------------------------------

test("GameClient.tsx: on completion, ResultPanel precedes the transcript section (final turn first, earlier turns descending)", () => {
  const resultAt = GAME_CLIENT.indexOf('game.phase === "complete" &&');
  const sectionAt = GAME_CLIENT.indexOf('<section className="flex flex-col gap-4">');
  const historyAt = GAME_CLIENT.indexOf("completedHistoryForDisplay(turns).map");
  assert.ok(resultAt > 0 && sectionAt > resultAt && historyAt > sectionAt);
});

test("RacerClient.tsx: on completion, the result section precedes the transcript section", () => {
  const resultAt = RACER_CLIENT.indexOf('game.phase === "complete" && game.result &&');
  const transcriptSectionAt = RACER_CLIENT.indexOf('<section className="flex flex-col gap-4">');
  const historyAt = RACER_CLIENT.indexOf("completedHistoryForDisplay(turns).map");
  assert.ok(resultAt > 0 && transcriptSectionAt > resultAt && historyAt > transcriptSectionAt);
});

test("HumanClient.tsx: on completion, the outcome block precedes the <ol> transcript", () => {
  const resultAt = HUMAN_CLIENT.indexOf("{over && (");
  const olAt = HUMAN_CLIENT.indexOf('<ol className="flex flex-col gap-2">');
  const historyAt = HUMAN_CLIENT.indexOf("completedHistoryForDisplay(view.turns).map");
  assert.ok(resultAt > 0 && olAt > resultAt && historyAt > olAt);
  // Exactly one {over && (...)} result block remains -- the old, second
  // "outcome" block after the live-controls further down the file is gone,
  // not duplicated.
  const overBlocks = (HUMAN_CLIENT.match(/\{over && \(/g) ?? []).length;
  assert.equal(overBlocks, 1, "the result block must be moved, not duplicated");
});

// ---------------------------------------------------------------------------
// Corrections and private clarification handling are untouched: these are
// GameClient.tsx-only mechanisms, and nothing about their own logic
// (isWithinCorrectionWindow, isSandboxClarificationEntry, the "+1" corridor)
// was touched -- only the array iterated over for RENDERING changed
// visually, not the underlying computation these checks read.
// ---------------------------------------------------------------------------

test("GameClient.tsx: correction and sandbox-clarification logic still read the chronological source (game.qa_log / entry.turn_index), never the reversed display list", () => {
  assert.match(GAME_CLIENT, /isWithinCorrectionWindow\(game\.qa_log, entry\.turn_index\)/);
  assert.match(GAME_CLIENT, /isSandboxClarificationEntry\(pending\)/);
  assert.match(GAME_CLIENT, /isSandboxClarificationEntry\(e\)/);
  // discardCount and questionNumbers both still take the raw record/log, not
  // a display-ordered array.
  assert.match(GAME_CLIENT, /function discardCount\(game: GameRecord, turnIndex: number\)/);
  assert.match(GAME_CLIENT, /const numbers = questionNumbers\(game\.qa_log\)/);
});

// ---------------------------------------------------------------------------
// The mobile reveal fix does more than merely render the result somewhere
// new in the DOM: it actively re-measures geometry and issues its own
// scroll AFTER letting any native (iOS) focus-driven jump settle -- proven
// once, directly, against the ONE shared hook all three screens call (see
// test/resultAutoReveal.test.ts for the hook's own full assertion set). This
// is what makes reveal reliable regardless of where the result sits in the
// DOM, which is why moving it earlier in source order (V2.8.7.3's first
// pass) could never have been sufficient on its own.
// ---------------------------------------------------------------------------

test("app/components/useResultReveal.ts: is an ACTIVE post-layout mechanism, not passive DOM placement", () => {
  const src = readFileSync("app/components/useResultReveal.ts", "utf8");
  assert.match(src, /requestAnimationFrame\(\(\) => \{\s*innerFrame = requestAnimationFrame\(\(\) => \{/, "must wait for post-focus/post-layout settling before measuring");
  assert.match(src, /heading\.getBoundingClientRect\(\)\.top/, "must re-measure the heading's live position, not assume one");
  assert.match(src, /window\.scrollY/, "must read the CURRENT scroll position at measurement time, not a stale one");
  assert.match(src, /window\.scrollTo\(\{\s*top: targetTop,\s*behavior: "smooth"\s*\}\)/, "must issue its own authoritative scroll as the final action");
});

// ---------------------------------------------------------------------------
// The completion requirement was explicitly "moving the result before the
// transcript is insufficient": every one of the three screens must ALSO
// call the reveal mechanism, not merely benefit from DOM order.
// ---------------------------------------------------------------------------

test("all three player-facing game screens call the ONE shared reveal hook -- no screen relies on DOM order alone, and none reimplements the mechanism independently", () => {
  for (const [name, src] of [
    ["GameClient.tsx (human Setter / AI Racer)", GAME_CLIENT],
    ["RacerClient.tsx (AI Setter / human Racer)", RACER_CLIENT],
    ["HumanClient.tsx (human / human)", HUMAN_CLIENT],
  ] as const) {
    assert.match(src, /from "@\/app\/components\/useResultReveal"/, `${name} must import the shared hook`);
    assert.match(src, /useResultReveal\(/, `${name} must call the shared hook`);
    assert.match(src, /ref=\{headerRef\}/, `${name} must attach headerRef to its own <header>`);
    // No screen may reimplement the mechanism inline instead of (or beside)
    // calling the shared hook.
    assert.doesNotMatch(src, /requestAnimationFrame/, `${name} must not reimplement the reveal mechanism inline`);
  }
});

test("RacerClient.tsx: the result heading is wired as a programmatic focus target (ref, tabIndex, no visible ring), matching ResultPanel.tsx's own established pattern", () => {
  const heading = RACER_CLIENT.slice(RACER_CLIENT.indexOf("<h2"), RACER_CLIENT.indexOf("</h2>"));
  assert.match(heading, /ref=\{resultHeadingRef\}/);
  assert.match(heading, /tabIndex=\{-1\}/, "not in the Tab order -- only useResultReveal's effect ever focuses it");
  assert.match(heading, /outline-none/, "no visible input-style focus ring on a heading that accepts no input");
  // Unconditional on which outcome produced it: RESULT_HEADLINE covers a
  // correct AI guess (Eltaláltad.), an incorrect one (Nem talált.), a
  // concession (Feladtad.), and an adjudicated verdict (Neked ítélve).
  assert.match(RACER_CLIENT, /racer_correct: "Eltaláltad\."/);
  assert.match(RACER_CLIENT, /racer_incorrect: "Nem talált\."/);
  assert.match(RACER_CLIENT, /composer_win_integrity_upheld: "Feladtad\."/);
  assert.match(RACER_CLIENT, /racer_win_integrity_violation: "Neked ítélve/);
});

test("HumanClient.tsx: the result headline is an <h2> (not a plain <div>) wired as a programmatic focus target, reached by every outcome via resultCopy regardless of which player is reading it", () => {
  const heading = HUMAN_CLIENT.slice(HUMAN_CLIENT.indexOf("<h2"), HUMAN_CLIENT.indexOf("</h2>"));
  assert.match(heading, /ref=\{resultHeadingRef\}/);
  assert.match(heading, /tabIndex=\{-1\}/);
  assert.match(heading, /outline-none/);
  assert.match(heading, /\{outcome\.headline\}/, "unconditional on outcome.won -- correct/incorrect/concession/adjudicated all reach this same element");
  // The hook is fed view.phase, the server-projected phase this screen
  // already treats as authoritative everywhere else.
  assert.match(HUMAN_CLIENT, /useResultReveal\(view\.phase as GamePhase\)/);
});

test("GameClient.tsx: ResultPanel.tsx's heading (rendered via the shared ResultPanel component, not inline) carries the identical ref/tabIndex/outline-none wiring", () => {
  const heading = RESULT_PANEL.slice(RESULT_PANEL.indexOf("<h2"), RESULT_PANEL.indexOf("</h2>"));
  assert.match(heading, /ref=\{headingRef\}/);
  assert.match(heading, /tabIndex=\{-1\}/);
  assert.match(heading, /outline-none/);
});

// ---------------------------------------------------------------------------
// Newest-first must apply during ACTIVE play too, not only to a completed
// game's history -- i.e. the ordering call sites must not be gated behind a
// phase==="complete"/over check. (An unanswered question on RacerClient/
// HumanClient, or an in-progress GameClient game, must show its own most
// recent turn first exactly the same way a finished game does.)
// ---------------------------------------------------------------------------

test("RacerClient.tsx / HumanClient.tsx: the newest-first render call is unconditional on completion -- it renders the SAME way during active play, on a completed game, and on a game reopened from History", () => {
  // RacerClient: the ordering call sits inside the always-rendered
  // transcript <section>, never behind `live` or `game.phase === "complete"`.
  const racerMapAt = RACER_CLIENT.indexOf("completedHistoryForDisplay(turns).map(");
  const racerSectionAt = RACER_CLIENT.lastIndexOf('<section className="flex flex-col gap-4">', racerMapAt);
  assert.ok(racerSectionAt > 0 && racerMapAt > racerSectionAt);
  const racerGuard = RACER_CLIENT.slice(racerSectionAt, racerMapAt);
  assert.doesNotMatch(racerGuard, /\{live &&/, "the ordering itself must not be gated on `live`");
  assert.doesNotMatch(racerGuard, /game\.phase === "complete" &&\s*$/, "must not be gated on completion either");

  // HumanClient: the <ol> transcript is unconditional -- no `{over && (...)}`
  // or `{live && (...)}` wraps the list itself (only the surrounding action
  // panels are phase-gated).
  const olAt = HUMAN_CLIENT.indexOf('<ol className="flex flex-col gap-2">');
  assert.ok(olAt > 0);
  assert.doesNotMatch(HUMAN_CLIENT.slice(0, olAt).slice(-40), /\{(over|live) &&/);
});
