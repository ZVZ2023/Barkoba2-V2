import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  detectGuess,
  EXPLICIT_GUESS_FRAMES_HU,
  FLAG_THRESHOLD,
  WEIGHTS,
} from "../lib/guessDetector";
import {
  HU_DESCRIPTIVE_GUESSES,
  HU_EXPLICIT_GUESSES,
  HU_NARROWING_QUESTIONS,
} from "./fixtures/hungarian";

// ---------------------------------------------------------------------------
// The detector is the one M3 component that will be tuned by iteration rather
// than reasoned to correctness in one pass. These tests are the regression net
// that makes tuning safe: change a weight, run the suite, see exactly which
// side of the line moved. Both halves matter — a detector that flags nothing
// is useless, and one that flags every question makes the game unplayable.
// ---------------------------------------------------------------------------

const SHOULD_FLAG: Array<[string, string]> = [
  ["names a specific instance in the Composer's world", "Is it the handle on your lawnmower?"],
  ["explicit guess frame plus proper noun", "Are you thinking of the Eiffel Tower?"],
  ["bare proper noun pair", "Is it the Statue of Liberty?"],
  ["declared guess in prose", "My guess is a screwdriver."],
  ["addresses the secret directly", "Is your secret the color red?"],
  ["quotes a name verbatim", 'Is it "Kaposvár"?'],
  ["fully specified possession", "Is it the Ford Mustang in your garage?"],
  ["final-answer framing", "Is that my final answer, the red bicycle?"],
];

const SHOULD_NOT_FLAG: Array<[string, string]> = [
  ["broad category split", "Is it a physical object?"],
  ["property question", "Is it man-made?"],
  ["comparative with possessive", "Is it bigger than your hand?"],
  ["capability question", "Can it be held in one hand?"],
  ["behaviour question", "Does it have moving parts?"],
  ["second-person habit question", "Do you interact with it daily?"],
  ["hypothetical sizing", "Would it fit in a backpack?"],
  ["asks about the answer's category, not its identity", "Is the answer a type of tool?"],
  ["category framing survives an explicit frame", "Are you thinking of a category of animal?"],
  ["vague existential", "Is it something a person would carry?"],
  ["comparative scale", "Is it larger than a car?"],
];

test("flags questions that are functionally guesses", () => {
  for (const [label, question] of SHOULD_FLAG) {
    const result = detectGuess(question);
    assert.equal(
      result.flagged,
      true,
      `expected FLAG (${label}): ${question} — scored ${result.score}, matched [${result.matched.join(", ")}]`
    );
  }
});

test("does not flag legitimate narrowing questions", () => {
  for (const [label, question] of SHOULD_NOT_FLAG) {
    const result = detectGuess(question);
    assert.equal(
      result.flagged,
      false,
      `expected NO FLAG (${label}): ${question} — scored ${result.score}, matched [${result.matched.join(", ")}]`
    );
  }
});

test("empty and whitespace input is inert", () => {
  for (const input of ["", "   ", "\n"]) {
    const result = detectGuess(input);
    assert.equal(result.flagged, false);
    assert.equal(result.score, 0);
    assert.deepEqual(result.matched, []);
  }
});

test("reports which rules fired, for tuning", () => {
  const result = detectGuess("Is it the handle on your lawnmower?");
  assert.ok(result.matched.includes("specific_instance"));
  assert.ok(result.matched.includes("possessive_deictic"));
  assert.ok(result.score >= FLAG_THRESHOLD);
});

test("category hedges apply counter-evidence, not immunity", () => {
  // A hedge should pull a borderline question back under the line...
  assert.equal(detectGuess("Is the answer a type of tool?").flagged, false);
  // ...but must not be able to launder an unambiguous guess.
  const laundered = detectGuess("Is it a type of thing, namely the Eiffel Tower in Paris?");
  assert.equal(laundered.flagged, true, `scored ${laundered.score}`);
});

test("a sentence-initial capital is not treated as a proper noun", () => {
  const result = detectGuess("Water is involved, is it a liquid?");
  assert.ok(
    !result.matched.includes("proper_noun"),
    `matched [${result.matched.join(", ")}]`
  );
});

test("weights and threshold are exported for tuning", () => {
  assert.equal(typeof FLAG_THRESHOLD, "number");
  assert.ok(WEIGHTS.categoryHedge < 0, "hedge weight must be counter-evidence");
  assert.ok(WEIGHTS.explicitGuessFrame >= FLAG_THRESHOLD);
});

// ---------------------------------------------------------------------------
// Hungarian. game_language is detected per game, so the detector has to cope
// with HU play. Coverage is deliberately partial — see the language-coverage
// note in lib/guessDetector.ts. The gap is asserted below rather than hidden,
// so that closing it is a visible, deliberate change.
// ---------------------------------------------------------------------------

test("flags Hungarian explicit guess frames", () => {
  const cases = [
    "A tippem az Eiffel-torony.",
    "A megfejtés a fűnyíród fogantyúja?",
    "Arra gondolsz, hogy ez egy szerszám?",
    "A titkod a piros bicikli?",
  ];
  for (const question of cases) {
    const result = detectGuess(question);
    assert.equal(
      result.flagged,
      true,
      `expected FLAG: ${question} — scored ${result.score}, matched [${result.matched.join(", ")}]`
    );
  }
});

test("does not flag ordinary Hungarian narrowing questions", () => {
  const cases = [
    "Ez egy fizikai tárgy?",
    "Tárgy ez, vagy élőlény?",
    "Nagyobb ez, mint egy kenyérpirító?",
  ];
  for (const question of cases) {
    const result = detectGuess(question);
    assert.equal(
      result.flagged,
      false,
      `expected NO FLAG: ${question} — scored ${result.score}, matched [${result.matched.join(", ")}]`
    );
  }
});

test("M3.1: Hungarian descriptive guesses are now detected", () => {
  // This closes the gap M3 shipped with and documented. Hungarian marks
  // possession with a suffix ("fűnyíród" = "your lawnmower"), so the English
  // possessive and specific-instance rules could not fire and a descriptive
  // Hungarian guess scored as a free question.
  for (const question of HU_DESCRIPTIVE_GUESSES) {
    const result = detectGuess(question);
    assert.equal(
      result.flagged,
      true,
      `expected FLAG: ${question} — scored ${result.score}, matched [${result.matched.join(", ")}]`
    );
  }
});

test("Hungarian fixtures: explicit guesses flag", () => {
  for (const question of HU_EXPLICIT_GUESSES) {
    const result = detectGuess(question);
    assert.equal(
      result.flagged,
      true,
      `expected FLAG: ${question} — scored ${result.score}, matched [${result.matched.join(", ")}]`
    );
  }
});

test("Hungarian fixtures: narrowing questions stay clear", () => {
  for (const question of HU_NARROWING_QUESTIONS) {
    const result = detectGuess(question);
    assert.equal(
      result.flagged,
      false,
      `expected NO FLAG: ${question} — scored ${result.score}, matched [${result.matched.join(", ")}]`
    );
  }
});

test("hedge tiers: category vocabulary offsets a guess frame, bare copula does not", () => {
  // A STRONG hedge is real category vocabulary and can pull a guess frame back
  // under the line — the Racer is asking about a class of thing.
  assert.equal(detectGuess("Is the answer a type of tool?").flagged, false);
  assert.equal(detectGuess("Are you thinking of a category of animal?").flagged, false);

  // A WEAK hedge is only a copula or comparison frame. It appears just as
  // readily inside a guess, so it must not launder one.
  assert.equal(
    detectGuess("Arra gondolsz, hogy ez egy csavarhúzó?").flagged,
    true,
    "bare copula must not neutralise an explicit Hungarian guess frame"
  );
  assert.equal(detectGuess("Tippelek: ez egy kalapács.").flagged, true);

  // With no guess frame present, a weak hedge still does its job.
  assert.equal(detectGuess("Ez egy fizikai tárgy?").flagged, false);
  assert.equal(detectGuess("Is it a physical object?").flagged, false);
});

test("Hungarian frames are narrow enough to not fire on English play", () => {
  for (const frame of EXPLICIT_GUESS_FRAMES_HU) {
    assert.equal(
      frame.test("Is it a physical object made of metal?"),
      false,
      `Hungarian frame ${frame} matched an ordinary English question`
    );
  }
});

// ---------------------------------------------------------------------------
// V2.1.1.2 — candidate identification.
//
// The "My left ear" field test exposed the gap: "Is it the ear?" scored ZERO.
// No proper noun, no quotes, no possessive, no explicit frame — so it read as
// an ordinary narrowing question and cost one question rather than the one
// guess. That is the exact case this module's header says it exists to catch.
//
// The discriminator is DEFINITENESS, not interrogative form:
//   "Is it a vehicle?"    indefinite -> which CATEGORY. Not a guess.
//   "Is it the bicycle?"  definite   -> which ONE. Functionally a guess.
//
// Flagging does NOT consume the guess. It hands the turn to the existing
// intent-resolution step, which remains authoritative.
// ---------------------------------------------------------------------------

const CANDIDATE_QUESTIONS = [
  "Is it the ear?",
  "Is it the bicycle?",
  "Is that the handle?",
  "Is the target the ear?",
  "Is the answer the bicycle?",
  "Is it your left ear?",
  "A fül az?",
  "A bal füled az?",
  "A célpont a fül?",
  "A célpont az orr?",
  "Ez a fül?",
  // --- Field Test #3 production specimens, verbatim ------------------------
  //
  // Grok asked these four as ordinary questions in a real 20-question game and
  // was answered four times. Each scored 2 against a threshold of 3 —
  // proper_noun alone — because the vocabulary list held `célpont` but not
  // `cél`, the shortest and most common Hungarian word for the target and the
  // one the interface itself uses.
  //
  // The fixtures already contained "A célpont a fül?", the identical frame with
  // the word the rule knew, which is why the suite was green while production
  // let four functional guesses through. These are the real strings.
  "A cél a Microsoft?",
  "A cél az Apple?",
  "A cél a Google?",
  "A cél a Linux?",
  // Scored ZERO before the fix: a candidate that is not capitalised gets no
  // signal from any other rule, so the exposure was wider than the four
  // proper-noun cases suggested.
  "A cél a fül?",
];

const CATEGORY_QUESTIONS = [
  "Is it a sensory organ?",
  "Is it a vehicle?",
  "Is it made of metal?",
  "Is it alive?",
  "Is it the type of thing you own?",
  "Is it the kind of tool?",
  "Is it the sort of thing you use daily?",
  "Is it the same as a car?",
  "Is it bigger than your hand?",
  "Is it in your house?",
  "Does it have moving parts?",
  "Can it fit in a pocket?",
  "Ez egy jármű?",
  "Ez egy érzékszerv?",
  "Ez egy fajta fül?",
  "Fémből készült?",
  "Élőlény?",
  // --- Field Test #3 negative controls -------------------------------------
  //
  // The same opening words as the specimens above. These ask what the target
  // IS LIKE, not WHICH ONE it is, and adding `cél` to the vocabulary must not
  // start flagging them. The discriminator is the second article: a candidate
  // frame is "a cél A <name>", a property question is "a cél <predicate>".
  "A cél élőlény?",
  "A cél nagyobb egy kenyérpirítónál?",
  // "egy" is the category reading in Hungarian exactly as "a/an" is in English,
  // and must stay unflagged even directly after the newly-added word.
  "A cél egy jármű?",
  "A cél ember alkotta?",
  "A cél elfér egy kézben?",
  "A cél kisebb egy autónál?",
  "Ez valamilyen szerszám?",
];

for (const q of CANDIDATE_QUESTIONS) {
  test(`names a candidate, so it is flagged: ${q}`, () => {
    assert.equal(detectGuess(q).flagged, true, `${q} scored ${detectGuess(q).score}`);
  });
}

for (const q of CATEGORY_QUESTIONS) {
  test(`asks about a category or property, so it is not flagged: ${q}`, () => {
    assert.equal(detectGuess(q).flagged, false, `${q} scored ${detectGuess(q).score}`);
  });
}

test("a bare noun fragment is left alone", () => {
  // "Fül?" and "Élőlény?" are the same shape; nothing lexical separates a
  // candidate from a category here, and guessing would break the fragment
  // tolerance added in 0.9.5.0.
  assert.equal(detectGuess("Fül?").flagged, false);
  assert.equal(detectGuess("Élőlény?").flagged, false);
});

test("category vocabulary disqualifies the candidate shape outright", () => {
  // Not merely offset by the hedge: other rules can suppress hedging, so the
  // shape itself must not count when the noun phrase names a class.
  const r = detectGuess("Is it the kind of tool?");
  assert.ok(!r.matched.includes("candidate_identification"), r.matched.join(","));
  assert.equal(r.flagged, false);
});

// ---------------------------------------------------------------------------
// Field Test #3 — the specific rule, not merely the threshold.
// ---------------------------------------------------------------------------

const FIELD_TEST_3_SPECIMENS = [
  "A cél a Microsoft?",
  "A cél az Apple?",
  "A cél a Google?",
  "A cél a Linux?",
  "A cél a fül?",
] as const;

for (const q of FIELD_TEST_3_SPECIMENS) {
  test(`Field Test #3 — candidate_identification fires, not just the score: ${q}`, () => {
    const r = detectGuess(q);
    // Asserting the RULE matters more than asserting the flag. Four of these
    // scored 2 from proper_noun alone; a future weight change could lift them
    // over the threshold without the candidate rule ever firing, and the suite
    // would pass while the real defect returned.
    assert.ok(
      r.matched.includes("candidate_identification"),
      `${q} scored ${r.score} via ${r.matched.join(", ") || "nothing"}`
    );
    assert.equal(r.flagged, true);
  });
}

test("Field Test #3 — the fix is vocabulary, and the surrounding rule was correct", () => {
  // Same frame, same shape, only the target word differs. If these ever
  // diverge, the change was made in the wrong place.
  const withCel = detectGuess("A cél a Microsoft?");
  const withCelpont = detectGuess("A célpont a Microsoft?");
  assert.deepEqual(withCel.matched.sort(), withCelpont.matched.sort());
  assert.equal(withCel.score, withCelpont.score);
});

test("Field Test #3 — the second article is what separates a candidate from a property", () => {
  // The whole discriminator, stated as a test so it cannot be lost to a
  // well-meaning generalisation of the pattern later.
  assert.equal(detectGuess("A cél a fül?").flagged, true, "names which one");
  assert.equal(detectGuess("A cél egy fül?").flagged, false, "asks what kind");
  assert.equal(detectGuess("A cél élőlény?").flagged, false, "asks a property");
});

test("Field Test #3 — a flagged question is what makes G4 capture possible", () => {
  // pre_revision_question_text is assigned INSIDE the flagged branch of
  // /api/game/[id]/turn. It has stayed empty in production for exactly one
  // reason: nothing ever flagged. This pins the two halves together — the
  // specimens now flag, and the route captures on flag — without manufacturing
  // production data to prove it.
  const route = readFileSync("app/api/game/[id]/turn/route.ts", "utf8");
  const flaggedBranch = route.slice(
    route.indexOf("if (detection.flagged) {"),
    route.indexOf("// Step 5")
  );
  assert.ok(flaggedBranch.length > 0, "could not isolate the flagged branch");
  assert.match(
    flaggedBranch,
    /preRevisionQuestion = turn\.question_text/,
    "capture must live inside the flagged branch"
  );
  for (const q of FIELD_TEST_3_SPECIMENS) {
    assert.equal(detectGuess(q).flagged, true, `${q} must reach that branch`);
  }
});

test("flagging a candidate question does not by itself decide anything", () => {
  // The detector reports; resolveGuessIntent decides. This pins that the rule
  // added here changed detection only.
  const r = detectGuess("Is it the ear?");
  assert.equal(r.flagged, true);
  assert.ok(r.matched.includes("candidate_identification"));
});
