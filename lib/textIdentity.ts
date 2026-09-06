// ---------------------------------------------------------------------------
// V2.8.8.1 — the ONE shared conservative structural-identity normalizer.
//
// Extracted from lib/targetNovelty.ts (which introduced this exact algorithm
// for AI-target-repeat detection) so a second, independent call site
// (app/api/game/[id]/resolve/route.ts's exact-guess fast path — see
// lib/exactGuessMatch.ts) reuses ONE implementation rather than a second,
// hand-copied one that could quietly drift from it.
//
// WHAT THIS DOES AND DOES NOT PROMISE, stated once so every caller can point
// here instead of restating it: it detects that two strings are almost
// certainly the SAME STRING typed differently -- different case, stray
// punctuation, incidental whitespace, or an accent/diacritic variant. It
// NEVER detects that two strings MEAN the same thing. "dog" and "kutya" are
// both real, correct answers to the same question and must never collide
// here; that judgment is semantic, not structural, and stays out of scope
// for this function everywhere it is used.
//
// Handles, in this order:
//   1. Unicode normalization (NFKD) -- decomposes an accented character into
//      its base letter plus a separate combining mark, e.g. "á" -> "a" +
//      U+0301.
//   2. Diacritic/combining-mark removal -- strips the marks NFKD just split
//      off (U+0300-U+036F, the Combining Diacritical Marks block covers
//      Hungarian's "ő"/"ű" too), so "kávé"/"kave" and "őz"/"oz" collide.
//   3. Case folding (toLowerCase).
//   4. Punctuation removal -- a trailing period, an exclamation mark, etc.
//      no longer defeats the match.
//   5. Whitespace collapse -- leading, trailing, and repeated internal
//      whitespace.
// ---------------------------------------------------------------------------
export function normalizeForConservativeIdentityMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
