import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.8.7.2 — two independent field-driven changes, both source-contract
// tested: no rendering harness exists in this codebase for React components
// (see test/resultScreenProfileLeak.test.ts's own doc), so this proves the
// wiring from source, exactly like composerAuthority.test.ts and
// guessCheckpoint.test.ts already do. The DECISION logic behind the second
// change (when to reveal, where to scroll) is pure and directly executed in
// test/resultReveal.test.ts — this file only proves GameClient.tsx and
// ResultPanel.tsx actually call it.
// ---------------------------------------------------------------------------

const COMPOSER_ENTRY = readFileSync("app/ComposerEntry.tsx", "utf8");
const GAME_CLIENT = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
const RESULT_PANEL = readFileSync("app/game/[id]/ResultPanel.tsx", "utf8");
const USE_RESULT_REVEAL = readFileSync("app/components/useResultReveal.ts", "utf8");

// ---------------------------------------------------------------------------
// 1. The obsolete startup copy above the target field is gone; the heading
//    and everything unrelated (entitlement logic, developer access, question
//    limits, game configuration) stays exactly as it was.
// ---------------------------------------------------------------------------

test("ComposerEntry.tsx: the obsolete intro paragraph and developer-access status badge are removed from above the target field", () => {
  assert.doesNotMatch(
    COMPOSER_ENTRY,
    /Gondolj valamire, és rögzítsd/,
    "the old explanatory paragraph must be gone"
  );
  assert.doesNotMatch(
    COMPOSER_ENTRY,
    /teljesen vakon indul/,
    "the old explanatory paragraph must be gone"
  );
  assert.doesNotMatch(
    COMPOSER_ENTRY,
    /<BalanceBadge/,
    "the balance/developer-access status badge must not render above the target field"
  );
  assert.doesNotMatch(
    COMPOSER_ENTRY,
    /\bBalanceBadge\b/,
    "BalanceBadge must not even be imported once its only use here is removed"
  );
});

test("ComposerEntry.tsx: the existing heading is sufficient and unchanged", () => {
  assert.match(
    COMPOSER_ENTRY,
    /role="Te gondolsz valamire\. A Barkóba AI fogja kitalálni\."/,
    "the existing heading must still be exactly this text"
  );
});

test("ComposerEntry.tsx: entitlement logic, developer access, question limits, and game configuration are untouched", () => {
  // The credit-exhausted flow (CreditGateway on the error step) is unchanged.
  assert.match(COMPOSER_ENTRY, /noCredit && entitlement\.view\?\.play_state === "exhausted"/);
  assert.match(COMPOSER_ENTRY, /<CreditGateway \/>/);
  assert.match(COMPOSER_ENTRY, /useEntitlement\(\)/);
  // Difficulty / question-budget configuration is unchanged.
  assert.match(COMPOSER_ENTRY, /<BudgetPicker/);
  assert.match(COMPOSER_ENTRY, /difficulty=\{difficulty\}/);
  assert.match(COMPOSER_ENTRY, /max_questions: pickedBudget\(difficulty, budgetOverride\)/);
  // The server-authoritative public provider is unchanged (still no client
  // -chosen opponent field sent).
  assert.doesNotMatch(COMPOSER_ENTRY, /racer_provider/);
});

// ---------------------------------------------------------------------------
// 2. Auto-reveal: the terminal result moves into view and takes focus,
//    without the player ever needing to scroll to discover it.
//
//    V2.8.7.4 — the reveal mechanism itself now lives in ONE shared hook,
//    app/components/useResultReveal.ts, called by all three player-facing
//    game screens (GameClient.tsx, RacerClient.tsx, HumanClient.tsx). See
//    test/mobileRevealTranscriptOrder.test.ts for the cross-client
//    consistency proof (all three call the hook, none reimplement it) and
//    the cleanup/cancellation proof; this file keeps the GameClient.tsx-
//    specific wiring checks (it is the hook's original caller and still
//    hands the SAME ref through to ResultPanel).
// ---------------------------------------------------------------------------

test("app/components/useResultReveal.ts: calls focus() FIRST, then measures/scrolls -- the iOS fix (see test/resultReveal.test.ts for why the old order failed on iPhone)", () => {
  assert.match(USE_RESULT_REVEAL, /from "@\/lib\/resultReveal"/, "must reuse the pure, tested decision/arithmetic — not reimplement it inline");
  assert.match(USE_RESULT_REVEAL, /shouldRevealResult\(\{\s*previousPhase: previousPhaseRef\.current,\s*phase\s*\}\)/);
  assert.match(USE_RESULT_REVEAL, /previousPhaseRef\.current = phase/, "the ref must be updated on every check, or the transition could re-fire");
  assert.match(USE_RESULT_REVEAL, /computeRevealScrollTop\(\{/);
  assert.match(USE_RESULT_REVEAL, /window\.scrollTo\(\{\s*top: targetTop,\s*behavior: "smooth"\s*\}\)/);
  assert.match(USE_RESULT_REVEAL, /heading\.focus\(\{\s*preventScroll: true\s*\}\)/);
  // Ordering, not just presence: focus() must appear BEFORE window.scrollTo
  // in source -- the reverse of the original V2.8.7.2 order, which iOS
  // Safari silently overrode.
  const focusAt = USE_RESULT_REVEAL.indexOf("heading.focus({ preventScroll: true });");
  const scrollAt = USE_RESULT_REVEAL.indexOf("window.scrollTo({");
  assert.ok(focusAt > 0 && scrollAt > focusAt, "focus() must precede window.scrollTo(), not follow it");
  // A post-layout wait sits between them -- the mechanism that makes the
  // final scroll win regardless of what focus()'s own native jump did.
  const between = USE_RESULT_REVEAL.slice(focusAt, scrollAt);
  assert.match(between, /requestAnimationFrame\(\(\) => \{\s*innerFrame = requestAnimationFrame\(\(\) => \{/);
});

test("app/components/useResultReveal.ts: cancels both pending animation frames on cleanup/unmount -- a stale callback must never measure or scroll after the screen moves on", () => {
  assert.match(USE_RESULT_REVEAL, /let outerFrame = 0;/);
  assert.match(USE_RESULT_REVEAL, /let innerFrame = 0;/);
  assert.match(USE_RESULT_REVEAL, /return \(\) => \{\s*cancelAnimationFrame\(outerFrame\);\s*cancelAnimationFrame\(innerFrame\);\s*\};/);
});

test("app/components/useResultReveal.ts: measures the header directly (headerRef), not a fixed size, and owns both refs it needs", () => {
  assert.match(USE_RESULT_REVEAL, /const headerRef = useRef<HTMLElement>\(null\)/);
  assert.match(USE_RESULT_REVEAL, /const headingRef = useRef<HTMLHeadingElement>\(null\)/);
  assert.match(USE_RESULT_REVEAL, /headerRef\.current\?\.getBoundingClientRect\(\)\.height/);
  assert.match(USE_RESULT_REVEAL, /return \{ headerRef, headingRef \};/);
});

test("app/components/useResultReveal.ts: the effect only depends on phase -- it must not re-fire for an unrelated re-render (e.g. a resolve-retry error clearing)", () => {
  const effectStart = USE_RESULT_REVEAL.indexOf("shouldRevealResult({");
  assert.ok(effectStart > 0);
  const effectRegion = USE_RESULT_REVEAL.slice(Math.max(0, effectStart - 200), effectStart + 1400);
  assert.match(effectRegion, /\}, \[phase\]\);/);
});

test("GameClient.tsx: calls the shared hook and hands the SAME heading ref through to ResultPanel that the hook scrolls to and focuses", () => {
  assert.match(GAME_CLIENT, /from "@\/app\/components\/useResultReveal"/);
  assert.match(GAME_CLIENT, /const \{ headerRef, headingRef: resultHeadingRef \} = useResultReveal\(game\.phase\)/);
  assert.match(GAME_CLIENT, /ref=\{headerRef\}/, "the header must be measured, not assumed");
  const resultRender = GAME_CLIENT.slice(
    GAME_CLIENT.indexOf('game.phase === "complete" &&'),
    GAME_CLIENT.indexOf('game.phase === "complete" &&') + 400
  );
  assert.match(resultRender, /<ResultPanel/);
  assert.match(resultRender, /headingRef=\{resultHeadingRef\}/);
  // GameClient.tsx must not reimplement any of the reveal mechanism inline
  // now that it lives in the shared hook.
  assert.doesNotMatch(GAME_CLIENT, /requestAnimationFrame/);
  assert.doesNotMatch(GAME_CLIENT, /computeRevealScrollTop/);
});

test("ResultPanel.tsx: the result heading is a valid, ring-free PROGRAMMATIC focus target, for every terminal outcome equally", () => {
  assert.match(RESULT_PANEL, /headingRef\?: RefObject<HTMLHeadingElement>/);
  const heading = RESULT_PANEL.slice(RESULT_PANEL.indexOf("<h2"), RESULT_PANEL.indexOf("</h2>"));
  assert.match(heading, /ref=\{headingRef\}/);
  assert.match(heading, /tabIndex=\{-1\}/, "not in the Tab order -- only the auto-reveal effect ever focuses it");
  assert.match(heading, /outline-none/, "no visible input-style focus ring on a heading that accepts no input");
  // The heading text is unconditional on which outcome produced it -- both a
  // correct and an incorrect AI guess reach this exact element.
  assert.match(heading, /HEADLINE\[game\.result\]/);
});

test("ResultPanel.tsx: HEADLINE covers a correct AI guess and an incorrect one, both reaching the same focus-ready heading", () => {
  assert.match(RESULT_PANEL, /racer_correct: "Az AI eltalálta\."/, "the AI's guess was correct");
  assert.match(RESULT_PANEL, /racer_incorrect: "Az AI nem talált\. Nyertél\."/, "the AI's guess was incorrect");
  // Neither result value gates the heading's ref/tabIndex/outline-none wiring
  // above -- confirmed once here rather than duplicated per outcome, since
  // the wiring itself never reads game.result.
});

test("ResultPanel.tsx: V2.8.7.3 -- the result now renders BEFORE the transcript section, not after it (the old V2.8.7.2 behavior)", () => {
  const resultBlock = GAME_CLIENT.indexOf('game.phase === "complete" &&');
  const transcriptSectionOpen = GAME_CLIENT.indexOf('<section className="flex flex-col gap-4">');
  const historyCall = GAME_CLIENT.indexOf("completedHistoryForDisplay(turns).map");
  assert.ok(resultBlock > 0 && transcriptSectionOpen > resultBlock && historyCall > transcriptSectionOpen);
});
