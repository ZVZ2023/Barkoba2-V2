// ---------------------------------------------------------------------------
// V2.8.8 — per-player AI-generated target novelty.
//
// Field problem: the AI Setter repeatedly chose "dog." This module is the
// MECHANICAL half of the fix — a deterministic, exact-repeat guard.
//
// Pure — no React, no DOM, no model call, no import of lib/secretStore.ts.
// ---------------------------------------------------------------------------

/**
 * V2.8.8 COMPLETION — target-specific normalization, deliberately STRONGER
 * than lib/duplicateQuestionGuard.ts's own normalizeQuestionForDuplicateCheck
 * (which stays exactly as it was — lowercase/trim/whitespace-collapse only,
 * diacritics preserved — for QUESTION-text duplicate detection, where a
 * different accented word can be a genuinely different question). A secret
 * TARGET is a different problem: the approved requirement is that a trivial
 * FORMATTING variant of the identical target ("Dog" vs "dog.") must collide
 * mechanically, not merely an identical byte string.
 *
 * Handles, in this order:
 *   1. Unicode normalization (NFKD) — decomposes an accented character into
 *      its base letter plus a separate combining mark, e.g. "á" -> "a" +
 *      U+0301.
 *   2. Diacritic/combining-mark removal — strips the marks NFKD just split
 *      off (U+0300-U+036F, the Combining Diacritical Marks block covers
 *      Hungarian's "ő"/"ű" too), so "kávé"/"kave" and "őz"/"oz" collide.
 *   3. Case folding (toLowerCase).
 *   4. Punctuation removal — a trailing period, an exclamation mark, etc.
 *      no longer defeats the match.
 *   5. Whitespace collapse — leading, trailing, and repeated internal
 *      whitespace.
 *
 * STILL NEVER catches: a translation ("dog"/"kutya"), a synonym, or any
 * other semantic equivalence — those remain model-enforced only, exactly as
 * disclosed in lib/prompts/composerTarget.ts's own EXCLUDED TARGETS
 * instruction and its avoided_recent_targets schema field. This function's
 * only job is to make a trivial FORMATTING variant of the SAME string
 * collide; it has no notion of meaning.
 */
export function normalizeTargetForNoveltyCheck(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
