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
  // V2.8.5 REGRESSION — bare, unquoted. Named as a required example in the
  // Layer Two named-question-prohibition spec. Previously missed entirely:
  // the bare-candidate token class was ASCII-only `\w`, which does not
  // include "á" — the regex failed to match past it at all, rather than
  // merely truncating the capture. Fixed by extending the class with
  // Hungarian's accented letters (see BARE_CANDIDATE_EN's own doc).
  ["bare candidate with a Hungarian accented letter", "Is the target Kaposvár?"],
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

// ---------------------------------------------------------------------------
// Field Test #4 — the English indefinite-article defect.
//
// `2.5.0.5` flagged ten of roughly twenty turns in a production English game.
// Not one was a guess. `CANDIDATE_IDENTIFICATION_EN` pattern 2 accepted
// `(?:a|an|the)`, so an ordinary category question phrased as "Is the target
// a X?" scored +3 while the identical question phrased "Is it a X?" scored −2.
//
// These are the production strings, verbatim. They are the regression net for
// the correction: the rule must not fire on any of them, and — asserted
// separately below — must still fire on the definite form.
// ---------------------------------------------------------------------------

const FIELD_TEST_4_SPECIMENS = [
  "Is the target a physical object?",
  "Is the target a person?",
  "Is the target a concept or idea?",
  "Is the target a natural phenomenon?",
  "Is the target a company or corporation?",
] as const;

for (const q of FIELD_TEST_4_SPECIMENS) {
  test(`Field Test #4 — indefinite article is the category reading, not a guess: ${q}`, () => {
    const r = detectGuess(q);
    // Assert the RULE, not merely the flag. A weight change could drop these
    // under the threshold while candidate_identification still fired, and the
    // defect — a category question being treated as a naming one — would
    // survive invisibly until the next scoring change lifted it back over.
    assert.ok(
      !r.matched.includes("candidate_identification"),
      `${q} scored ${r.score} via ${r.matched.join(", ") || "nothing"}`
    );
    assert.equal(r.flagged, false, `${q} scored ${r.score}`);
  });
}

test("Field Test #4 — phrasing must not change the verdict on the same question", () => {
  // The defect in one line: these two ask the identical thing. Before the
  // correction they scored −2 and +3 respectively.
  const short = detectGuess("Is it a physical object?");
  const framed = detectGuess("Is the target a physical object?");
  assert.equal(short.flagged, false);
  assert.equal(framed.flagged, false);
  assert.ok(
    !framed.matched.includes("candidate_identification"),
    `matched [${framed.matched.join(", ")}]`
  );
});

test("Field Test #4 — the correction removed the indefinite reading only", () => {
  // Pattern 2 still has a job. If this ever goes quiet, the fix was made by
  // deleting the rule rather than by narrowing it.
  for (const q of [
    "Is the target the ear?",
    "Is the answer the bicycle?",
    "Was the word the handle?",
  ]) {
    const r = detectGuess(q);
    assert.ok(
      r.matched.includes("candidate_identification"),
      `${q} scored ${r.score} via ${r.matched.join(", ") || "nothing"}`
    );
  }
});

test("V2.6 — pattern 2 accepts the possessives, as pattern 1 always has", () => {
  // The second, opposite defect found while correcting the first. Pattern 1's
  // comment has always said "the" and the possessives are equally identifying;
  // only pattern 1 acted on it. Before this change "Is the target your left
  // ear?" scored 1 and did not flag — a named instance read as an ordinary
  // narrowing question.
  for (const q of [
    "Is the target your left ear?",
    "Is the answer your bicycle?",
    "Was the word his name?",
  ]) {
    const r = detectGuess(q);
    assert.ok(
      r.matched.includes("candidate_identification"),
      `${q} scored ${r.score} via ${r.matched.join(", ") || "nothing"}`
    );
    assert.equal(r.flagged, true, `${q} scored ${r.score}`);
  }
});

test("V2.6 — widening the determiner set did not reopen the indefinite reading", () => {
  // The two changes in this commit pull in opposite directions. This pins that
  // the widening stopped at the possessives and did not let `a|an` back in.
  for (const q of FIELD_TEST_4_SPECIMENS) {
    assert.ok(
      !detectGuess(q).matched.includes("candidate_identification"),
      `indefinite reading returned: ${q}`
    );
  }
});

test("Field Test #4 — pattern 1 and pattern 2 now share one discriminator", () => {
  // The doctrine, pinned as a test: definiteness decides, in both frames.
  // Pattern 1 already obeyed it; pattern 2 does now. If a later change makes
  // them disagree again, this is the assertion that fails.
  const definite = ["Is it the bicycle?", "Is the target the bicycle?"];
  const indefinite = ["Is it a bicycle?", "Is the target a bicycle?"];
  for (const q of definite) {
    assert.ok(
      detectGuess(q).matched.includes("candidate_identification"),
      `expected candidate_identification: ${q}`
    );
  }
  for (const q of indefinite) {
    assert.ok(
      !detectGuess(q).matched.includes("candidate_identification"),
      `expected NO candidate_identification: ${q}`
    );
  }
});

// ---------------------------------------------------------------------------
// V2.6 — the bare proper-noun candidate.
//
// Field-observed in production at 2.6.3.0 / racer/2.6.0. A Grok Racer spent
// four consecutive question slots naming candidate LLMs; every one scored 2
// (proper_noun alone) against a threshold of 3, none flagged, the single guess
// entitlement was never consumed, and the final YES confirmed the target as a
// free question.
//
// Third occurrence of "the vocabulary was one word short" — §31 (Hungarian
// `cél`), §32 (English indefinite article), and now this. The asymmetry that
// makes it visible:
//
//     Is the answer Grok?   5, flagged   (`is the answer` is an explicit frame)
//     Is the target Grok?   2, missed    (`target` has none)
// ---------------------------------------------------------------------------

const FIELD_LLM_SPECIMENS = [
  "Is the target GPT-4?",
  "Is the target Claude?",
  "Is the target Llama?",
  "Is the target Grok?",
] as const;

for (const q of FIELD_LLM_SPECIMENS) {
  test(`V2.6 — bare candidate identity is flagged: ${q}`, () => {
    const r = detectGuess(q);
    // Assert the RULE, not only the flag. These already scored 2 from
    // proper_noun; a future weight change could lift them over the threshold
    // without candidate_identification ever firing, and the suite would pass
    // while the real defect returned. That is exactly the trap §31 fell into.
    assert.ok(
      r.matched.includes("candidate_identification"),
      `${q} scored ${r.score} via ${r.matched.join(", ") || "nothing"}`
    );
    assert.equal(r.flagged, true);
  });
}

test("V2.6 — the frame covers the deictic forms too, not just 'the target'", () => {
  for (const q of ["Is it Grok?", "Is that Claude?", "Is this Tesla?", "Was the answer Linux?"]) {
    assert.ok(
      detectGuess(q).matched.includes("candidate_identification"),
      `expected candidate_identification: ${q}`
    );
  }
});

test("V2.6 — a digit settles it, ahead of any stopword list", () => {
  // No nationality, language or religion contains a digit, so a versioned
  // model name is a name with certainty and can never be suppressed by a list
  // entry added later.
  for (const q of ["Is the target GPT-4?", "Is the target GPT-3.5?", "Is the target Llama-2?"]) {
    assert.equal(detectGuess(q).flagged, true, q);
  }
});

test("V2.6 — capitalised PREDICATES are not candidates and must not flag", () => {
  // The false-positive class the rule is narrowed against. Each of these is a
  // legitimate discovery question that happens to capitalise its predicate.
  for (const q of [
    "Is the target American?",
    "Is the target Hungarian?",
    "Is the target Japanese?",
    "Is the target Chinese?",
    "Is the target Christian?",
    "Is the target Jewish?",
    "Is the target European?",
    "Is the target African?",
    "Is it Western?",
    "Is the target Nordic?",
  ]) {
    const r = detectGuess(q);
    assert.equal(
      r.matched.includes("candidate_identification"),
      false,
      `${q} must not read as naming a candidate — scored ${r.score}`
    );
    assert.equal(r.flagged, false, `${q} scored ${r.score}`);
  }
});

test("V2.6 — the field-test control questions stay clear", () => {
  // The discovery questions the correction was required to preserve, verbatim.
  for (const q of [
    "Is the target alive?",
    "Is the target a language model?",
    "Is it developed by xAI?",
    "Is the target open source?",
  ]) {
    assert.equal(detectGuess(q).flagged, false, `${q} must remain a free question`);
  }
});

test("V2.6 — lowercase after the frame is a predicate, and capitalisation is the whole signal", () => {
  // The discriminator, stated as a test so it cannot be lost to a
  // well-meaning case-insensitive "tidy-up" of the pattern later.
  assert.equal(detectGuess("Is the target Grok?").flagged, true, "names one");
  assert.equal(detectGuess("Is the target grok?").flagged, false, "reads as a predicate");
});

test("V2.6 — the gap was exactly one token wide, and multi-word names already flagged", () => {
  // Why the rule is restricted to a single token: a two-word name already
  // scored 3 on proper_noun + proper_noun_multiple before this change. A
  // broader rule would have added false-positive surface for nothing.
  for (const q of ["Is the target Wolfram Alpha?", "Is the target Eiffel Tower?"]) {
    const r = detectGuess(q);
    assert.ok(r.matched.includes("proper_noun_multiple"), q);
    assert.equal(r.flagged, true, q);
  }
});

test("V2.6 — category vocabulary still disqualifies the shape", () => {
  // The new rule sits inside the same namesACategory guard as its siblings
  // rather than carrying its own exception.
  const r = detectGuess("Is it the kind of Grok?");
  assert.equal(r.matched.includes("candidate_identification"), false, r.matched.join(","));
});

test("V2.6 — the Hungarian rules are untouched by the English correction", () => {
  // The Hungarian sibling already caught this class ("A cél a Grok?" scores 5)
  // because Hungarian uses a definite article with proper nouns. Nothing here
  // should have moved it in either direction.
  assert.equal(detectGuess("A cél a Grok?").flagged, true);
  assert.equal(detectGuess("A cél a Microsoft?").flagged, true);
  assert.equal(detectGuess("A cél élőlény?").flagged, false);
  assert.equal(detectGuess("A cél egy jármű?").flagged, false);
});

test("flagging a candidate question does not by itself decide anything", () => {
  // The detector reports; resolveGuessIntent decides. This pins that the rule
  // added here changed detection only.
  const r = detectGuess("Is it the ear?");
  assert.equal(r.flagged, true);
  assert.ok(r.matched.includes("candidate_identification"));
});
