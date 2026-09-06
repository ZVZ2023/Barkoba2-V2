import { normalizeQuestionForDuplicateCheck } from "./duplicateQuestionGuard";

// ---------------------------------------------------------------------------
// V2.8.8 — per-player AI-generated target novelty.
//
// Field problem: the AI Setter repeatedly chose "dog." This module is the
// MECHANICAL half of the fix — a deterministic, exact-repeat guard, exactly
// as narrow as lib/duplicateQuestionGuard.ts's own exact-duplicate-question
// guard, and for the identical reason: near-duplicate/semantic/cross-
// language detection ("dog" vs "kutya", singular/plural, an obvious
// translation) is NOT reliably expressible as a deterministic rule and is
// therefore left to the model's own instructed judgment (see
// lib/prompts/composerTarget.ts's exclusion list in the prompt, and its
// avoided_recent_targets schema field) — reported HONESTLY here as
// model-enforced, not mechanically guaranteed, rather than silently
// claiming a stronger guarantee than this file actually provides.
//
// Pure — no React, no DOM, no model call, no import of lib/secretStore.ts.
// Reuses lib/duplicateQuestionGuard.ts's own normalization (lowercase, trim,
// whitespace-collapse ONLY — diacritics and every other character preserved
// exactly, per that module's own established, deliberate reasoning) rather
// than inventing a second normalization philosophy for a structurally
// identical problem ("was this exact thing already used").
// ---------------------------------------------------------------------------

export { normalizeQuestionForDuplicateCheck as normalizeTargetForNoveltyCheck };

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
  const normalizedCandidate = normalizeQuestionForDuplicateCheck(candidate);
  return priorTargets.some(
    (prior) => normalizeQuestionForDuplicateCheck(prior) === normalizedCandidate
  );
}

/** The rolling window size decision #4 specifies: the latest 15 revealed AI-Setter targets. */
export const RECENT_AI_TARGET_LIMIT = 15;

/** At most one retry (two attempts total) before failing explicitly -- no fixed fallback. */
export const MAX_TARGET_NOVELTY_ATTEMPTS = 2;
