import { test } from "node:test";
import assert from "node:assert/strict";
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
