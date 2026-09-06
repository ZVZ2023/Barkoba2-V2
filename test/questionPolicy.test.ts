import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { checkQuestionPolicy, QUESTION_POLICY_REJECTION_MESSAGE } from "../lib/questionPolicy";
import { runWithDuplicateAndPolicyQuestionGuard } from "../lib/duplicateQuestionGuard";
import { createGame, getGame } from "../lib/gameStore";
import { POST as askPOST } from "../app/api/game/[id]/ask/route";
import { POST as hhTurnPOST } from "../app/api/game/[id]/hh/turn/route";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();
process.env.ANTHROPIC_API_KEY = "test-key";

// ---------------------------------------------------------------------------
// V2.8.7.4 — DEFECT 3: the universal no-spelling rule.
//
// Field report: production accepted and answered "The target first letter in
// Hungarian starts with F?" — a Racer question must never seek information
// about the target's written/spoken NAME, in any direction, difficulty, or
// mode. Submitting a final GUESS of the name remains allowed.
//
// lib/questionPolicy.ts is the ONE centralized policy layer; this file
// proves: (1) the pure classifier's coverage and its one honestly-disclosed
// gap, (2) the AI Racer's regeneration loop (runWithDuplicateAndPolicyQuestionGuard,
// the exact function app/api/game/[id]/turn/route.ts calls — same testing
// philosophy as test/duplicateQuestionGuard.test.ts's own "exact loop
// implementation, not a route copy" doc), and (3) both human-submission
// routes reject before consuming a question, with a localized message,
// using the real route handlers (this codebase's own established technique
// — see test/askReliability.test.ts). No paid gameplay anywhere in this
// file: the classifier is pure, and the AI-Racer path is tested against the
// guard function directly rather than a live/mocked provider call.
// ---------------------------------------------------------------------------

const QUESTION_POLICY_SRC = readFileSync("lib/questionPolicy.ts", "utf8");
const TURN_ROUTE_SRC = readFileSync("app/api/game/[id]/turn/route.ts", "utf8");
const RACER_PROMPT_SRC = readFileSync("lib/prompts/racer.ts", "utf8");

// ---------------------------------------------------------------------------
// 1. The pure classifier — every prohibited category, plus legitimate
//    property questions that must never be blocked, plus final guesses
//    (which are never even routed through this classifier at all — see the
//    source-contract test at the bottom confirming guess/concede bypass it).
// ---------------------------------------------------------------------------

test("first/last letter and letter-at-position are blocked", () => {
  for (const q of [
    "The target first letter in Hungarian starts with F?", // the exact field example
    "Does its name start with the letter F?",
    "What is the last letter?",
    "Is the third letter a vowel?",
    "Az első betűje F?",
    "Hányadik betűje az 's'?",
  ]) {
    assert.equal(checkQuestionPolicy(q).allowed, false, q);
    assert.equal(checkQuestionPolicy(q).violation, "letter_position", q);
  }
});

test("contains-a-letter questions are blocked", () => {
  for (const q of ["Does the name contain the letter Q?", "Tartalmazza a nevében az 'a' betűt?"]) {
    assert.equal(checkQuestionPolicy(q).allowed, false, q);
    assert.equal(checkQuestionPolicy(q).violation, "letter_contains", q);
  }
});

test("letter/character count questions are blocked", () => {
  for (const q of [
    "How many letters does its name have?",
    "What is the character count?",
    "Hány betűből áll a neve?",
  ]) {
    assert.equal(checkQuestionPolicy(q).allowed, false, q);
    assert.equal(checkQuestionPolicy(q).violation, "letter_count", q);
  }
});

test("spelling questions, in any language, are blocked", () => {
  for (const q of ["How do you spell it?", "Is the spelling unusual?", "Hogyan kell írni a nevét?"]) {
    assert.equal(checkQuestionPolicy(q).allowed, false, q);
    assert.equal(checkQuestionPolicy(q).violation, "spelling", q);
  }
});

test("prefix/suffix/initials/abbreviation/acronym questions are blocked", () => {
  for (const q of [
    "Does it have a common prefix?",
    "Does the name end in a particular suffix?",
    "Is it an acronym?",
    "Is it an abbreviation?",
    "Are its initials well known?",
  ]) {
    assert.equal(checkQuestionPolicy(q).allowed, false, q);
    assert.equal(checkQuestionPolicy(q).violation, "affix_or_acronym", q);
  }
});

test("syllable-count questions are blocked", () => {
  assert.equal(checkQuestionPolicy("How many syllables does the word have?").allowed, false);
  assert.equal(checkQuestionPolicy("Hány szótagú a neve?").allowed, false);
});

test("pronunciation/phonetic questions are blocked", () => {
  assert.equal(checkQuestionPolicy("How is it pronounced?").allowed, false);
  assert.equal(checkQuestionPolicy("Hogyan kell kiejteni?").allowed, false);
});

test("rhyme questions are blocked", () => {
  assert.equal(checkQuestionPolicy("Does it rhyme with 'cat'?").allowed, false);
  assert.equal(checkQuestionPolicy("Rímel a 'macska' szóra?").allowed, false);
});

test("an explicit \"what is it called in [language]\" naming probe is blocked", () => {
  assert.equal(checkQuestionPolicy("What is it called in English?").allowed, false);
  assert.equal(checkQuestionPolicy("What is its name in French?").allowed, false);
});

test("legitimate semantic/property questions, unrelated to the target's name, are never blocked", () => {
  for (const q of [
    "Is it alive?",
    "Is it bigger than a breadbox?",
    "Does it live in water?",
    "Is it used in a kitchen?",
    "Is it a type of bird?",
    "Does it have four legs?",
    "Is it man-made?",
    "Van szárnya?",
    "Milyen színű?",
    "Repül?",
    "Konyhai eszköz?",
    "Ehető?",
  ]) {
    assert.equal(checkQuestionPolicy(q).allowed, true, q);
  }
});

test("KNOWN LIMITATION, disclosed rather than silently unhandled: an indirect paraphrase engineered to reconstruct the name without using any of the prohibited words is not reliably caught by this deterministic classifier", () => {
  // Not asserting a specific outcome here -- this documents the gap that
  // lib/questionPolicy.ts's own module doc states plainly: no regex (and no
  // single-question semantic check) can catch a SEQUENCE of indirect
  // questions engineered to spell out a name letter-by-letter without ever
  // using a word this classifier watches for. The module doc is the
  // deliverable; this test just proves the doc's claim is actually stated,
  // not merely true "by accident of nobody checking".
  assert.match(
    QUESTION_POLICY_SRC,
    /CANNOT reliably catch an indirect,\s*\n\/\/ multi-question paraphrase/
  );
});

// ---------------------------------------------------------------------------
// 2. AI-generated violation and regeneration -- the exact function
//    app/api/game/[id]/turn/route.ts calls, exercised with a mock producer.
// ---------------------------------------------------------------------------

interface FakeCandidate {
  action: "question" | "guess" | "concede";
  question_text: string | null;
}
const extractQuestion = (c: FakeCandidate) => c;

test("AI-generated policy violation: rejected and regenerated, no question consumed for the rejected attempt", async () => {
  const produced: FakeCandidate[] = [
    { action: "question", question_text: "Does its name start with the letter F?" }, // violates -- must be blocked
    { action: "question", question_text: "Is it typically found outdoors?" }, // compliant -- must be accepted
  ];
  let calls = 0;

  const result = await runWithDuplicateAndPolicyQuestionGuard<FakeCandidate, never>(
    [],
    3,
    async () => {
      const candidate = produced[calls]!;
      calls += 1;
      return { ok: true, candidate };
    },
    extractQuestion
  );

  assert.equal(calls, 2, "a compliant replacement must be generated");
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") {
    assert.equal(result.candidate.question_text, "Is it typically found outdoors?");
    assert.deepEqual(result.blockedQuestions, ["Does its name start with the letter F?"]);
  }
});

test("bounded retries: if every attempt violates policy, the guard fails safely (exhausted), never emitting a violation and never looping forever", async () => {
  const result = await runWithDuplicateAndPolicyQuestionGuard<FakeCandidate, never>(
    [],
    3,
    async () => ({ ok: true, candidate: { action: "question", question_text: "How is it pronounced?" } }),
    extractQuestion
  );
  assert.equal(result.status, "exhausted");
  assert.equal(result.attemptsMade, 3);
  assert.equal(result.blockedQuestions.length, 3);
});

test("a duplicate AND a policy violation are both checked in the SAME loop -- no compounded retry budget", async () => {
  const prior = ["Is it alive?"];
  const produced: FakeCandidate[] = [
    { action: "question", question_text: "Is it alive?" }, // duplicate
    { action: "question", question_text: "How many syllables in its name?" }, // policy violation
    { action: "question", question_text: "Does it live in water?" }, // compliant
  ];
  let calls = 0;
  const result = await runWithDuplicateAndPolicyQuestionGuard<FakeCandidate, never>(
    prior,
    3,
    async () => {
      const candidate = produced[calls]!;
      calls += 1;
      return { ok: true, candidate };
    },
    extractQuestion
  );
  assert.equal(result.status, "accepted");
  assert.equal(calls, 3);
  if (result.status === "accepted") {
    assert.equal(result.candidate.question_text, "Does it live in water?");
  }
});

test("a guess is never subject to the policy check -- final guesses remain allowed even if their text would otherwise match a rule", async () => {
  const result = await runWithDuplicateAndPolicyQuestionGuard<FakeCandidate, never>(
    [],
    3,
    async () => ({ ok: true, candidate: { action: "guess", question_text: "How is it pronounced?" } }),
    extractQuestion
  );
  // action !== "question", so the (accidentally letter-shaped) text on a
  // GUESS is never even examined by the policy check -- see
  // runWithRejectionGuard's own `action === "question"` gate.
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") assert.equal(result.attemptsMade, 1);
});

test("app/api/game/[id]/turn/route.ts calls the COMBINED guard, not the plain duplicate-only one", () => {
  assert.match(TURN_ROUTE_SRC, /from "@\/lib\/duplicateQuestionGuard"/);
  assert.match(TURN_ROUTE_SRC, /runWithDuplicateAndPolicyQuestionGuard</);
  assert.doesNotMatch(TURN_ROUTE_SRC, /runWithDuplicateQuestionGuard</, "must not still call the duplicate-only guard");
});

test("lib/prompts/racer.ts: the RED FLAGS prompt-level guidance (the model's own, necessarily imperfect first line of defense) still names spelling/letters/syllables/pronunciation, and the module doc states the mechanical layer is now authoritative", () => {
  assert.match(
    RACER_PROMPT_SRC,
    /Investigates spelling, letters, syllables, or pronunciation instead of meaning and properties/
  );
  assert.match(RACER_PROMPT_SRC, /runWithDuplicateAndPolicyQuestionGuard/);
});

// ---------------------------------------------------------------------------
// 3. Human submission rejection -- both routes, real handlers, no question
//    consumed, localized message.
// ---------------------------------------------------------------------------

const RACER = testPlayerId("e");

function askReq(gameId: string, body: unknown, playerId: string) {
  const json = JSON.stringify(body);
  return new NextRequest(`http://localhost/api/game/${gameId}/ask`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
      "x-bk-player": playerId,
    },
    body: json,
  });
}

test("human Racer -> AI Composer (/ask): a policy-violating question is rejected before consuming a question, with a localized message, and the game is otherwise untouched", async () => {
  const gameId = randomUUID();
  await createGame(gameId, {
    phase: "questioning",
    composer_kind: "ai",
    racer_kind: "human",
    max_questions: 20,
    game_language: "hu",
    racer_player_id: RACER,
  });

  const res = await askPOST(
    askReq(gameId, { question: "Az első betűje F?", expected_revision: 0 }, RACER),
    { params: { id: gameId } }
  );
  const data = await res.json();

  assert.equal(res.status, 422);
  assert.equal(data.error, "question_policy_violation");
  assert.equal(data.message, QUESTION_POLICY_REJECTION_MESSAGE.hu);

  const canonical = await getGame(gameId);
  assert.equal(canonical!.qa_log.length, 0, "no entry was ever created");
  assert.equal(canonical!.question_count, 0, "no question was consumed");
});

test("human Racer -> AI Composer (/ask): an English game gets the English message", async () => {
  const gameId = randomUUID();
  await createGame(gameId, {
    phase: "questioning",
    composer_kind: "ai",
    racer_kind: "human",
    max_questions: 20,
    game_language: "en",
    racer_player_id: RACER,
  });
  const res = await askPOST(
    askReq(gameId, { question: "How many syllables does its name have?", expected_revision: 0 }, RACER),
    { params: { id: gameId } }
  );
  const data = await res.json();
  assert.equal(res.status, 422);
  assert.equal(data.message, QUESTION_POLICY_REJECTION_MESSAGE.en);
});

test("human Racer -> AI Composer (/ask): a compliant question is unaffected -- still reaches the ordinary out-of-questions/secret checks, never the policy rejection", async () => {
  const gameId = randomUUID();
  await createGame(gameId, {
    phase: "questioning",
    composer_kind: "ai",
    racer_kind: "human",
    max_questions: 20,
    game_language: "en",
    racer_player_id: RACER,
  });
  // No secret was ever stored for this test game (see test/questionEditUx.test.ts's
  // own note on why -- no test file may import lib/secretStore.ts). A
  // compliant question reaches THAT honest 410, never the policy rejection --
  // proving the policy check does not fire on ordinary property questions.
  const res = await askPOST(
    askReq(gameId, { question: "Is it alive?", expected_revision: 0 }, RACER),
    { params: { id: gameId } }
  );
  const data = await res.json();
  assert.equal(res.status, 410);
  assert.equal(data.error, "secret_unavailable");
});

function hhTurnReq(gameId: string, body: unknown, playerId: string) {
  const json = JSON.stringify(body);
  return new NextRequest(`http://localhost/api/game/${gameId}/hh/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
      "x-bk-player": playerId,
    },
    body: json,
  });
}

test("human/human (/hh/turn): a policy-violating question is rejected before delivery to the Composer and before consuming a question", async () => {
  const gameId = randomUUID();
  const composer = testPlayerId("f");
  await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "human",
    max_questions: 20,
    game_language: "hu",
    composer_player_id: composer,
    racer_player_id: RACER,
  });

  const res = await hhTurnPOST(
    hhTurnReq(gameId, { action: "question", question: "Hány betűből áll a neve?", expected_revision: 0 }, RACER),
    { params: { id: gameId } }
  );
  const data = await res.json();

  assert.equal(res.status, 422);
  assert.equal(data.error, "question_policy_violation");
  assert.equal(data.message, QUESTION_POLICY_REJECTION_MESSAGE.hu);

  const canonical = await getGame(gameId);
  assert.equal(canonical!.qa_log.length, 0, "the question never reached the Composer");
  assert.equal(canonical!.question_count, 0, "no question was consumed");
});
