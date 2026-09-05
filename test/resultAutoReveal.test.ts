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
// ---------------------------------------------------------------------------

test("GameClient.tsx: the auto-reveal effect measures the header, computes the scroll target via lib/resultReveal.ts, and moves focus without stealing scroll from the in-flight smooth scroll", () => {
  assert.match(GAME_CLIENT, /from "@\/lib\/resultReveal"/, "must reuse the pure, tested decision/arithmetic — not reimplement it inline");
  assert.match(GAME_CLIENT, /shouldRevealResult\(\{\s*previousPhase: previousPhaseRef\.current,\s*phase: game\.phase\s*\}\)/);
  assert.match(GAME_CLIENT, /previousPhaseRef\.current = game\.phase/, "the ref must be updated on every check, or the transition could re-fire");
  assert.match(GAME_CLIENT, /computeRevealScrollTop\(\{/);
  assert.match(GAME_CLIENT, /window\.scrollTo\(\{\s*top: targetTop,\s*behavior: "smooth"\s*\}\)/);
  assert.match(GAME_CLIENT, /heading\.focus\(\{\s*preventScroll: true\s*\}\)/, "focus must not fight the smooth scroll already in flight");
});

test("GameClient.tsx: the header is measured directly (headerRef), not assumed to be a fixed size", () => {
  assert.match(GAME_CLIENT, /const headerRef = useRef<HTMLElement>\(null\)/);
  assert.match(GAME_CLIENT, /ref=\{headerRef\}/);
  assert.match(GAME_CLIENT, /headerRef\.current\?\.getBoundingClientRect\(\)\.height/);
});

test("GameClient.tsx: the SAME heading ref is handed to ResultPanel that the effect scrolls to and focuses", () => {
  assert.match(GAME_CLIENT, /const resultHeadingRef = useRef<HTMLHeadingElement>\(null\)/);
  const resultRender = GAME_CLIENT.slice(
    GAME_CLIENT.indexOf('game.phase === "complete" &&'),
    GAME_CLIENT.indexOf('game.phase === "complete" &&') + 400
  );
  assert.match(resultRender, /<ResultPanel/);
  assert.match(resultRender, /headingRef=\{resultHeadingRef\}/);
});

test("GameClient.tsx: the auto-reveal effect only depends on game.phase -- it must not re-fire for an unrelated re-render (e.g. a resolve-retry error clearing)", () => {
  const effectStart = GAME_CLIENT.indexOf("shouldRevealResult({");
  assert.ok(effectStart > 0);
  const effectRegion = GAME_CLIENT.slice(Math.max(0, effectStart - 400), effectStart + 900);
  assert.match(effectRegion, /\}, \[game\.phase\]\);/);
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

test("ResultPanel.tsx: the result is still rendered directly after the transcript, not moved somewhere the auto-reveal effect has to compensate for", () => {
  const transcriptClose = GAME_CLIENT.indexOf("))}\n      </section>");
  const resolvingBlock = GAME_CLIENT.indexOf('game.phase === "resolving" && !guessRevealPending');
  const resultBlock = GAME_CLIENT.indexOf('game.phase === "complete" &&');
  assert.ok(transcriptClose > 0 && resolvingBlock > transcriptClose && resultBlock > resolvingBlock);
  // Nothing else sits between the transcript's own closing tag and these two
  // phase-gated panels.
  const between = GAME_CLIENT.slice(transcriptClose, resultBlock);
  assert.doesNotMatch(between, /<section|<ResultPanel|<EvaluationState[^>]*\/>\s*\)\s*\}\s*\n\s*\n\s*\{[a-zA-Z]/);
});
