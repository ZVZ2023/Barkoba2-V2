import { normalizeForConservativeIdentityMatch } from "./textIdentity";

// ---------------------------------------------------------------------------
// V2.8.8.1 — the conservative exact-match fast path's own decision function.
//
// Reuses lib/textIdentity.ts's shared conservative normalizer (Unicode NFKD,
// diacritic removal, case folding, punctuation removal, whitespace
// collapse) — the SAME algorithm lib/targetNovelty.ts already uses for a
// structurally identical problem ("is this the same string, typed
// differently"). Extracted there for exactly this reuse, rather than a
// second hand-copied normalizer that could quietly drift from it.
//
// PURE — no I/O, no model call. app/api/game/[id]/resolve/route.ts calls
// this BEFORE spending an Adjudicator call; when it returns true, the
// verdict is set directly and the Adjudicator is never invoked at all for
// that guess.
//
// WHAT THIS DOES AND DOES NOT DECIDE. True means "the guess and the target
// are, beyond reasonable doubt, the identical referent typed differently" —
// exactly what the normalizer's own contract promises (see its doc). It is
// NEVER true for a synonym, a translation, or a broader/narrower concept:
// "television remote control" vs "Távirányító" is a real, everyday case
// this function must return false for, and does — those remain the
// Adjudicator's job, unchanged.
// ---------------------------------------------------------------------------

export function isExactGuessMatch(guess: string, target: string): boolean {
  const normalizedGuess = normalizeForConservativeIdentityMatch(guess);
  const normalizedTarget = normalizeForConservativeIdentityMatch(target);
  // An empty guess or target must never "match" merely because both
  // normalize to "" — there is nothing to be conservatively identical to.
  if (!normalizedGuess || !normalizedTarget) return false;
  return normalizedGuess === normalizedTarget;
}
