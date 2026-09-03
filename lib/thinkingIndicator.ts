import type { GameLanguage } from "./types";

// ---------------------------------------------------------------------------
// V2.8.4.1 — three-stage AI-activity indicator: elapsed-time -> stage, and
// stage -> status copy. Pure, no React, no timers, no DOM — the same reason
// lib/turnRecovery.ts and lib/turnRequestGuard.ts are pure: this project has
// no jsdom/testing-library dependency, so the actual decision logic (which
// stage a given elapsed duration is in, and what it says) is extracted here
// where it can be exercised directly with synthetic elapsed values in place
// of real timers. app/components/ThinkingIndicator.tsx calls this SAME
// function against a real Date.now()/setInterval; test/thinkingIndicator.test.ts
// drives it with fixed millisecond inputs standing in for fake timers.
//
// TRUTHFULNESS BY CONSTRUCTION: this module has no concept of "done" or
// "failed" — it only ever answers "given this many elapsed milliseconds,
// which stage and which words." Starting and stopping the clock is entirely
// the caller's job (mount/render only while genuinely waiting; stop
// rendering the instant canonical progress, success, or failure arrives), so
// there is no separate "is it still going" state here to drift out of sync.
// ---------------------------------------------------------------------------

export type ThinkingStage = "eager" | "focused" | "deep";

/** Stage boundaries in milliseconds. Stage 3 has no upper bound -- it holds
 * until the caller stops rendering the indicator (success, timeout, or
 * failure), never on a fixed clock of its own. */
export const THINKING_STAGE_BOUNDARIES_MS: { readonly focused: number; readonly deep: number } = {
  focused: 20_000,
  deep: 40_000,
};

export function stageForElapsedMs(elapsedMs: number): ThinkingStage {
  if (elapsedMs >= THINKING_STAGE_BOUNDARIES_MS.deep) return "deep";
  if (elapsedMs >= THINKING_STAGE_BOUNDARIES_MS.focused) return "focused";
  return "eager";
}

/**
 * Visible status copy per stage. The shell this ships in today (see
 * app/game/[id]/GameClient.tsx) is unconditionally Hungarian regardless of
 * game_language -- the same "shell language is not game language" rule the
 * V2.8.4 language-gate correction established -- so only "hu" is actually
 * wired up today. "en" exists so the component is not shell-locked if an
 * English shell is ever built, and so both languages are exercised by tests.
 */
export const THINKING_STAGE_COPY: Record<GameLanguage, Record<ThinkingStage, string>> = {
  en: {
    eager: "Barkóba AI is thinking…",
    focused: "This one needs a closer look…",
    deep: "Still working—your game is safe.",
  },
  hu: {
    eager: "Barkóba AI gondolkodik…",
    focused: "Ez most alaposabb átgondolást igényel…",
    deep: "Még mindig dolgozik — a játékod biztonságban van.",
  },
};

export function thinkingStatusText(language: GameLanguage, elapsedMs: number): string {
  return THINKING_STAGE_COPY[language][stageForElapsedMs(elapsedMs)];
}
