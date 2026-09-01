import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDuplicateQuestion,
  normalizeQuestionForDuplicateCheck,
  priorAskedQuestions,
  runWithDuplicateQuestionGuard,
} from "../lib/duplicateQuestionGuard";
import {
  BLACK_HOLE_QUESTIONS,
  HOLE_QUESTIONS,
  MARCALI_KNOWN_DUPLICATE_PAIRS,
  MARCALI_NAMED_IDENTITY_INDEXES,
  MARCALI_NEAR_DUPLICATE_INDEX,
  MARCALI_QUESTIONS,
} from "./fixtures/threeHumanGames";

// ---------------------------------------------------------------------------
// V2.8.x exact-duplicate question pre-emission guard.
//
// This is the historical/shadow validation the intervention ticket requires,
// run against the ACTUAL corpus strings from the three real games
// (test/fixtures/threeHumanGames.ts), plus unit tests of the two building
// blocks (normalization, priorAskedQuestions) and the generic retry loop
// (runWithDuplicateQuestionGuard) — the exact loop implementation
// app/api/game/[id]/turn/route.ts calls, exercised here with a mock producer
// so it needs no live KV/env.
// ---------------------------------------------------------------------------

// --- normalizeQuestionForDuplicateCheck ------------------------------------

test("normalization trims, collapses whitespace, and lowercases", () => {
  assert.equal(
    normalizeQuestionForDuplicateCheck("  A cél   Marcali?  "),
    "a cél marcali?"
  );
});

test("normalization does NOT strip diacritics", () => {
  assert.equal(
    normalizeQuestionForDuplicateCheck("Árvíztűrő tükörfúrógép?"),
    "árvíztűrő tükörfúrógép?"
  );
  assert.notEqual(
    normalizeQuestionForDuplicateCheck("Árvíztűrő tükörfúrógép?"),
    normalizeQuestionForDuplicateCheck("Arvizturo tukorfurogep?")
  );
});

// --- isDuplicateQuestion -----------------------------------------------

test("catches an exact match", () => {
  assert.equal(isDuplicateQuestion("Is it a physical object?", ["Is it a physical object?"]), true);
});

test("catches a whitespace-only variant", () => {
  assert.equal(
    isDuplicateQuestion("  Is it   a physical object?  ", ["Is it a physical object?"]),
    true
  );
});

test("catches a case-only variant", () => {
  assert.equal(
    isDuplicateQuestion("IS IT A PHYSICAL OBJECT?", ["Is it a physical object?"]),
    true
  );
});

test("does NOT collapse a diacritic difference into a match", () => {
  // "Kaposvár" (accented) vs "Kaposvar" (accent stripped) must NOT match.
  assert.equal(isDuplicateQuestion("A cél Kaposvar?", ["A cél Kaposvár?"]), false);
});

test("does NOT fire on a near-duplicate (different scope, different question)", () => {
  const q19 = "A cél egy megyeszékhely közelében található város?";
  const q31 = "A cél egy somogyi megyeszékhely közelében található település?";
  assert.equal(isDuplicateQuestion(q31, [q19]), false);
});

test("does not match a substring or a superset phrase", () => {
  assert.equal(
    isDuplicateQuestion("Is it a physical object made of metal?", ["Is it a physical object?"]),
    false
  );
});

// --- priorAskedQuestions -----------------------------------------------

test("priorAskedQuestions keeps only answered question-type entries, in order", () => {
  const qaLog = [
    { turn_type: "question" as const, question_text: "Q1?", composer_response: "YES" as const },
    { turn_type: "question" as const, question_text: "Q2?", composer_response: "NO" as const },
    // unanswered pending question — must be excluded
    { turn_type: "question" as const, question_text: "Q3?", composer_response: null },
    // a guess entry — never has question_text, must be excluded
    { turn_type: "guess" as const, question_text: null, composer_response: null },
  ];
  assert.deepEqual(priorAskedQuestions(qaLog), ["Q1?", "Q2?"]);
});

// ---------------------------------------------------------------------------
// Historical / shadow validation against the real corpus (detection only —
// this section does not exercise regeneration; that is covered below by the
// runWithDuplicateQuestionGuard tests).
// ---------------------------------------------------------------------------

/**
 * Replays a game's real question sequence turn by turn, treating each
 * question as a "candidate" checked against everything asked before it —
 * exactly what the guard does in production, in shadow (no regeneration).
 * Returns the 1-based indexes (matching the fixture's inline comments) where
 * isDuplicateQuestion would have fired.
 */
function shadowReplay(questions: readonly string[]): number[] {
  const fired: number[] = [];
  const askedSoFar: string[] = [];
  questions.forEach((q, i) => {
    if (isDuplicateQuestion(q, askedSoFar)) {
      fired.push(i + 1); // 1-based, matching the fixture comments
    }
    askedSoFar.push(q);
  });
  return fired;
}

test("MARCALI: catches all 3 known exact duplicates, nothing else", () => {
  const fired = shadowReplay(MARCALI_QUESTIONS);
  // The SECOND occurrence of each pair is what fires (the first is novel).
  const expectedFires = MARCALI_KNOWN_DUPLICATE_PAIRS.map(([, second]) => second).sort(
    (a, b) => a - b
  );
  assert.deepEqual(fired, expectedFires);
  assert.equal(fired.length, 3);
});

test("MARCALI: Q31 (near-duplicate of Q19/Q21) does not fire", () => {
  const askedBeforeQ31 = MARCALI_QUESTIONS.slice(0, MARCALI_NEAR_DUPLICATE_INDEX - 1);
  const q31 = MARCALI_QUESTIONS[MARCALI_NEAR_DUPLICATE_INDEX - 1]!; // fixture index, always present
  assert.equal(isDuplicateQuestion(q31, askedBeforeQ31), false);
});

test("MARCALI: named-identity questions (Kaposvár / Siófok / Marcali) never fire the guard", () => {
  for (const idx of MARCALI_NAMED_IDENTITY_INDEXES) {
    const askedBefore = MARCALI_QUESTIONS.slice(0, idx - 1);
    const candidate = MARCALI_QUESTIONS[idx - 1]!; // fixture index, always present
    assert.equal(
      isDuplicateQuestion(candidate, askedBefore),
      false,
      `question ${idx} ("${candidate}") should not have fired`
    );
  }
});

test("BLACK HOLE: zero false fires across the full 27-question transcript", () => {
  assert.deepEqual(shadowReplay(BLACK_HOLE_QUESTIONS), []);
});

test("HOLE: zero false fires across the full 35-question transcript", () => {
  assert.deepEqual(shadowReplay(HOLE_QUESTIONS), []);
});

// ---------------------------------------------------------------------------
// Actual regeneration validation — the SAME loop app/api/game/[id]/turn/
// route.ts calls, exercised here with a mock producer (no live KV/env
// needed; matches how this route's pieces are tested elsewhere per
// test/racerGuidance.test.ts's adapter-stub convention).
// ---------------------------------------------------------------------------

interface FakeCandidate {
  action: "question" | "guess" | "concede";
  question_text: string | null;
}

const extractQuestion = (c: FakeCandidate) => c;

test("regeneration: a duplicate is blocked, replacement is checked and accepted", async () => {
  const prior = ["A cél Marcali?"];
  const produced: FakeCandidate[] = [
    { action: "question", question_text: "A cél Marcali?" }, // duplicate — must be blocked
    { action: "question", question_text: "A cél Siófok?" }, // fresh — must be accepted
  ];
  let calls = 0;

  const result = await runWithDuplicateQuestionGuard<FakeCandidate, never>(
    prior,
    3,
    async () => {
      const candidate = produced[calls]!; // bounded by maxAttempts === produced.length in these tests
      calls += 1;
      return { ok: true, candidate };
    },
    extractQuestion
  );

  assert.equal(calls, 2, "the replacement must be generated, not the duplicate reused");
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") {
    assert.equal(result.candidate.question_text, "A cél Siófok?");
    assert.equal(result.attemptsMade, 2);
    assert.deepEqual(result.blockedQuestions, ["A cél Marcali?"]);
  }
});

test("regeneration: an ordinary non-duplicate question passes unchanged on the first attempt", async () => {
  const prior = ["Is it a living thing?"];
  const result = await runWithDuplicateQuestionGuard<FakeCandidate, never>(
    prior,
    3,
    async () => ({ ok: true, candidate: { action: "question", question_text: "Is it a physical object?" } }),
    extractQuestion
  );
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") {
    assert.equal(result.attemptsMade, 1);
    assert.deepEqual(result.blockedQuestions, []);
  }
});

test("regeneration: a near-duplicate passes unchanged (must not be treated as a duplicate)", async () => {
  const q19 = "A cél egy megyeszékhely közelében található város?";
  const q31 = "A cél egy somogyi megyeszékhely közelében található település?";
  const result = await runWithDuplicateQuestionGuard<FakeCandidate, never>(
    [q19],
    3,
    async () => ({ ok: true, candidate: { action: "question", question_text: q31 } }),
    extractQuestion
  );
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") assert.equal(result.attemptsMade, 1);
});

test("regeneration: a case/whitespace-only equivalent is correctly treated as a duplicate", async () => {
  const prior = ["A cél Marcali?"];
  const produced: FakeCandidate[] = [
    { action: "question", question_text: "  a cél   marcali? " }, // dup after normalization
    { action: "question", question_text: "A cél Siófok?" },
  ];
  let calls = 0;
  const result = await runWithDuplicateQuestionGuard<FakeCandidate, never>(
    prior,
    3,
    async () => {
      const candidate = produced[calls]!; // bounded by maxAttempts === produced.length in these tests
      calls += 1;
      return { ok: true, candidate };
    },
    extractQuestion
  );
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") assert.deepEqual(result.blockedQuestions, ["  a cél   marcali? "]);
});

test("regeneration: Hungarian diacritics remain significant through the full loop", async () => {
  const prior = ["A cél Kaposvár?"]; // accented
  const result = await runWithDuplicateQuestionGuard<FakeCandidate, never>(
    prior,
    3,
    // accent-stripped variant of the same word — must NOT be treated as a duplicate
    async () => ({ ok: true, candidate: { action: "question", question_text: "A cél Kaposvar?" } }),
    extractQuestion
  );
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") assert.equal(result.attemptsMade, 1);
});

test("regeneration: retry-cap exhaustion never leaks a duplicate", async () => {
  const prior = ["A cél Marcali?"];
  let calls = 0;
  const result = await runWithDuplicateQuestionGuard<FakeCandidate, never>(
    prior,
    3,
    async () => {
      calls += 1;
      // every attempt is the same duplicate — regeneration keeps failing
      return { ok: true, candidate: { action: "question", question_text: "A cél Marcali?" } };
    },
    extractQuestion
  );
  assert.equal(calls, 3, "must stop at the bounded cap, not loop forever");
  assert.equal(result.status, "exhausted");
  if (result.status === "exhausted") {
    assert.equal(result.attemptsMade, 3);
    assert.deepEqual(result.blockedQuestions, ["A cél Marcali?", "A cél Marcali?", "A cél Marcali?"]);
  }
});

test("regeneration: an attempt failure (not a duplicate) stops the loop immediately, without retrying", async () => {
  let calls = 0;
  const result = await runWithDuplicateQuestionGuard<FakeCandidate, string>(
    ["A cél Marcali?"],
    3,
    async () => {
      calls += 1;
      return { ok: false, failure: "racer_unavailable" };
    },
    extractQuestion
  );
  assert.equal(calls, 1, "a hard failure must not be retried as though it were a duplicate");
  assert.equal(result.status, "attempt_failed");
  if (result.status === "attempt_failed") {
    assert.equal(result.failure, "racer_unavailable");
    assert.equal(result.attemptsMade, 1);
  }
});

test("regeneration: a guess or concede action is never subject to the duplicate check", async () => {
  const prior = ["Is it a physical object?"];
  const result = await runWithDuplicateQuestionGuard<FakeCandidate, never>(
    prior,
    3,
    async () => ({ ok: true, candidate: { action: "guess", question_text: null } }),
    extractQuestion
  );
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") assert.equal(result.attemptsMade, 1);
});
