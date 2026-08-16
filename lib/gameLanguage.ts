import type { GameLanguage } from "./types";

// ---------------------------------------------------------------------------
// V2.5 — which language a game is PLAYED in.
//
// Pure, no I/O — the same reason lib/rewind.ts and lib/turnRecovery.ts are
// pure. The resolution rule is the whole feature, so it is executed in tests
// rather than inferred from a route nobody can run.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS REPLACES
// ---------------------------------------------------------------------------
//
// Game language was HARDCODED to "hu" at all three creation sites. Not derived
// from anything — there was no mechanism. An English game inside the Hungarian
// shell was impossible, and the Racer was explicitly instructed to write
// Hungarian regardless of what the Composer had typed.
//
// That was a deliberate over-correction. An earlier build inferred the language
// from the Composer's words alone, so an English target produced an entirely
// English game inside a Hungarian product, and the fix pinned the game to the
// interface. Both versions made the same mistake in opposite directions: they
// treated shell language and game language as one setting.
//
// THEY ARE SEPARATE. The Hungarian shell may host a Hungarian or an English
// game. This module decides only the second; there is no i18n layer and none is
// planned — the buttons stay Hungarian either way.
//
// ---------------------------------------------------------------------------
// WHY DETECTION ALONE IS NOT ENOUGH
// ---------------------------------------------------------------------------
//
// The Validator already reports the dominant language of the Composer's
// submission, and that result was computed on every game and then discarded.
// Reviving it is most of the fix — but not all of it, because a target can be
// linguistically ambiguous in a way no detector can resolve:
//
//     Grok · Apple · Tesla · Air
//
// A one-word target says nothing about which language the human meant to play
// in. So detection is the AUTO behaviour, not the only behaviour: an explicit
// choice always outranks it. That is what the three-state control exists for.
// ---------------------------------------------------------------------------

/** What the client may ask for. "auto" means "decide for me". */
export type LanguageChoice = "auto" | GameLanguage;

export function isGameLanguage(value: unknown): value is GameLanguage {
  return value === "hu" || value === "en";
}

/**
 * Normalize whatever arrived in the request body.
 *
 * Anything unrecognised becomes "auto" rather than an error or a guess. A
 * malformed language is not a reason to refuse to start a game, and it must
 * never become game state — the record would then claim a language nobody
 * chose and no detector reported.
 */
export function normalizeLanguageChoice(requested: unknown): LanguageChoice {
  return isGameLanguage(requested) ? requested : "auto";
}

/**
 * THE RULE. One function, both creation paths.
 *
 *   1. An explicit "hu" or "en" wins outright.
 *   2. Otherwise a valid detected language is used.
 *   3. Otherwise "hu" — today's behaviour, so nothing regresses.
 *
 * `detected` is null on the AI-Composer path, where there is no human text to
 * detect from: the AI chooses the target only AFTER the language is fixed. That
 * asymmetry is inherent, not a gap, and passing null lets AUTO collapse to "hu"
 * through the same rule instead of needing a second one.
 *
 * @param requested what the client asked for; anything invalid is ignored
 * @param detected  the Validator's reading, or null when none was possible
 */
export function resolveGameLanguage(requested: unknown, detected: unknown): GameLanguage {
  const choice = normalizeLanguageChoice(requested);
  if (choice !== "auto") return choice;
  if (isGameLanguage(detected)) return detected;
  return "hu";
}
