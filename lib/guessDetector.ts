// ---------------------------------------------------------------------------
// Guess Detector — deterministic heuristic pass. No LLM call, no I/O, no
// randomness. Pure function of a single string, which is what makes it
// testable and what makes its behavior auditable after the fact.
//
// WHY THIS EXISTS AT ALL, given that the Racer already emits a forced enum
// `action` field: the enum catches declared guesses. It does not catch the
// case where the Racer sets action="question" but the text is functionally a
// guess ("Is it the handle on your lawnmower?"). That question, answered YES,
// ends the game without ever having been adjudicated. This module catches it.
//
// WHAT HAPPENS ON A FLAG (V1): the flag does not end the turn and is never
// shown to the human Composer. The Racer is re-prompted internally to declare
// its own intent — see resolveGuessIntent() in lib/prompts/racer.ts. In V1 the
// Racer is an AI, so there is no human on that side of the table to confirm
// with. A human-facing confirmation control belongs to Phase 2's human-Racer
// mode and is documented, not built, in docs/DESIGN-NOTES.md.
//
// BIAS: a flag costs only an internal re-prompt, with no penalty to either
// player. A miss lets a guess score as a free question. Over-flagging is
// therefore the safe direction and the rules are tuned accordingly.
//
// KNOWN RESIDUAL — ENFORCEMENT IS FAIL-OPEN ON ONE PATH. Recorded at 2.5.0.4,
// deliberately NOT changed there. If a question flags but resolveGuessIntent()
// cannot complete — the racer call budget is exhausted, or the model call
// throws — /api/game/[id]/turn falls back to treating the flagged question as
// an ordinary question. A functional guess can therefore still reach the human
// unchallenged under that failure mode. Choosing the fail-closed behaviour is a
// product decision (consume the single guess / reject and regenerate / an
// explicit rule), which is why it is scoped separately rather than patched in.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LANGUAGE COVERAGE
//
// The scoring machinery, proper-noun rule, and quoted-span rule are
// language-neutral. English and Hungarian each contribute their own
// explicit-guess frames, specific-instance patterns, and hedges.
//
// The Hungarian rules solve a problem English does not have: Hungarian marks
// possession with a SUFFIX ("fűnyíród" = "your lawnmower"), so there is no
// separable word like "your" to match. The discriminator used here is the
// definite article — possessed nouns in these constructions follow "a"/"az"
// ("a fűnyíród"), whereas the 2nd-person verb forms sharing the same -d ending
// ("tudod", "látod", "gondolod") do not. That one constraint is what stops the
// rule firing on every second verb.
//
// ⚠ Hungarian rules are tuned against test/fixtures/hungarian.ts, which has NOT
// had a native-speaker pass. Treat Hungarian accuracy as provisional until it
// does. See docs/DESIGN-NOTES.md §5.
// ---------------------------------------------------------------------------

export const FLAG_THRESHOLD = 3;

export const WEIGHTS = {
  explicitGuessFrame: 3,
  properNoun: 2,
  properNounAdditional: 1, // added once if two or more distinct proper nouns
  specificInstance: 2,
  quotedString: 2,
  candidateIdentification: 3,
  possessiveDeictic: 1,
  possessiveSuffixHu: 2,
  categoryHedge: -2,
} as const;

/** Hungarian letters, for suffix patterns where \w is not enough. */
const HU_WORD = "[A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű-]";

// --- Explicit guess frames -------------------------------------------------

/** English phrases only ever used to declare or float a guess. */
export const EXPLICIT_GUESS_FRAMES_EN: RegExp[] = [
  /\bis the answer\b/i,
  /\bthe answer is\b/i,
  /\bare you thinking of\b/i,
  /\bmy guess is\b/i,
  /\bi(?:'m| am) guessing\b/i,
  /\bi(?:'ll| will) guess\b/i,
  /\bis your (?:secret|target|answer|word|thing)\b/i,
  /\bfinal answer\b/i,
];

/**
 * Hungarian equivalents. "gondolsz" ("you are thinking of") is the
 * highest-yield one: in a Racer's question it is essentially always the setup
 * for naming the target, and it sidesteps the suffix problem because it is a
 * verb stem, not a possessed noun.
 */
export const EXPLICIT_GUESS_FRAMES_HU: RegExp[] = [
  /\ba tippem\b/i,
  /\btippelek\b/i,
  /\bgondolsz\b/i,
  /\ba megfejtés\b/i,
  /\ba megoldás\b/i,
  /\ba titkod\b/i,
  /\bvégső válasz/i,
  /\ba válasz az\b/i,
];

export const ALL_EXPLICIT_GUESS_FRAMES: RegExp[] = [
  ...EXPLICIT_GUESS_FRAMES_EN,
  ...EXPLICIT_GUESS_FRAMES_HU,
];

// --- Specific-instance patterns --------------------------------------------

/**
 * A definite noun phrase anchored to a specific instance in the Composer's
 * world: "the handle on your lawnmower". Generic questions rarely take this
 * shape.
 */
export const SPECIFIC_INSTANCE_PATTERNS_EN: RegExp[] = [
  /\bthe\s+[\w-]+(?:\s+[\w-]+)?\s+(?:on|of|from|in|inside|attached to|next to|belonging to)\s+(?:your|the|my)\s+[\w-]+/i,
];

/**
 * A possessed thing belonging to another possessed thing — "a fűnyíród
 * fogantyúja", "a kerékpárod kormánya". The Hungarian shape of "the handle on
 * your lawnmower", and the construction the pre-M3.1 detector missed entirely.
 */
export const SPECIFIC_INSTANCE_PATTERNS_HU: RegExp[] = [
  new RegExp(`\\b(?:a|az)\\s+${HU_WORD}{3,}d\\s+${HU_WORD}{3,}(?:ja|je|a|e)\\b`, "i"),
];

/** "a/az + noun carrying the 2nd-person possessive -d": "a fűnyíród". */
export const POSSESSIVE_SUFFIX_PATTERNS_HU: RegExp[] = [
  new RegExp(`\\b(?:a|az)\\s+${HU_WORD}{3,}d\\b`, "i"),
];

// --- Candidate identification ----------------------------------------------
//
// The gap the "My left ear" field test exposed. "Is it the ear?" scored ZERO:
// no proper noun, no quotes, no possessive, no explicit frame. It read as an
// ordinary narrowing question and cost one question rather than the one guess —
// exactly the case this module's header says it exists to catch.
//
// THE DISCRIMINATOR IS DEFINITENESS, not interrogative form.
//
//   "Is it a vehicle?"      indefinite -> asks which CATEGORY. Not a guess.
//   "Is it the bicycle?"    definite   -> names WHICH ONE. Functionally a guess.
//
// Hungarian marks the same distinction with the same two words: "egy" for the
// category reading ("Ez egy jármű?"), "a"/"az" for the identifying one ("A fül
// az?"). So one idea covers both languages rather than two rule sets.
//
// Two deliberate limits keep this narrow:
//
// 1. The noun phrase must END the question (at most three tokens). "Is it the
//    kind of tool used in gardening?" runs past that and does not match.
// 2. This is NOT counted as naming evidence, so category hedges still offset
//    it. A strong hedge takes 3 down to 1, below the threshold. That is what
//    protects "Is it the type of thing you own?" from flagging.
//
// A bare fragment ("Fül?") is deliberately NOT matched. "Élőlény?" has the same
// shape and is a category question; nothing lexical separates them, and guessing
// would break the fragment tolerance added in 0.9.5.0.

/** Up to three tokens of noun phrase, then the end of the question. */
const NP_TAIL_EN = "(?:[\\w-]+\\s+){0,2}[\\w-]+\\s*\\??\\s*$";
const NP_TAIL_HU = `(?:${HU_WORD}+\\s+){0,2}${HU_WORD}+\\s*\\??\\s*$`;

export const CANDIDATE_IDENTIFICATION_EN: RegExp[] = [
  // "Is it the ear?"  ·  "Is that the bicycle?"  ·  "Was it the handle?"
  // "the" and the possessives are equally identifying: "Is it the ear?" and
  // "Is it your left ear?" both name which one. "a"/"an" is excluded — that is
  // the category reading and must stay unflagged.
  new RegExp(
    `\\b(?:is|was)\\s+(?:it|that|this)\\s+(?:the|your|my|his|her|its|their)\\s+${NP_TAIL_EN}`,
    "i"
  ),
  // "Is the target the ear?"  ·  "Is the answer the bicycle?"
  //
  // FIELD TEST #4 CORRECTED THIS PATTERN. It previously read
  // `(?:a|an|the)` and so admitted the INDEFINITE article, contradicting the
  // definiteness discriminator stated three comment blocks above and obeyed by
  // pattern 1. The consequence was measured in production at `2.5.0.5`:
  //
  //     Is it a physical object?          -2   not flagged
  //     Is the target a physical object?  +3   FLAGGED
  //
  // The same category question, opposite verdicts, on phrasing alone. Ten turns
  // of a twenty-question game flagged this way; none was a real guess, and each
  // flag spent a second model call re-prompting the Racer to reword a question
  // it had already framed correctly. See docs/DESIGN-NOTES.md §32 and the
  // Field Test #4 specimens in test/guessDetector.test.ts.
  //
  // `a|an` is gone. This frame names WHICH ONE the target is; the indefinite
  // reading asks WHAT KIND, which is an ordinary narrowing question.
  //
  // THE DETERMINER SET IS NOW PATTERN 1'S, which closes a second, opposite
  // defect found while correcting the first. Pattern 1's own comment says "the
  // and the possessives are equally identifying" — but only pattern 1 acted on
  // it. `Is the target your left ear?` scored 1 and did not flag: an
  // unambiguously identifying question treated as an ordinary one, the exact
  // miss this module exists to catch.
  //
  // The two changes move in OPPOSITE directions — one narrowing, one widening —
  // and were deliberately made together by Mission Sovereign decision. The
  // consequence for evidence is recorded in docs/DESIGN-NOTES.md §34: the next
  // field test's flag rate measures their combined effect, not the removal of
  // `a|an` alone.
  new RegExp(
    `\\b(?:is|was)\\s+the\\s+(?:target|answer|thing|object|word)\\s+(?:the|your|my|his|her|its|their)\\s+${NP_TAIL_EN}`,
    "i"
  ),
];

// --- V2.6: the bare proper-noun candidate ----------------------------------
//
// FIELD-OBSERVED IN PRODUCTION at 2.6.3.0 / racer/2.6.0. A Grok Racer spent
// four consecutive question slots on:
//
//     Is the target GPT-4?   NO
//     Is the target Claude?  NO
//     Is the target Llama?   NO
//     Is the target Grok?    YES
//
// Every one scored 2 — `proper_noun` alone — against a threshold of 3. None
// flagged. The single guess entitlement was never consumed, and the final YES
// confirmed the target as a free question.
//
// THIS IS THE ENGLISH RECURRENCE OF §31's HUNGARIAN DEFECT, and the third time
// this module's vocabulary has been one word short:
//
//     Is the answer Grok?   -> 5, FLAGGED   (`is the answer` is an explicit frame)
//     Is the target Grok?   -> 2, missed    (`target` has no frame)
//     A cél a Grok?         -> 5, FLAGGED   (Hungarian catches it)
//
// WHY THE EXISTING ENGLISH RULES CANNOT REACH IT. Both CANDIDATE_IDENTIFICATION_EN
// patterns require a DETERMINER before the noun phrase, because definiteness is
// this module's discriminator. An English proper noun takes no article, so a
// bare name falls through. Hungarian's sibling rule requires a second article
// too — and catches these — only because Hungarian does use a definite article
// with proper nouns ("a Grok"). The rule was never wrong; English simply has no
// article to test.
//
// THE GAP IS EXACTLY ONE TOKEN WIDE, which is what makes a safe fix possible.
// A MULTI-word name already flags today on proper_noun + proper_noun_multiple
// (2 + 1 = 3): "Is the target Wolfram Alpha?" was already caught. Only a
// SINGLE capitalised token escapes. So this rule is deliberately restricted to
// that case rather than generalised over noun phrases — a narrower rule has a
// smaller false-positive surface, and there is nothing else to catch.
//
// THE DISCRIMINATOR IS CAPITALISATION, MINUS A CLOSED CLASS.
//
// There is NO purely syntactic signal separating "Is the target Grok?" from
// "Is the target American?" — both are `is the target <Capitalised>?`. That was
// investigated and rejected rather than approximated. What separates them is
// lexical: the second is a predicate adjective from a bounded, enumerable class
// (nationality, language, religion, region). So the class is listed, exactly as
// PROPER_NOUN_STOPWORDS already lists capitalised tokens that are not evidence.
//
// THE LIST IS INCOMPLETE AND ALWAYS WILL BE, and that is safe in the direction
// it fails: an unlisted predicate adjective FLAGS, costing one internal
// re-prompt, which is the module's stated BIAS. Do not grow this list
// speculatively — every addition is a name this rule stops catching.

/**
 * Capitalised tokens that are predicates, not names.
 *
 * Nationality, language, religion and region adjectives — the only class that
 * appears capitalised in this grammatical position without naming a candidate.
 * Kept to high-frequency members on purpose: see the note above on which
 * direction incompleteness fails in.
 */
export const CAPITALIZED_PREDICATE_STOPWORDS = new Set([
  // Nationality / origin
  "American", "British", "English", "Irish", "Scottish", "Welsh", "French",
  "German", "Italian", "Spanish", "Portuguese", "Dutch", "Belgian", "Swiss",
  "Austrian", "Hungarian", "Polish", "Czech", "Slovak", "Romanian", "Serbian",
  "Croatian", "Greek", "Turkish", "Russian", "Ukrainian", "Swedish",
  "Norwegian", "Danish", "Finnish", "Chinese", "Japanese", "Korean", "Indian",
  "Pakistani", "Iranian", "Iraqi", "Israeli", "Egyptian", "Nigerian",
  "Ethiopian", "Australian", "Canadian", "Mexican", "Brazilian", "Argentine",
  "Argentinian", "Cuban", "Vietnamese", "Thai", "Indonesian", "Filipino",
  // Region / continent
  "European", "Asian", "African", "Scandinavian", "Mediterranean", "Nordic",
  "Baltic", "Balkan", "Western", "Eastern", "Northern", "Southern",
  // Religion / culture
  "Christian", "Catholic", "Protestant", "Orthodox", "Jewish", "Muslim",
  "Islamic", "Hindu", "Buddhist", "Celtic", "Slavic", "Germanic",
]);

/**
 * `is/was` + a candidate frame + ONE capitalised token, ending the question.
 *
 * Case-SENSITIVE, so it carries no `i` flag: capitalisation is the whole
 * signal, and an `i` flag would destroy it.
 */
const BARE_CANDIDATE_EN =
  /\b(?:[Ii]s|[Ww]as)\s+(?:it|that|this|the\s+(?:target|answer|thing|object|word))\s+([A-Za-z][\w.-]*)\s*\??\s*$/;

/**
 * Does this question name a single bare candidate?
 *
 * A function rather than another entry in a RegExp list because the decision is
 * a regex match AND a lexical test, and splitting those across two places is
 * how the two drift apart.
 */
export function namesABareCandidate(text: string): boolean {
  const match = BARE_CANDIDATE_EN.exec(text);
  const token = match?.[1];
  if (!token) return false;

  // Must be capitalised. A lowercase token here is an ordinary predicate —
  // "Is the target alive?", "Is the target open source?" — and is why the
  // controls stay clear.
  if (token[0] !== token[0]?.toUpperCase() || token[0] === token[0]?.toLowerCase()) {
    return false;
  }

  // A DIGIT SETTLES IT, ahead of the stopword test. No nationality, language or
  // religion contains one, so "GPT-4", "GPT-3.5" and "Llama-2" are names with
  // certainty and can never be suppressed by a list entry added later.
  if (/\d/.test(token)) return true;

  return !CAPITALIZED_PREDICATE_STOPWORDS.has(token);
}

export const CANDIDATE_IDENTIFICATION_HU: RegExp[] = [
  // "A fül az?"  ·  "A bal füled az?"   (adjectives and possessive suffixes
  // both ride along here, which closes the "A bal füled az?" weakness without
  // a separate rule.)
  new RegExp(`^\\s*(?:a|az)\\s+(?:${HU_WORD}+\\s+){0,2}${HU_WORD}+\\s+az\\s*\\??\\s*$`, "i"),
  // "A célpont a fül?"  ·  "A válasz az orr?"  ·  "A cél a Microsoft?"
  //
  // FIELD TEST #3 ADDED `cél`. The list already held célpont, válasz,
  // megfejtés, megoldás and titok — every natural Hungarian word for the target
  // EXCEPT the shortest and most common one, which is also the word
  // RACER_SYSTEM_PROMPT and the Hungarian interface both use throughout.
  //
  // Grok asked "A cél a Microsoft?", "A cél az Apple?", "A cél a Google?" and
  // "A cél a Linux?" as ordinary questions. Each scored 2 against a threshold
  // of 3 — proper_noun alone — so four functional guesses were answered as free
  // narrowing questions. The identical frame with `célpont` scores 5 and flags.
  // The rule was correct; the vocabulary was one word short.
  //
  // Worse without the fix: "A cél a fül?" scored ZERO, because a candidate that
  // is not capitalised gets no signal at all from any other rule.
  //
  // `célpont` stays FIRST so the longer word is tried before its own prefix.
  // Backtracking would reach it either way; ordering makes that not depend on
  // engine behaviour.
  //
  // KNOWN RESIDUAL — FALSE POSITIVES ON THIS FRAME. Recorded at 2.5.0.4,
  // deliberately NOT solved there. The pattern matches
  // "<article> <target-noun> <article> <up to 3 tokens>?", which also fits
  // ordinary property and location questions:
  //
  //     A cél a konyhában található?      is the target in the kitchen?
  //     A cél a szabadban van?            is the target outdoors?
  //     A cél a te tulajdonod?            is it your property?
  //
  // All three flag. This is PRE-EXISTING in the same pattern family, not
  // introduced here — "A célpont a konyhában található?" and "A válasz a
  // szabadban van?" already flagged before `cél` was added, and were verified
  // to do so against the unmodified module. What R1 changes is EXPOSURE: `cél`
  // is far more common than `célpont`, so the rate rises.
  //
  // It is also the direction this module chose on purpose — see BIAS above. A
  // false flag costs one cheap internal re-prompt and lets the Racer restate
  // its own question; a miss hands out a free guess.
  //
  // Tightening the pattern means distinguishing a naming noun phrase from a
  // predicate in Hungarian, which needs a native-speaker vocabulary and pattern
  // review this codebase has never had (see the LANGUAGE COVERAGE note above
  // and docs/DESIGN-NOTES.md §5). Scoped separately for that reason. Do not
  // narrow it by guesswork.
  new RegExp(
    `\\b(?:a|az)\\s+(?:célpont|cél|válasz|megfejtés|megoldás|titok)\\s+(?:a|az)\\s+${NP_TAIL_HU}`,
    "i"
  ),
  // "Ez a fül?" — but never "Ez egy jármű?", which is the category reading.
  new RegExp(`\\bez\\s+(?:a|az)\\s+${NP_TAIL_HU}`, "i"),
];

/** Reference to a specific thing the Composer possesses. Weak signal alone. */
export const POSSESSIVE_DEICTIC_PATTERNS_EN: RegExp[] = [/\byour\s+[\w-]+/i];

/** Double-quoted spans — naming a thing verbatim rather than describing it. */
export const QUOTED_STRING_PATTERNS: RegExp[] = [/"[^"]{2,}"/, /“[^”]{2,}”/];

// --- Hedges, in two tiers --------------------------------------------------
//
// The tiers exist because a single hedge tier gets one of two cases wrong.
//
//   "Is the answer a type of tool?"        -> asks about a CATEGORY. Not a guess.
//   "Arra gondolsz, hogy ez egy csavarhúzó?" -> names a THING. Is a guess.
//
// Both contain a guess frame; both contain something hedge-shaped. What
// separates them is whether the hedge is real category vocabulary ("type of",
// "fajta") or merely a copula/comparison frame ("is it a", "ez egy") that
// appears just as readily inside a guess. So:
//
//   STRONG hedges  — explicit category vocabulary. Can offset a guess frame.
//   WEAK hedges    — framing only. Apply only when no guess frame is present.

export const CATEGORY_HEDGE_STRONG: RegExp[] = [
  /\b(?:type|kind|category|sort|class|form) of\b/i,
  /\b(?:fajta|féle|típus)/i,
];

export const CATEGORY_HEDGE_WEAK: RegExp[] = [
  // English
  /\bis it (?:a|an|something|anything|more|less|bigger|smaller|larger|heavier|lighter|older|newer|generally|typically|mostly|usually|ever|always)\b/i,
  /\bis it (?:alive|abstract|physical|natural|man-?made|edible|electronic|tangible|fictional)\b/i,
  /\bdoes it\b/i,
  /\bcan it\b/i,
  /\bcould it\b/i,
  /\bwould it\b/i,
  /\bdo you\b/i,
  /\bwas it (?:a|an|made|created|invented|built)\b/i,
  // Hungarian
  /\bez egy\b/i,
  /\bez valamilyen\b/i,
  new RegExp(`\\b${HU_WORD}{2,}-e\\b`, "i"), // "-e" interrogative clitic
  /\b(?:nagyobb|kisebb|nehezebb|könnyebb|régebbi|újabb)\b/i,
  /\b(?:élőlény|ember alkotta|mesterséges|természetes|elfér|készült)\b/i,
  /\bvan\s+\S+\s+alkatrésze\b/i,
  /\bszoktad\b/i,
];

/** Capitalized tokens that are not evidence of a proper noun. */
const PROPER_NOUN_STOPWORDS = new Set([
  "I", "I'm", "I'll", "I've",
  "A", "An", "The", "Is", "Are", "Does", "Do", "Was", "Were",
  "Can", "Could", "Would", "Has", "Have", "Did", "Yes", "No",
]);

export interface GuessDetectionResult {
  flagged: boolean;
  score: number;
  /** Names of the rules that fired, for post-hoc tuning and log inspection. */
  matched: string[];
}

/**
 * Find capitalized tokens that are not sentence-initial. A guess very often
 * names something; a narrowing question rarely does.
 */
function findProperNouns(text: string): string[] {
  const tokens = text.split(/\s+/);
  const found: string[] = [];
  let atSentenceStart = true;

  for (const rawToken of tokens) {
    const token = rawToken.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, "");

    if (token.length > 0 && !atSentenceStart) {
      const first = token.charAt(0);
      const isCapitalized =
        first !== first.toLowerCase() && first === first.toUpperCase();
      if (isCapitalized && !PROPER_NOUN_STOPWORDS.has(token)) {
        found.push(token);
      }
    }

    if (token.length > 0) {
      atSentenceStart = /[.!?]["')\]]?$/.test(rawToken);
    }
  }

  return Array.from(new Set(found));
}

/**
 * Score a Racer question for guess-likeness. Only call this when the Racer's
 * declared action is "question" — a declared guess needs no detection.
 */
export function detectGuess(questionText: string): GuessDetectionResult {
  const text = (questionText || "").trim();
  if (!text) {
    return { flagged: false, score: 0, matched: [] };
  }

  let score = 0;
  const matched: string[] = [];

  const hasExplicitFrame = ALL_EXPLICIT_GUESS_FRAMES.some((re) => re.test(text));
  if (hasExplicitFrame) {
    score += WEIGHTS.explicitGuessFrame;
    matched.push("explicit_guess_frame");
  }

  const properNouns = findProperNouns(text);
  const hasProperNoun = properNouns.length > 0;
  if (hasProperNoun) {
    score += WEIGHTS.properNoun;
    matched.push("proper_noun");
    if (properNouns.length >= 2) {
      score += WEIGHTS.properNounAdditional;
      matched.push("proper_noun_multiple");
    }
  }

  const hasSpecificInstance =
    SPECIFIC_INSTANCE_PATTERNS_EN.some((re) => re.test(text)) ||
    SPECIFIC_INSTANCE_PATTERNS_HU.some((re) => re.test(text));
  if (hasSpecificInstance) {
    score += WEIGHTS.specificInstance;
    matched.push("specific_instance");
  }

  const hasQuotedString = QUOTED_STRING_PATTERNS.some((re) => re.test(text));
  if (hasQuotedString) {
    score += WEIGHTS.quotedString;
    matched.push("quoted_string");
  }

  // Strong category vocabulary disqualifies the shape outright. "Is it the kind
  // of tool?" is grammatically definite but asks about a CLASS, and the -2 hedge
  // cannot be relied on to offset it — other rules can suppress hedging.
  const namesACategory = CATEGORY_HEDGE_STRONG.some((re) => re.test(text));
  const hasCandidateId =
    !namesACategory &&
    (CANDIDATE_IDENTIFICATION_EN.some((re) => re.test(text)) ||
      // V2.6 — the bare proper-noun candidate. Sits inside the same
      // `namesACategory` guard as its siblings, so "Is it the kind of Grok?"
      // is still disqualified by category vocabulary rather than needing its
      // own exception.
      namesABareCandidate(text) ||
      CANDIDATE_IDENTIFICATION_HU.some((re) => re.test(text)));
  if (hasCandidateId) {
    score += WEIGHTS.candidateIdentification;
    matched.push("candidate_identification");
  }

  if (POSSESSIVE_DEICTIC_PATTERNS_EN.some((re) => re.test(text))) {
    score += WEIGHTS.possessiveDeictic;
    matched.push("possessive_deictic");
  }

  // Weighted above English "your" because the article+suffix construction
  // specifically picks out a possessed instance, where English "your" also
  // shows up in ordinary comparisons ("bigger than your hand").
  const hasHuPossessive = POSSESSIVE_SUFFIX_PATTERNS_HU.some((re) => re.test(text));
  if (hasHuPossessive) {
    score += WEIGHTS.possessiveSuffixHu;
    matched.push("possessive_suffix_hu");
  }

  // Naming evidence disables hedging entirely: a question that names a
  // specific entity is not rescued by category-shaped preamble.
  const hasNamingEvidence =
    hasProperNoun || hasSpecificInstance || hasQuotedString || hasHuPossessive;

  const hasStrongHedge = CATEGORY_HEDGE_STRONG.some((re) => re.test(text));
  const hasWeakHedge = CATEGORY_HEDGE_WEAK.some((re) => re.test(text));
  const hedgeApplies =
    !hasNamingEvidence && (hasStrongHedge || (hasWeakHedge && !hasExplicitFrame));

  if (hedgeApplies) {
    score += WEIGHTS.categoryHedge;
    matched.push(hasStrongHedge ? "category_hedge_strong" : "category_hedge_weak");
  }

  return { flagged: score >= FLAG_THRESHOLD, score, matched };
}
