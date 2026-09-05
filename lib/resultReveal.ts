import type { GamePhase } from "./types";

// ---------------------------------------------------------------------------
// V2.8.7.2 — auto-reveal the terminal result.
//
// Pure, no React, no DOM — same reason lib/turnRecovery.ts and
// lib/thinkingIndicator.ts are pure: this project has no jsdom/testing-library
// dependency, so the actual decision and arithmetic live here, directly
// tested, and the React component (GameClient.tsx) is a thin, directly-
// reviewed wrapper that calls these against the real DOM and a real clock.
//
// FIELD REQUIREMENT: once a game reaches a terminal result (a correct guess,
// an incorrect guess, a concession, or an adjudication verdict — every case
// collapses to game.phase becoming "complete" with game.result set, per
// lib/resolveResult.ts), the player must never have to scroll to discover it.
// Before this, the result card rendered in place and relied entirely on
// whatever the player's scroll position already was.
// ---------------------------------------------------------------------------

export interface RevealTransitionCheck {
  previousPhase: GamePhase;
  phase: GamePhase;
}

/**
 * True exactly once: the instant the game transitions INTO "complete" from
 * something else. Never true while already complete (so a re-render for an
 * unrelated reason — a resolve retry's error clearing, for instance — does
 * not re-trigger the scroll and steal focus back from a player who has since
 * scrolled away or started interacting with the page), and never true before
 * resolution (satisfying "do not disturb normal scrolling before
 * resolution").
 */
export function shouldRevealResult(check: RevealTransitionCheck): boolean {
  return check.previousPhase !== "complete" && check.phase === "complete";
}

export interface RevealScrollInput {
  /** The result heading's `getBoundingClientRect().top` — viewport-relative. */
  targetTop: number;
  /** `window.scrollY` at the moment of the check. */
  currentScrollY: number;
  /**
   * The rendered height of whatever occupies the top of the viewport (this
   * screen's own header, `getBoundingClientRect().height`, 0 if unmeasured).
   * Correct whether that header is in-flow or fixed/sticky: either way, the
   * result must not land underneath it.
   */
  headerHeight: number;
  /** Breathing room below the header before the heading starts. Defaults to 12px. */
  marginPx?: number;
}

/**
 * The absolute page `scrollTop` that puts the result heading just below the
 * header, with `marginPx` of breathing room — never negative (there is
 * nothing above the very top of the page to scroll past).
 */
export function computeRevealScrollTop(input: RevealScrollInput): number {
  const margin = input.marginPx ?? 12;
  return Math.max(0, input.currentScrollY + input.targetTop - input.headerHeight - margin);
}
