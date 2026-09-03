// ---------------------------------------------------------------------------
// V2.8.4.2 — DESCENDING COMPLETED-QUESTION HISTORY.
//
// Pure, no React, no I/O — the same reason lib/rewind.ts and lib/phaseOne.ts
// are pure: the one thing this module does (reverse a list for DISPLAY only)
// is trivial to get subtly wrong (reversing the wrong array, mutating the
// source, dropping or duplicating an entry), so it is unit-tested directly
// rather than implied by JSX no test harness in this project can render.
//
// SCOPE: this reorders ONLY the rendered completed-history list. It must
// never be given, and never touch, the stored qa_log itself, corpus order,
// replay input, or Phase One's own derivation — every one of those stays in
// chronological (stored) order. See app/game/[id]/GameClient.tsx: `turns`
// (chronological, the source of truth for length/emptiness checks and every
// other computation) and `completedHistoryForDisplay(turns)` (this
// function's output, used ONLY inside the .map() that renders the list) are
// deliberately two different values, not two names for the same array.
// ---------------------------------------------------------------------------

/**
 * A NEW array, newest-first, for display only. Never mutates `turns`.
 * Contains exactly the same entries as `turns`, once each — a reversal
 * cannot duplicate or omit anything it did not already have.
 */
export function completedHistoryForDisplay<T>(turns: readonly T[]): T[] {
  return [...turns].reverse();
}
