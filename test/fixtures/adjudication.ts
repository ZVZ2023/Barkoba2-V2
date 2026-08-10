import type { GameLanguage } from "../../lib/types";

// ---------------------------------------------------------------------------
// Adjudication fixtures.
//
// The Adjudicator decides whether the Racer's one guess matched the locked
// target. A semantic or granularity error here is not a polish problem — it
// takes a win from a Racer who deduced correctly, or awards one that was not
// earned, with no later stage to catch it.
//
// These fixtures cannot be ordinary unit tests: the Adjudicator is a model
// call. They are data, consumed by `npm run eval:adjudicator`, which hits the
// real API. `npm test` runs only the hermetic structural checks in
// test/adjudicationFixtures.test.ts.
//
// ===========================================================================
// THE LOCKED PRINCIPLE
// ===========================================================================
//
// A final guess is correct when it identifies the same intended referent or
// concept as the immutable target, allowing different wording, synonyms,
// translations, and equivalent descriptions.
//
// A containing whole or a component is NEVER sufficient. Barkóba's granularity
// rule treats part and whole as genuinely distinct targets, regardless of
// phrasing.
//
// A broader category or general description is sufficient ONLY IF it uniquely
// picks out the same single referent as the locked target. If it could equally
// apply to something the target does not denote, it fails.
//
// ---------------------------------------------------------------------------
// WHY part_vs_whole AND broader_narrower ARE DIFFERENT RULES
// ---------------------------------------------------------------------------
//
// These two look like one rule with two names. They are not, and collapsing
// them is the most likely way for someone to "simplify" this file into being
// wrong. The distinction:
//
//   broader_narrower applies a UNIQUENESS test. Ask: does this description
//   pick out exactly one thing, and is that thing the target? "Earth's only
//   natural satellite" is a wordy description that survives the test. "A
//   natural satellite" does not, because it equally denotes Titan.
//
//   part_vs_whole FORECLOSES one particular way of passing that test. A guess
//   naming the lawnmower DOES pick out exactly one thing — unambiguously so.
//   It still fails, because the one thing it picks out is not the target. The
//   rule exists to block the intuitive argument "I identified it, it's right
//   there on the thing I named". CONTAINMENT IS NOT IDENTITY. Being able to
//   find the target from what was named is not the same as having named it.
//
// So: uniqueness can rescue a broad description. Uniqueness can NEVER rescue
// a part/whole mismatch. Every part_vs_whole fixture below is `incorrect`,
// including the ones whose guesses are perfectly unambiguous — that is the
// point of them, not an oversight.
//
// ---------------------------------------------------------------------------
// AUTHORSHIP CAVEAT — READ BEFORE TRUSTING RESULTS
// ---------------------------------------------------------------------------
//
// The expected verdicts below are authored judgement, not measured fact.
// Most categories are near-uncontroversial (exact_match, category_vs_instance,
// multi_candidate, degenerate_guess). Two are genuinely arguable and encode a
// game-design choice about how strict Barkóba is:
//
//   - part_vs_whole
//   - broader_narrower
//
// Those two decide the game's difficulty. They were written to the locked
// principle above, but the principle itself was a decision, and reasonable
// people could have locked a different one.
//
// CORRECTIONS APPLIED AFTER THE FIRST BASELINE
//
// Two distinct authoring errors were found by running this set for real. Both
// are recorded rather than quietly fixed, because the error CLASSES are more
// useful than the individual corrections:
//
//   (a) NARRATIVE DETAIL MISTAKEN FOR REFERENT IDENTIFICATION (inst-4).
//       A guess was marked incorrect for omitting descriptive colour — the
//       grandfather provenance — when the locked principle asks only whether
//       the referent resolves uniquely. It did. When auditing this file, ask
//       "does this pick out the right thing?", never "does this recite
//       everything the Composer said about it?".
//
//   (b) RULE-GOVERNED CASES FILED AS BORDERLINE (bord-3, bord-5, bord-6).
//       Three cases were parked in `borderline` when the existing rules in
//       fact decide them: sun/sunlight is a distinct referent, and both
//       winter/January and routine/waking-early are plain part-for-whole.
//       `borderline` is for cases with NO defensible answer. Using it for
//       cases that are merely hard to think about hides real rule coverage and
//       weakens the calibration signal, since the surviving borderline
//       fixtures are what measure overconfidence.
//
// GENEROSITY CLAUSE (added with the locked principle, after the first baseline)
//
// Imperfect WORDING for a correctly identified referent resolves in the
// Racer's favour: metonymy, colloquialism, register, an activity named by its
// characteristic equipment. It does NOT reach a containing whole, a component,
// or a description that fails to resolve uniquely.
//
// The failure mode to watch for is LEAKAGE — generosity being stretched to
// excuse a granularity error because the guess sounds like a natural way to
// refer to the thing. part-9 exists solely to catch that: "a violin" for
// "orchestra" is exactly the shape generosity forgives elsewhere, and must
// still fail. If part-9 or any part_vs_whole / category_vs_instance fixture
// starts passing as correct, generosity has leaked and the clause needs
// tightening, not the fixture.
//
// INFLECTION IS IDENTITY (locked after the orth-5 investigation)
//
// Same lexeme, differing only by regular grammatical inflection (case, number,
// conjugation) = CORRECT. Identity, not equivalence, and independent of whether
// the guess reflects the clarification's specificity.
//
// It does NOT reach a derivationally related word from the same root with a
// different meaning or part of speech — that is a different lexeme. orth-6
// (fogantyú -> fogó, "pliers") and orth-7 (theatre -> theatrical) are the
// guards. If either starts passing, the rule has been read as "same root"
// instead of "same word in a different grammatical form", and the PROMPT needs
// tightening — never the fixtures.
//
// CLOSED MEMBERSHIP ENUMERATION (locked after the second baseline)
//
// Complete enumeration of a FIXED, CLOSED membership may identify the
// collective, when that membership constitutes its identity (desc-7). It does
// not qualify for partial enumeration (part-10), variable/open membership
// (part-11), or a functional whole whose identity is not reducible to its
// components (part-12).
//
// This is a SEPARATE rule from generosity and from uniqueness, and it is not a
// softening of the granularity rule. The four guards exist because it is the
// most stretchable rule in the set: read loosely, "naming members identifies
// the group" dissolves part_vs_whole entirely. part-9 through part-12 are the
// tripwires. If any of them starts passing as correct, the rule has leaked and
// the PROMPT needs tightening — never the fixtures.
//
// RESIDUAL, unresolved: cat-6 (sun/sunlight) sits in `category_vs_instance`
// because that is the nearest existing home, but sunlight is an EMISSION of the
// sun, not a broader category containing it. The verdict is not in doubt; the
// filing is imprecise. A `related_not_identical` category would fit better.
// Not created, because adding a fifteenth category is a scope decision, not a
// tidy-up.
//
// REVIEW PROTOCOL: correct the expected verdict where you disagree. If the
// Adjudicator then fails that case, that is a real finding about the prompt —
// not a reason to move the expectation back to whatever the model happened to
// say. Never tune an expectation to make a run go green.
//
// QUESTION-FORM UTTERANCES — settled, and NOT an Adjudicator concern.
//
// Interrogative form does not exempt an utterance from guess detection. But
// what counts as "the guess" is governed by the RACER'S COMMITTED INTENT,
// resolved upstream through the Guess Detector -> intent-resolution path in
// lib/prompts/racer.ts (resolveGuessIntent). It is NOT decided by
// content-matching independent of that intent.
//
// The mechanism, precisely:
//
//   1. The Racer emits action="question" whose text is guess-shaped
//      ("Is it a hammer?"). The deterministic detector flags it.
//   2. The Racer is re-prompted internally with a forced binary choice.
//   3. confirm_guess         -> the utterance becomes final_guess_text, phase
//                               moves to "resolving", and it reaches the
//                               Adjudicator like any other guess.
//   4. continue_questioning  -> NO guess is consumed, even if the named content
//                               happens to match the target exactly. The Racer
//                               keeps testing that hypothesis without burning
//                               its one shot.
//
// The consequence for this file: the Adjudicator NEVER sees an unconfirmed
// question-form utterance. By the time anything reaches adjudication, intent is
// already settled upstream. There is therefore no question-form category here,
// and adding one would test the wrong component — it would assert Adjudicator
// behaviour for an input the Adjudicator cannot receive.
//
// ---------------------------------------------------------------------------

export type AdjudicationCategory =
  | "exact_match"
  | "synonym_wording"
  | "specific_instance"
  | "category_vs_instance"
  | "part_vs_whole"
  | "broader_narrower"
  | "descriptive_referent"
  | "borderline"
  | "clarification_decisive"
  | "multi_candidate"
  | "orthographic_variant"
  | "cross_language"
  | "degenerate_guess"
  | "abstract_target";

export const ADJUDICATION_CATEGORIES: AdjudicationCategory[] = [
  "exact_match",
  "synonym_wording",
  "specific_instance",
  "category_vs_instance",
  "part_vs_whole",
  "broader_narrower",
  "descriptive_referent",
  "borderline",
  "clarification_decisive",
  "multi_candidate",
  "orthographic_variant",
  "cross_language",
  "degenerate_guess",
  "abstract_target",
];

export interface AdjudicationFixture {
  id: string;
  category: AdjudicationCategory;
  target: string;
  clarification: string;
  guess: string;
  language: GameLanguage;
  /** null ONLY for borderline cases, where asserting a verdict would invent ground truth. */
  expect: "correct" | "incorrect" | null;
  /** Borderline cases only: confidence must be at or below this. Tests calibration. */
  maxConfidence?: number;
  /** id of the fixture this forms a minimal pair with. */
  pair?: string;
  note?: string;
}

const MOWER = "the pull-cord starting handle on my petrol lawnmower";
const WATCH = "the only pocket watch I own — gold, inherited from my grandfather";

export const ADJUDICATION_FIXTURES: AdjudicationFixture[] = [
  // --- 1. exact_match ------------------------------------------------------
  { id: "exact-1", category: "exact_match", target: "bicycle", clarification: "a standard adult road bicycle", guess: "bicycle", language: "en", expect: "correct" },
  { id: "exact-2", category: "exact_match", target: "the Eiffel Tower", clarification: "the iron tower in Paris", guess: "the Eiffel Tower", language: "en", expect: "correct" },
  { id: "exact-3", category: "exact_match", target: "kalapács", clarification: "egy hagyományos ácskalapács a szerszámosládámban", guess: "kalapács", language: "hu", expect: "correct" },

  // --- 2. synonym_wording --------------------------------------------------
  { id: "syn-1", category: "synonym_wording", target: "bicycle", clarification: "a standard adult road bicycle", guess: "bike", language: "en", expect: "correct" },
  { id: "syn-2", category: "synonym_wording", target: "bicycle", clarification: "a standard adult road bicycle", guess: "pushbike", language: "en", expect: "correct" },
  { id: "syn-3", category: "synonym_wording", target: "sofa", clarification: "the three-seater sofa in my living room", guess: "couch", language: "en", expect: "correct", pair: "syn-4" },
  { id: "syn-4", category: "synonym_wording", target: "sofa", clarification: "the three-seater sofa in my living room", guess: "armchair", language: "en", expect: "incorrect", pair: "syn-3", note: "Minimal pair against syn-3: adjacent furniture, not a synonym." },
  { id: "syn-5", category: "synonym_wording", target: "lift", clarification: "the elevator in my apartment block", guess: "elevator", language: "en", expect: "correct" },

  // --- 3. specific_instance ------------------------------------------------
  { id: "inst-1", category: "specific_instance", target: "handle", clarification: MOWER, guess: "the starting handle on your lawnmower", language: "en", expect: "correct" },
  { id: "inst-2", category: "specific_instance", target: "handle", clarification: MOWER, guess: "the plastic grip you pull to start the mower", language: "en", expect: "correct" },
  { id: "inst-3", category: "specific_instance", target: "my grandfather's watch", clarification: WATCH, guess: "the pocket watch you inherited from your grandfather", language: "en", expect: "correct", pair: "inst-4" },
  { id: "inst-4", category: "specific_instance", target: "my grandfather's watch", clarification: WATCH, guess: "a gold pocket watch", language: "en", expect: "correct", pair: "inst-3", note: "CORRECTED after the first baseline. Originally marked incorrect because the guess drops the grandfather provenance — but that is narrative detail, not referent identification. The clarification establishes the Composer owns only one pocket watch, so 'a gold pocket watch' resolves uniquely in exactly the way inst-5 does. Pairs with inst-3 to show that shedding descriptive detail does not defeat identification while the referent still resolves." },
  { id: "inst-5", category: "specific_instance", target: "the oak in my garden", clarification: "the single large oak at the end of my garden; it is the only tree there", guess: "the tree in your garden", language: "en", expect: "correct", note: "Clarification establishes uniqueness, so the broad phrasing still resolves." },

  { id: "inst-6", category: "specific_instance", target: "My left ear", clarification: "my own left ear, the one on my head", guess: "ear", language: "en", expect: "incorrect", note: "V2.1.1.2 field regression. The Racer named the body part but not WHICH one — and there are two, on a specific person. 'ear' does not resolve to the locked referent, so identification fails on specificity. Recorded from the deployed My-left-ear game, where the live adjudicator got this right; the fixture exists to keep it that way." },

  // --- 4. category_vs_instance ---------------------------------------------
  { id: "cat-1", category: "category_vs_instance", target: "handle", clarification: MOWER, guess: "a tool", language: "en", expect: "incorrect" },
  { id: "cat-2", category: "category_vs_instance", target: "handle", clarification: MOWER, guess: "a machine part", language: "en", expect: "incorrect" },
  { id: "cat-3", category: "category_vs_instance", target: "handle", clarification: MOWER, guess: "garden equipment", language: "en", expect: "incorrect" },
  { id: "cat-4", category: "category_vs_instance", target: "the Eiffel Tower", clarification: "the iron tower in Paris", guess: "a landmark", language: "en", expect: "incorrect" },
  { id: "cat-5", category: "category_vs_instance", target: "bicycle", clarification: "a standard adult road bicycle", guess: "a vehicle", language: "en", expect: "incorrect" },
  { id: "cat-6", category: "category_vs_instance", target: "the sun", clarification: "the star at the centre of our solar system", guess: "sunlight", language: "en", expect: "incorrect", note: "Reclassified from bord-3 after the first baseline. Not genuinely borderline: sunlight is the sun's emission, a distinct referent. Filed here as a non-identity relation rather than a literal category error — see the note on category fit at the head of this file." },

  // --- 5. part_vs_whole — ALWAYS incorrect, both directions -----------------
  { id: "part-1", category: "part_vs_whole", target: "handle", clarification: MOWER, guess: "your lawnmower", language: "en", expect: "incorrect", note: "Whole for part. The guess is perfectly unambiguous and still fails." },
  { id: "part-2", category: "part_vs_whole", target: "handle", clarification: MOWER, guess: "the recoil starter assembly of your mower", language: "en", expect: "incorrect", note: "Containing sub-assembly. Closer, still not identity." },
  { id: "part-3", category: "part_vs_whole", target: "my lawnmower", clarification: "the petrol push mower in my shed", guess: "the pull-cord handle on your mower", language: "en", expect: "incorrect", note: "Part for whole — the reverse direction of part-1." },
  { id: "part-4", category: "part_vs_whole", target: "the Eiffel Tower", clarification: "the iron tower in Paris", guess: "the top observation deck of the Eiffel Tower", language: "en", expect: "incorrect" },
  { id: "part-5", category: "part_vs_whole", target: "the steering wheel of my car", clarification: "the leather-wrapped wheel in my hatchback", guess: "your car", language: "en", expect: "incorrect" },
  { id: "part-6", category: "part_vs_whole", target: "piano", clarification: "the upright piano in my hall", guess: "a piano key", language: "en", expect: "incorrect" },
  { id: "part-7", category: "part_vs_whole", target: "winter", clarification: "the coldest season where I live", guess: "January", language: "en", expect: "incorrect", note: "Reclassified from bord-5 after the first baseline. Part for whole, temporally: January is a component of winter, not winter." },
  { id: "part-10", category: "part_vs_whole", target: "the Beatles", clarification: "the band from Liverpool", guess: "John, Paul and George", language: "en", expect: "incorrect", note: "ENUMERATION GUARD — PARTIAL. One member short of desc-7. If this passes, the rule has been read as 'name some members' rather than 'the complete membership is the identity'." },
  { id: "part-11", category: "part_vs_whole", target: "my football club", clarification: "the local club I have supported since childhood; its squad turns over every season", guess: "the eleven players who started last Saturday", language: "en", expect: "incorrect", note: "ENUMERATION GUARD — VARIABLE MEMBERSHIP. Complete for one moment in time, but the membership is not the club's identity: the club survives every transfer. Closed-membership enumeration must not reach open sets." },
  { id: "part-12", category: "part_vs_whole", target: "my car", clarification: "the hatchback parked outside my house", guess: "an engine, four wheels, a chassis and a body", language: "en", expect: "incorrect", note: "ENUMERATION GUARD — FUNCTIONAL WHOLE. An exhaustive component list, and still not the car. Identity here is organisation and function, not membership." },
  { id: "part-9", category: "part_vs_whole", target: "orchestra", clarification: "the symphony orchestra I play in", guess: "a violin", language: "en", expect: "incorrect", note: "GENEROSITY LEAKAGE GUARD. Superficially resembles the metonymy that generosity forgives — an ensemble named by characteristic instrument — but a violin is one component of many, not the ensemble. If this starts passing as correct, the generosity clause has leaked into the granularity rule." },
  { id: "part-8", category: "part_vs_whole", target: "my morning routine", clarification: "the sequence of things I do after waking up", guess: "waking up early", language: "en", expect: "incorrect", note: "Reclassified from bord-6 after the first baseline. Part for whole: one step of the sequence is not the sequence." },

  // --- 6. broader_narrower — uniqueness decides -----------------------------
  { id: "broad-1", category: "broader_narrower", target: "the Eiffel Tower", clarification: "the iron tower in Paris", guess: "the iron lattice tower on the Champ de Mars designed by Gustave Eiffel", language: "en", expect: "correct", pair: "broad-2", note: "Wordier and narrower, identical referent." },
  { id: "broad-2", category: "broader_narrower", target: "the Eiffel Tower", clarification: "the iron tower in Paris", guess: "a tower in Paris", language: "en", expect: "incorrect", pair: "broad-1", note: "Equally denotes the Tour Montparnasse. Uniqueness fails." },
  { id: "broad-3", category: "broader_narrower", target: "the Moon", clarification: "Earth's natural satellite", guess: "Earth's only natural satellite", language: "en", expect: "correct", pair: "broad-4" },
  { id: "broad-4", category: "broader_narrower", target: "the Moon", clarification: "Earth's natural satellite", guess: "a natural satellite", language: "en", expect: "incorrect", pair: "broad-3", note: "Equally denotes Titan." },
  { id: "broad-5", category: "broader_narrower", target: "my grandfather's watch", clarification: WATCH, guess: "the only pocket watch you own", language: "en", expect: "correct", note: "Broad phrasing, but the clarification makes it resolve uniquely." },
  { id: "broad-6", category: "broader_narrower", target: "my grandfather's watch", clarification: WATCH, guess: "an old watch", language: "en", expect: "incorrect" },
  { id: "broad-7", category: "broader_narrower", target: "handle", clarification: MOWER, guess: "a handle on a garden machine", language: "en", expect: "incorrect", note: "Could equally denote the mower's throttle handle." },

  // --- 7. descriptive_referent ---------------------------------------------
  { id: "desc-1", category: "descriptive_referent", target: "the thing you pull to start a lawnmower", clarification: MOWER, guess: "the recoil starter grip", language: "en", expect: "correct" },
  { id: "desc-2", category: "descriptive_referent", target: "the small metal object that opens my front door", clarification: "my house key", guess: "your house key", language: "en", expect: "correct" },
  { id: "desc-3", category: "descriptive_referent", target: "the room where I cook", clarification: "my kitchen", guess: "the kitchen", language: "en", expect: "correct", pair: "desc-4" },
  { id: "desc-4", category: "descriptive_referent", target: "the room where I cook", clarification: "my kitchen", guess: "a room in your house", language: "en", expect: "incorrect", pair: "desc-3" },
  { id: "desc-5", category: "descriptive_referent", target: "the device I wear to tell the time", clarification: "my wristwatch", guess: "your wristwatch", language: "en", expect: "correct" },
  { id: "desc-7", category: "descriptive_referent", target: "the Beatles", clarification: "the band from Liverpool", guess: "John, Paul, George and Ringo", language: "en", expect: "correct", note: "Was bord-2. CLOSED MEMBERSHIP ENUMERATION: a complete, fixed membership that constitutes the collective's identity. Reclassified from borderline once that rule was locked. Its adversarial counterparts are part-10 (partial), part-11 (variable membership) and part-12 (functional whole) — all incorrect." },
  { id: "desc-6", category: "descriptive_referent", target: "chess", clarification: "the board game I play on Sundays", guess: "a chess set", language: "en", expect: "correct", note: "Was bord-4. GENEROSITY CLAUSE: metonymy — an activity named by its characteristic equipment. Reclassified from borderline once generosity was locked; the rules now decide it." },

  // --- 8. borderline — calibration only, no verdict asserted ----------------
  { id: "bord-1", category: "borderline", target: "coffee", clarification: "the drink I make every morning", guess: "espresso", language: "en", expect: null, maxConfidence: 0.8 },

  // --- 9. clarification_decisive — same target AND guess, verdict flips -----
  { id: "clar-1a", category: "clarification_decisive", target: "handle", clarification: "the lever handle on my front door", guess: "a door handle", language: "en", expect: "correct", pair: "clar-1b" },
  { id: "clar-1b", category: "clarification_decisive", target: "handle", clarification: MOWER, guess: "a door handle", language: "en", expect: "incorrect", pair: "clar-1a", note: "Identical target and guess to clar-1a. Only the clarification differs." },
  { id: "clar-2a", category: "clarification_decisive", target: "mercury", clarification: "the innermost planet of our solar system", guess: "the planet closest to the sun", language: "en", expect: "correct", pair: "clar-2b" },
  { id: "clar-2b", category: "clarification_decisive", target: "mercury", clarification: "the liquid metal used in old thermometers", guess: "the planet closest to the sun", language: "en", expect: "incorrect", pair: "clar-2a" },

  // --- 10. multi_candidate — always incorrect -------------------------------
  { id: "multi-1", category: "multi_candidate", target: "hammer", clarification: "a claw hammer in my toolbox", guess: "either a hammer or a screwdriver", language: "en", expect: "incorrect", note: "Contains the correct answer. Must still fail — one guess means one." },
  { id: "multi-2", category: "multi_candidate", target: "hammer", clarification: "a claw hammer in my toolbox", guess: "a hammer or a mallet", language: "en", expect: "incorrect" },
  { id: "multi-3", category: "multi_candidate", target: "hammer", clarification: "a claw hammer in my toolbox", guess: "hammer / wrench / pliers", language: "en", expect: "incorrect" },
  { id: "multi-4", category: "multi_candidate", target: "hammer", clarification: "a claw hammer in my toolbox", guess: "I think it's a hammer, though it could be a mallet", language: "en", expect: "incorrect", note: "Hedged prose form of the same exploit." },

  // --- 11. orthographic_variant --------------------------------------------
  { id: "orth-1", category: "orthographic_variant", target: "theatre", clarification: "the building where plays are performed", guess: "theater", language: "en", expect: "correct" },
  { id: "orth-2", category: "orthographic_variant", target: "bicycle", clarification: "a standard adult road bicycle", guess: "bycicle", language: "en", expect: "correct" },
  { id: "orth-3", category: "orthographic_variant", target: "fűnyíró", clarification: "a benzines fűnyíróm a fészerben", guess: "funyiro", language: "hu", expect: "correct", note: "Accents stripped — common when typing quickly." },
  { id: "orth-4", category: "orthographic_variant", target: "kalapács", clarification: "egy ácskalapács a szerszámosládámban", guess: "kalapácsot", language: "hu", expect: "correct", note: "Accusative inflection." },
  { id: "orth-5", category: "orthographic_variant", target: "fogantyú", clarification: "a fűnyíróm indítózsinórjának fogantyúja", guess: "fogantyút", language: "hu", expect: "correct", note: "The fixture that drove the INFLECTION IS IDENTITY rule. Accusative of the target. The Adjudicator originally returned incorrect at 0.95 while its own reasoning said the guess matched apart from grammatical case — a verdict committed before the analysis existed." },
  { id: "orth-6", category: "orthographic_variant", target: "fogantyú", clarification: "a fűnyíróm indítózsinórjának fogantyúja", guess: "fogó", language: "hu", expect: "incorrect", note: "INFLECTION GUARD — DERIVATION, NOT INFLECTION. Shares the fog- root with the target but is a different lexeme meaning pliers. If this passes, the rule has been read as 'same root' rather than 'same word, different grammatical form'." },
  { id: "orth-7", category: "orthographic_variant", target: "theatre", clarification: "the building where plays are performed", guess: "theatrical", language: "en", expect: "incorrect", note: "INFLECTION GUARD — DIFFERENT PART OF SPEECH. Same root, adjective rather than noun, so a different lexeme. English counterpart to orth-6." },

  // --- 12. cross_language ---------------------------------------------------
  { id: "lang-1", category: "cross_language", target: "Eiffel-torony", clarification: "a párizsi vastorony", guess: "the Eiffel Tower", language: "hu", expect: "correct" },
  { id: "lang-2", category: "cross_language", target: "the Eiffel Tower", clarification: "the iron tower in Paris", guess: "Eiffel-torony", language: "en", expect: "correct" },
  { id: "lang-3", category: "cross_language", target: "lawnmower", clarification: "my petrol push mower", guess: "fűnyíró", language: "en", expect: "correct" },
  { id: "lang-4", category: "cross_language", target: "Hold", clarification: "a Föld természetes holdja", guess: "the Moon", language: "hu", expect: "correct" },

  // --- 13. degenerate_guess -------------------------------------------------
  { id: "degen-1", category: "degenerate_guess", target: "hammer", clarification: "a claw hammer in my toolbox", guess: "", language: "en", expect: "incorrect", note: "Empty guess. The only fixture permitted an empty guess string." },
  { id: "degen-2", category: "degenerate_guess", target: "hammer", clarification: "a claw hammer in my toolbox", guess: "I don't know", language: "en", expect: "incorrect" },
  { id: "degen-3", category: "degenerate_guess", target: "hammer", clarification: "a claw hammer in my toolbox", guess: "the answer", language: "en", expect: "incorrect" },
  { id: "degen-4", category: "degenerate_guess", target: "hammer", clarification: "a claw hammer in my toolbox", guess: "the thing you're thinking of", language: "en", expect: "incorrect" },
  { id: "degen-5", category: "degenerate_guess", target: "hammer", clarification: "a claw hammer in my toolbox", guess: "something in your toolbox", language: "en", expect: "incorrect" },

  // --- 14. abstract_target --------------------------------------------------
  { id: "abs-1", category: "abstract_target", target: "democracy", clarification: "the system of government, not any particular country's version", guess: "rule by the people", language: "en", expect: "correct", pair: "abs-2" },
  { id: "abs-2", category: "abstract_target", target: "democracy", clarification: "the system of government, not any particular country's version", guess: "a political system", language: "en", expect: "incorrect", pair: "abs-1" },
  { id: "abs-3", category: "abstract_target", target: "gravity", clarification: "the physical force that pulls objects toward each other", guess: "the force of attraction between masses", language: "en", expect: "correct", pair: "abs-4" },
  { id: "abs-4", category: "abstract_target", target: "gravity", clarification: "the physical force that pulls objects toward each other", guess: "a force of nature", language: "en", expect: "incorrect", pair: "abs-3" },
  { id: "abs-5", category: "abstract_target", target: "the French Revolution", clarification: "the revolution that began in 1789", guess: "the 1789 revolution in France", language: "en", expect: "correct", pair: "abs-6" },
  { id: "abs-6", category: "abstract_target", target: "the French Revolution", clarification: "the revolution that began in 1789", guess: "a revolution", language: "en", expect: "incorrect", pair: "abs-5" },
];
