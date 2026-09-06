import type { GameLanguage } from "./types";

// ---------------------------------------------------------------------------
// V2.8.7.4 — DEFECT 3: the universal no-spelling rule.
//
// Field report: production accepted and answered "The target first letter in
// Hungarian starts with F?" — a Racer can mechanically reconstruct a target's
// written/spoken NAME through a sequence of such questions, which defeats the
// entire premise of the game (reason about the THING, not its label).
//
// HARD RULE, every direction, every difficulty, every mode: a Racer question
// must never seek information about how the target's name is written or
// spoken. Submitting a final GUESS of the name is always allowed — only
// QUESTIONS that probe the name's spelling/pronunciation are prohibited.
//
// Pure, no React, no DOM, no model call, no import of lib/secretStore.ts —
// the same reason lib/duplicateQuestionGuard.ts and lib/rewind.ts are pure:
// this is the ONE centralized policy layer every question-submission and
// AI-question-generation path calls, so the rule cannot be enforced
// differently (or forgotten) in one direction and not another.
//
// DELIBERATE SCOPE LIMIT, stated honestly rather than glossed over: this is
// a DETERMINISTIC, pattern-based classifier. It reliably catches the
// concrete categories the field report and the product rule name explicitly
// (first/last letter, letter-at-position, contains-letter, letter/character
// count, spelling, prefix/suffix/initials/abbreviation/acronym, syllable
// count, pronunciation/phonetic, rhyme, and an explicit "what is it called
// in [language]" naming probe). It CANNOT reliably catch an indirect,
// multi-question paraphrase engineered to reconstruct the name without ever
// using any of these words — no regex can, and neither could a single-shot
// semantic check reasoning about ONE question in isolation (the give-away is
// the SEQUENCE, not any one question). That residual gap is the honestly
// disclosed limitation this repair reports, not something claimed to be
// solved here. See app/api/game/[id]/turn/route.ts and lib/prompts/racer.ts
// for how the AI Racer's OWN prompt-level instruction is the (necessarily
// imperfect) second layer against exactly that gap.
// ---------------------------------------------------------------------------

export type QuestionPolicyViolation =
  | "letter_position"
  | "letter_contains"
  | "letter_count"
  | "spelling"
  | "affix_or_acronym"
  | "syllable_count"
  | "pronunciation"
  | "rhyme"
  | "name_in_language";

export interface QuestionPolicyResult {
  allowed: boolean;
  violation: QuestionPolicyViolation | null;
}

/** One rule per prohibited category. Order is the order they are checked; the FIRST match is reported. */
const RULES: ReadonlyArray<{ violation: QuestionPolicyViolation; pattern: RegExp }> = [
  // First/last letter, or a letter at a specific position.
  {
    violation: "letter_position",
    pattern:
      /\b(first|last|\d+(st|nd|rd|th)|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+letter\b|\b(starts?|begins?|ends?)\s+with\s+(the\s+letter|an?\s+letter)\b|\belső\s+bet[űu]|\butolsó\s+bet[űu]|\d+\.\s*bet[űu]|\bhányadik\s+bet[űu]|\bbet[űu]vel\s+kezd[őo]dik|\bkezd[őo]dik\b.{0,20}\bbet[űu]/i,
  },
  // Whether the name contains a given letter.
  {
    violation: "letter_contains",
    pattern:
      /\b(contains?|has|have)\b.{0,15}\bletter\b|\bletter\b.{0,15}\b(in it|in the (name|word))\b|\btartalmaz(za|za-e)?\b.{0,20}\bbet[űu]/i,
  },
  // Number of letters/characters.
  {
    violation: "letter_count",
    pattern:
      /\bhow many (letters|characters)\b|\b(letter|character)\s+count\b|\bnumber of (letters|characters)\b|\bhány\s+bet[űu]|\bhány\s+karakter|\bbet[űu]szám/i,
  },
  // Spelling, in any language.
  {
    violation: "spelling",
    pattern:
      /\bspell(ed|ing)?\b|\bhow (do you|is it) spell|\bhelyes[íi]r[áa]s|\bhogyan?\s+(kell|lehet)?\s*[íi]rni\b|\bhogy\s+[íi]rj[áa]k\b/i,
  },
  // Prefix, suffix, initials, abbreviation, acronym.
  {
    violation: "affix_or_acronym",
    pattern:
      /\bprefix\b|\bsuffix\b|\bacronym\b|\babbreviat(ion|ed)\b|\binitials?\b|\bel[őo]tag\b|\but[óo]tag\b|\br[öo]vid[íi]t[ée]s\b|\bmozaiksz[óo]\b|\bkezd[őo]bet[űu]/i,
  },
  // Syllable count.
  {
    violation: "syllable_count",
    pattern: /\bsyllables?\b|\bsz[óo]tag(ok|ja|sz[áa]m)?\b/i,
  },
  // Pronunciation / phonetic construction.
  {
    violation: "pronunciation",
    pattern: /\bpronounc(e|ed|es|ing|iation)\b|\bphonetic(s|ally)?\b|\bkiejt\w*|\bejtik\b|\bejtve\b/i,
  },
  // Rhyme.
  {
    violation: "rhyme",
    pattern: /\brhymes?\b|\br[íi]mel/i,
  },
  // An explicit "what is it called / named, in [language]" naming probe —
  // distinct from a legitimate property question, this specifically targets
  // the WORD used for the target, in a named language.
  {
    violation: "name_in_language",
    pattern:
      /\bwhat('s| is)\s+it\s+called\s+in\s+\w+|\bwhat('s| is)\s+its\s+name\s+in\s+\w+|\bhogy\s+h[íi]vj[áa]k\b.{0,20}\bnyelven\b|\bmi\s+a\s+neve\b.{0,20}\bnyelven\b/i,
  },
];

/**
 * Decide whether a Racer's question text seeks information about the
 * target's written/spoken NAME rather than the thing itself. Case-
 * insensitive, language-agnostic (checks both the English and Hungarian
 * patterns regardless of `gameLanguage` — a bilingual player may phrase a
 * question in either language mid-game, and the rule applies identically).
 */
export function checkQuestionPolicy(questionText: string): QuestionPolicyResult {
  for (const rule of RULES) {
    if (rule.pattern.test(questionText)) {
      return { allowed: false, violation: rule.violation };
    }
  }
  return { allowed: true, violation: null };
}

/**
 * Localized, actionable rejection message. Matches the established
 * Record<GameLanguage, string> bilingual-copy pattern (see e.g.
 * app/game/[id]/GameClient.tsx's SANDBOX_CLARIFICATION_LABEL).
 */
export const QUESTION_POLICY_REJECTION_MESSAGE: Record<GameLanguage, string> = {
  hu: "Ez a kérdés a célpont nevének helyesírására vagy kiejtésére kérdez rá, ami a Barkóba szabályai szerint nem megengedett — csak a célpont tulajdonságairól kérdezhetsz. A tippedet természetesen bármikor megteheted.",
  en: "That question asks about the target's name — its spelling, letters, or pronunciation — which Barkóba's rules do not allow; you may only ask about the target's properties. You can still submit your final guess at any time.",
};
