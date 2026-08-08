import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveResult,
  expectedResolveCalls,
  needsAdjudication,
  needsIntegrityReview,
} from "../lib/resolveResult";

// ---------------------------------------------------------------------------
// This module decides who won. Every reachable row of the table is asserted
// here, and every unreachable combination is asserted to throw rather than
// quietly return something plausible.
// ---------------------------------------------------------------------------

test("table row: correct guess wins, integrity never consulted", () => {
  assert.equal(
    deriveResult({ finalAction: "guess", adjudicator: "correct", integrity: null }),
    "racer_correct"
  );
});

test("table row: incorrect guess against a clean transcript is a Composer win", () => {
  assert.equal(
    deriveResult({ finalAction: "guess", adjudicator: "incorrect", integrity: "upheld" }),
    "racer_incorrect"
  );
});

test("table row: incorrect guess against a violated transcript flips to the Racer", () => {
  assert.equal(
    deriveResult({ finalAction: "guess", adjudicator: "incorrect", integrity: "violated" }),
    "racer_win_integrity_violation"
  );
});

test("table row: concede against a clean transcript is a Composer win", () => {
  assert.equal(
    deriveResult({ finalAction: "concede", adjudicator: null, integrity: "upheld" }),
    "composer_win_integrity_upheld"
  );
});

test("table row: concede against a violated transcript flips to the Racer", () => {
  assert.equal(
    deriveResult({ finalAction: "concede", adjudicator: null, integrity: "violated" }),
    "racer_win_integrity_violation"
  );
});

test("every GameResult value is reachable by exactly one path", () => {
  const reached = [
    deriveResult({ finalAction: "guess", adjudicator: "correct", integrity: null }),
    deriveResult({ finalAction: "guess", adjudicator: "incorrect", integrity: "upheld" }),
    deriveResult({ finalAction: "guess", adjudicator: "incorrect", integrity: "violated" }),
    deriveResult({ finalAction: "concede", adjudicator: null, integrity: "upheld" }),
  ];
  assert.deepEqual(
    [...new Set(reached)].sort(),
    [
      "composer_win_integrity_upheld",
      "racer_correct",
      "racer_incorrect",
      "racer_win_integrity_violation",
    ]
  );
});

test("skip logic: adjudication runs only on a guess", () => {
  assert.equal(needsAdjudication("guess"), true);
  assert.equal(needsAdjudication("concede"), false);
  assert.equal(needsAdjudication("question"), false);
  assert.equal(needsAdjudication(null), false);
});

test("skip logic: Integrity Review is NOT run on a correct guess", () => {
  // The locked decision is to skip the call entirely, not to run it and
  // discard the verdict. This assertion is the cost decision, in code.
  assert.equal(needsIntegrityReview("guess", "correct"), false);
  assert.equal(needsIntegrityReview("guess", "incorrect"), true);
  assert.equal(needsIntegrityReview("concede", null), true);
});

test("cost accounting: a correct guess spends one strong call, not two", () => {
  assert.equal(expectedResolveCalls("guess", "correct"), 1);
  assert.equal(expectedResolveCalls("guess", "incorrect"), 2);
  assert.equal(expectedResolveCalls("concede", null), 1);
});

test("running Integrity Review on a correct guess is a hard error, not a shrug", () => {
  assert.throws(
    () => deriveResult({ finalAction: "guess", adjudicator: "correct", integrity: "upheld" }),
    /skipped entirely, not run and discarded/
  );
});

test("undefined combinations throw rather than defaulting", () => {
  assert.throws(
    () => deriveResult({ finalAction: "guess", adjudicator: null, integrity: "upheld" }),
    /requires an adjudicator verdict/
  );
  assert.throws(
    () => deriveResult({ finalAction: "guess", adjudicator: "incorrect", integrity: null }),
    /requires an integrity verdict/
  );
  assert.throws(
    () => deriveResult({ finalAction: "concede", adjudicator: "correct", integrity: "upheld" }),
    /must not run on a concede/
  );
  assert.throws(
    () => deriveResult({ finalAction: "concede", adjudicator: null, integrity: null }),
    /requires an integrity verdict/
  );
  assert.throws(
    () => deriveResult({ finalAction: null, adjudicator: null, integrity: null }),
    /cannot resolve a game/
  );
  assert.throws(
    () => deriveResult({ finalAction: "question", adjudicator: null, integrity: null }),
    /cannot resolve a game/
  );
});
