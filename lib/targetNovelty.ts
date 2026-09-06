// ---------------------------------------------------------------------------
// V2.8.8 — per-player AI-generated target novelty.
//
// Field problem: the AI Setter repeatedly chose "dog." This module is the
// MECHANICAL half of the fix — a deterministic, exact-repeat guard.
//
// Pure — no React, no DOM, no model call, no import of lib/secretStore.ts.
// ---------------------------------------------------------------------------

import { normalizeForConservativeIdentityMatch } from "./textIdentity";

/**
 * V2.8.8.1 — this is now a thin re-export of lib/textIdentity.ts's shared
 * conservative identity normalizer (extracted there once a second,
 * independent call site needed the identical algorithm — see
 * lib/exactGuessMatch.ts). The exported NAME stays exactly as it was so
 * every existing caller and test (this module's own, and
 * test/targetNovelty.test.ts) continues to compile and pass unchanged; only
 * the implementation is now sourced from one shared place instead of two
 * copies that could drift.
 *
 * STILL NEVER catches: a translation ("dog"/"kutya"), a synonym, or any
 * other semantic equivalence — those remain model-enforced only, exactly as
 * disclosed in lib/prompts/composerTarget.ts's own EXCLUDED TARGETS
 * instruction and its avoided_recent_targets schema field.
 */
export const normalizeTargetForNoveltyCheck = normalizeForConservativeIdentityMatch;

/**
 * True only if `candidate` exactly matches (after normalization) one of
 * `priorTargets`. A near-duplicate, a translation, or a singular/plural
 * variant must NOT match here — that is the model's own job, not this
 * function's.
 */
export function isExactNormalizedRepeat(
  candidate: string,
  priorTargets: readonly string[]
): boolean {
  const normalizedCandidate = normalizeTargetForNoveltyCheck(candidate);
  return priorTargets.some(
    (prior) => normalizeTargetForNoveltyCheck(prior) === normalizedCandidate
  );
}

/** The rolling window size decision #4 specifies: the latest 15 revealed AI-Setter targets. */
export const RECENT_AI_TARGET_LIMIT = 15;

/** At most one retry (two attempts total) before failing explicitly -- no fixed fallback. */
export const MAX_TARGET_NOVELTY_ATTEMPTS = 2;
