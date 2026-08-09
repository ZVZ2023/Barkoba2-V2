// ---------------------------------------------------------------------------
// Non-disclosure guard for Composer-visible text.
//
// Field Test #2: target `dog`, question "Does it have long hair?", answered
// AMBIGUOUS — correctly — with the explanation "Hair length varies enormously
// by breed, some dogs have long hair...". The classification was right and the
// explanation handed over the answer on turn 15 of 20.
//
// WHY THIS IS CODE AND NOT ONLY A PROMPT RULE: the Composer prompt already
// told the model not to reveal the target. It revealed the target. A rule the
// model is asked to follow is not an invariant; a check applied to its output
// is. The prompt is still tightened, because prevention beats redaction — but
// this function is what makes the guarantee hold when the prompt does not.
//
// Pure, deterministic, no I/O. Runs on every piece of model text that reaches
// the Racer before declassification.
// ---------------------------------------------------------------------------

/** Shown in place of an explanation that gave the target away. */
export const SAFE_AMBIGUOUS_EXPLANATION =
  "This characteristic varies significantly within the target category, so neither YES nor NO would be reliably accurate.";

/** Words too common to treat as identifying, even inside a multi-word target. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "my", "your", "his", "her", "its", "their",
  "and", "or", "in", "on", "at", "to", "for", "with", "own", "one",
  "az", "egy", "es", "vagy",
]);

/** Strip accents so "fűnyíró" is caught by "funyiro" and vice versa. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Inflected forms of one word. Deliberately crude: this needs to catch
 * "dog" -> "dogs", not to be a morphology engine. Over-matching costs a
 * redacted sentence; under-matching costs the game.
 */
function variants(word: string): string[] {
  const w = fold(word);
  const out = new Set<string>([w]);
  out.add(w + "s");
  out.add(w + "es");
  if (w.endsWith("y")) out.add(w.slice(0, -1) + "ies");
  if (w.endsWith("s")) out.add(w.slice(0, -1));
  if (w.endsWith("es")) out.add(w.slice(0, -2));
  if (w.endsWith("ies")) out.add(w.slice(0, -3) + "y");
  // Hungarian accusative/plural, the two that show up constantly in play.
  out.add(w + "t");
  out.add(w + "ot");
  out.add(w + "ok");
  out.add(w + "ak");
  return [...out].filter((v) => v.length >= 3);
}

/** Identifying terms for a target: the whole phrase, plus its content words. */
export function disclosureTerms(target: string): string[] {
  const folded = fold(target).trim();
  if (!folded) return [];

  const terms = new Set<string>();
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  // A single-word target IS the target, so it always gets its inflections:
  // "dog" must match "dogs". The 4-character floor below applies only to the
  // parts of a MULTI-word target, where one short word carries little identity.
  if (words.length === 1 && folded.length >= 3) {
    for (const v of variants(folded)) terms.add(v);
  } else if (folded.length >= 3) {
    // The full phrase, so "eiffel tower" is caught even if no word alone is.
    terms.add(folded);
  }

  if (words.length > 1) {
    for (const word of words) {
      if (word.length < 4) continue; // "red", "of" — too weak to redact on
      if (STOPWORDS.has(word)) continue;
      for (const v of variants(word)) terms.add(v);
    }
  }
  return [...terms];
}

/** Does this visible text give the target away? */
export function revealsTarget(text: string | null, target: string): boolean {
  if (!text) return false;
  const haystack = fold(text);
  for (const term of disclosureTerms(target)) {
    // Word-boundary match, so "cat" does not fire inside "category" —
    // the exact false positive that would gut every AMBIGUOUS explanation.
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}([^\\p{L}\\p{N}]|$)`, "u");
    if (re.test(haystack)) return true;
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ScrubResult<T> {
  value: T;
  redacted: boolean;
}

/**
 * An explanation that discloses is REPLACED wholesale, not edited.
 *
 * Cutting the offending word out leaves the sentence shape around it, and the
 * shape is often as informative as the word. A generic replacement tells the
 * player nothing they did not already have.
 */
export function scrubExplanation(
  text: string | null,
  target: string
): ScrubResult<string | null> {
  if (!revealsTarget(text, target)) return { value: text, redacted: false };
  return { value: SAFE_AMBIGUOUS_EXPLANATION, redacted: true };
}

/**
 * A disclosing clue is DROPPED rather than replaced. A clue is optional help;
 * a generic one would be noise dressed up as assistance.
 */
export function scrubClue(text: string | null, target: string): ScrubResult<string | null> {
  if (!revealsTarget(text, target)) return { value: text, redacted: false };
  return { value: null, redacted: true };
}
