import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePhaseOneState } from "../lib/phaseOne";
import type { ComposerAnswer, GameLanguage, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.4 — Runtime Phase One v6.1. Pure state-machine tests: no route, no
// Redis, no provider, no fetch. lib/phaseOne.ts's derivePhaseOneState is the
// entire feature's decision logic, so it is exercised directly here exactly
// as lib/rewind.ts and lib/duplicateQuestionGuard.ts already are.
// ---------------------------------------------------------------------------

// Explicit fixed-length tuples (not inferred string[]) so a LITERAL index
// (spine[0]..spine[4]) type-checks as `string`, not `string | undefined`,
// under this project's noUncheckedIndexedAccess. A variable index (spine[i])
// still needs its own `!` at the call site -- TS cannot bound-check that.
const EN = {
  spine: [
    "Is it alive?",
    "Is it a physical thing or substance?",
    "Is it a place or location?",
    "Is it an event or occurrence?",
    "Is it primarily non-physical or informational?",
  ] as const satisfies readonly [string, string, string, string, string],
  specificity: {
    living: "Is it one particular living being?",
    physical: "Is it one particular physical item or substance?",
    place: "Is it one particular place?",
    event: "Is it one particular event?",
  },
};

const HU = {
  spine: [
    "Élő?",
    "Fizikai dolog vagy anyag?",
    "Hely vagy helyszín?",
    "Esemény vagy történés?",
    "Elsősorban nem fizikai vagy információs természetű?",
  ] as const satisfies readonly [string, string, string, string, string],
  specificity: {
    living: "Egy konkrét élőlényre gondoltál?",
    physical: "Egy konkrét fizikai dologra vagy anyagra gondoltál?",
    place: "Egy konkrét helyre gondoltál?",
    event: "Egy konkrét eseményre gondoltál?",
  },
};

let idCounter = 0;

function entry(questionText: string, answer: ComposerAnswer | null, overrides: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  idCounter += 1;
  return {
    id: `t${idCounter}`,
    turn_index: idCounter,
    turn_type: "question",
    racer_output_raw: "",
    question_text: questionText,
    guess_text: null,
    composer_response: answer,
    ambiguous_explanation: null,
    guess_detector_flagged: false,
    guess_detector_method: null,
    guess_intent_outcome: null,
    clue_text: null,
    timestamp: new Date().toISOString(),
    model_id: null,
    model_provider: null,
    prompt_version: null,
    answered_at: answer !== null ? new Date().toISOString() : null,
    pre_revision_question_text: null,
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
    original_question_text: null,
    edit_status: null,
    edit_reason: null,
    ambiguous_consumed_credit: false,
    ...overrides,
  };
}

function modelTurn(questionText: string): QuestionLogEntry {
  return entry(questionText, null, { model_id: "some-model", model_provider: "anthropic", prompt_version: "racer/4.0.0" });
}

// --- 1. All-NO path: Q1 -> Q5 in exact order ---------------------------------

test("REQUIRED 1: an empty game asks Q1 first, in English", () => {
  const state = derivePhaseOneState([], "en");
  assert.equal(state.complete, false);
  assert.equal(state.nextQuestionText, EN.spine[0]);
});

test("REQUIRED 1: all-NO walks Q1 through Q5 in exact order, then Unclassified", () => {
  const lang: GameLanguage = "en";
  let log: QuestionLogEntry[] = [];
  for (let i = 0; i < 5; i += 1) {
    const state = derivePhaseOneState(log, lang);
    assert.equal(state.complete, false, `expected question ${i + 1} still pending`);
    assert.equal(state.nextQuestionText, EN.spine[i]!, `expected exact spine question ${i + 1}`);
    log = [...log, entry(state.nextQuestionText!, "NO")];
  }
  const final = derivePhaseOneState(log, lang);
  assert.equal(final.complete, true);
  assert.equal(final.sandbox, "unclassified");
  assert.equal(final.specificity, null);
});

// --- 2. YES at every spine position locks the correct sandbox ---------------

test("REQUIRED 2: YES on Q1 locks Living", () => {
  const state = derivePhaseOneState([entry(EN.spine[0], "YES")], "en");
  assert.equal(state.sandbox, "living");
  assert.equal(state.complete, false); // specificity question still pending
  assert.equal(state.nextQuestionText, EN.specificity.living);
});

test("REQUIRED 2: NO, YES on Q2 locks Physical", () => {
  const log = [entry(EN.spine[0], "NO"), entry(EN.spine[1], "YES")];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.sandbox, "physical");
  assert.equal(state.nextQuestionText, EN.specificity.physical);
});

test("REQUIRED 2: NO, NO, YES on Q3 locks Place", () => {
  const log = [entry(EN.spine[0], "NO"), entry(EN.spine[1], "NO"), entry(EN.spine[2], "YES")];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.sandbox, "place");
  assert.equal(state.nextQuestionText, EN.specificity.place);
});

test("REQUIRED 2: NO x3, YES on Q4 locks Event", () => {
  const log = [entry(EN.spine[0], "NO"), entry(EN.spine[1], "NO"), entry(EN.spine[2], "NO"), entry(EN.spine[3], "YES")];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.sandbox, "event");
  assert.equal(state.nextQuestionText, EN.specificity.event);
});

test("REQUIRED 2: NO x4, YES on Q5 locks Abstract directly, no specificity question", () => {
  const log = [
    entry(EN.spine[0], "NO"),
    entry(EN.spine[1], "NO"),
    entry(EN.spine[2], "NO"),
    entry(EN.spine[3], "NO"),
    entry(EN.spine[4], "YES"),
  ];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.sandbox, "abstract");
  assert.equal(state.complete, true, "Abstract has no specificity question");
  assert.equal(state.specificity, null);
  assert.equal(state.nextQuestionText, null);
});

// --- 3/4. Specificity questions: exactly one for Living/Physical/Place/Event, none for Abstract

test("REQUIRED 3: Living/Physical/Place/Event each produce exactly one deterministic specificity question", () => {
  for (const [sandboxIndex, key] of (["living", "physical", "place", "event"] as const).entries()) {
    const log: QuestionLogEntry[] = [];
    for (let i = 0; i < sandboxIndex; i += 1) log.push(entry(EN.spine[i]!, "NO"));
    log.push(entry(EN.spine[sandboxIndex]!, "YES"));
    const state = derivePhaseOneState(log, "en");
    assert.equal(state.sandbox, key);
    assert.equal(state.complete, false);
    assert.equal(state.nextQuestionText, EN.specificity[key]);

    const answered = [...log, entry(state.nextQuestionText!, "YES")];
    const afterState = derivePhaseOneState(answered, "en");
    assert.equal(afterState.complete, true, `${key}: one specificity answer must complete Phase One`);
    assert.equal(afterState.specificity, "particular");
  }
});

test("REQUIRED 4: Abstract YES produces no specificity question", () => {
  const log = [
    entry(EN.spine[0], "NO"),
    entry(EN.spine[1], "NO"),
    entry(EN.spine[2], "NO"),
    entry(EN.spine[3], "NO"),
    entry(EN.spine[4], "YES"),
  ];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.complete, true);
  assert.equal(state.nextQuestionText, null);
});

// --- 5/6. IS-IS behavior exactly matches spec; two literal NOs never skip ---

test("REQUIRED 5 & 6: IS-IS on Q1-Q4 is mixed evidence, continues to next question, never skips, never counts as NO alone", () => {
  const log = [
    entry(EN.spine[0], "AMBIGUOUS"), // IS-IS on Q1
    entry(EN.spine[1], "NO"),
    entry(EN.spine[2], "AMBIGUOUS"), // IS-IS on Q3
    entry(EN.spine[3], "YES"), // locks Event
  ];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.sandbox, "event");
  assert.deepEqual(state.mixedSpineQuestions, [1, 3]);
  assert.equal(state.nextQuestionText, EN.specificity.event);
});

test("REQUIRED 5: Q5 IS-IS classifies Unclassified, same as NO", () => {
  const log = [
    entry(EN.spine[0], "NO"),
    entry(EN.spine[1], "NO"),
    entry(EN.spine[2], "NO"),
    entry(EN.spine[3], "NO"),
    entry(EN.spine[4], "AMBIGUOUS"),
  ];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.sandbox, "unclassified");
  assert.equal(state.complete, true);
});

test("REQUIRED 5: IS-IS on a specificity question records mixed/unknown specificity, then completes", () => {
  const log = [entry(EN.spine[0], "YES"), entry(EN.specificity.living, "AMBIGUOUS")];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.sandbox, "living");
  assert.equal(state.specificity, "mixed");
  assert.equal(state.complete, true);
});

test("REQUIRED 6: two literal consecutive NOs never skip a spine question", () => {
  const log = [entry(EN.spine[0], "NO"), entry(EN.spine[1], "NO")];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.complete, false);
  assert.equal(state.nextQuestionText, EN.spine[2], "Q3 must still be asked -- nothing skipped");
});

// --- 7. No Phase One action can be a guess -----------------------------------

test("REQUIRED 7: derivePhaseOneState never produces a guess -- every non-complete step is a question", () => {
  // Exhaustively walk every reachable path and confirm nextQuestionText is
  // always a known question string (never null while incomplete, and never
  // anything guess-shaped).
  const paths: ComposerAnswer[][] = [
    ["NO", "NO", "NO", "NO", "NO"],
    ["NO", "NO", "NO", "NO", "YES"],
    ["YES"],
    ["NO", "YES"],
    ["NO", "NO", "YES"],
    ["NO", "NO", "NO", "YES"],
  ];
  const allQuestionTexts = new Set([...EN.spine, ...Object.values(EN.specificity)]);
  for (const path of paths) {
    let log: QuestionLogEntry[] = [];
    for (const answer of path) {
      const state = derivePhaseOneState(log, "en");
      if (state.complete) break;
      assert.ok(state.nextQuestionText, "must always propose a question while incomplete");
      assert.ok(allQuestionTexts.has(state.nextQuestionText!), "must be one of the fixed spine/specificity questions, never invented");
      log = [...log, entry(state.nextQuestionText!, answer)];
    }
  }
});

// --- 12/13. Exact English and Hungarian strings ------------------------------

test("REQUIRED 12: exact English spine and specificity strings", () => {
  assert.deepEqual(derivePhaseOneState([], "en").nextQuestionText, "Is it alive?");
  const log1 = [entry("Is it alive?", "YES")];
  assert.equal(derivePhaseOneState(log1, "en").nextQuestionText, "Is it one particular living being?");
});

test("REQUIRED 13: exact Hungarian spine and specificity strings", () => {
  assert.equal(derivePhaseOneState([], "hu").nextQuestionText, "Élő?");
  const log1 = [entry("Élő?", "NO")];
  assert.equal(derivePhaseOneState(log1, "hu").nextQuestionText, "Fizikai dolog vagy anyag?");
  const log2 = [entry("Élő?", "NO"), entry("Fizikai dolog vagy anyag?", "YES")];
  assert.equal(derivePhaseOneState(log2, "hu").nextQuestionText, "Egy konkrét fizikai dologra vagy anyagra gondoltál?");
});

test("REQUIRED 13: full Hungarian all-NO path matches exactly", () => {
  let log: QuestionLogEntry[] = [];
  for (let i = 0; i < 5; i += 1) {
    const state = derivePhaseOneState(log, "hu");
    assert.equal(state.nextQuestionText, HU.spine[i]!);
    log = [...log, entry(state.nextQuestionText!, "NO")];
  }
  assert.equal(derivePhaseOneState(log, "hu").sandbox, "unclassified");
});

// --- 14. Question/answer-control language cannot disagree --------------------
//
// The engine takes `language` as an explicit parameter and never inspects the
// stored question text to infer it -- so a caller that always passes the
// game's own `game_language` (the same source that already drives the
// existing YES/NO/IS-IS button labels) cannot produce a mismatch. Proven
// directly: the same qa_log replayed under the two languages never mixes
// vocabulary.
test("REQUIRED 14: the same stored answers never produce cross-language question text", () => {
  const enLog = [entry(EN.spine[0], "NO")];
  const huLog = [entry(HU.spine[0], "NO")];
  assert.equal(derivePhaseOneState(enLog, "en").nextQuestionText, EN.spine[1]);
  assert.equal(derivePhaseOneState(huLog, "hu").nextQuestionText, HU.spine[1]);
  // Feeding an EN-language log through the HU engine must not silently
  // "translate" -- it must recognize the mismatch and back off entirely
  // (not applicable) rather than emit a mixed-language question.
  const crossed = derivePhaseOneState(enLog, "hu");
  assert.equal(crossed.complete, true);
  assert.equal(crossed.sandbox, null);
});

// --- 18. No target-type special cases: Apple/Peach follow the ordinary spine

test("REQUIRED 18: a target the Setter answers YES-alive-YES-particular for locks Living/particular regardless of what the target 'is' -- Apple/Peach get no special case", () => {
  // Phase One never sees the target at all (derivePhaseOneState's signature
  // has no such parameter) -- this test simply confirms the ordinary answer
  // path for a case a special-cased implementation would have been tempted
  // to rewrite (a fruit answered as alive).
  const log = [entry(EN.spine[0], "YES"), entry(EN.specificity.living, "NO")];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.sandbox, "living");
  assert.equal(state.specificity, "kind");
});

// --- Not-applicable / inert-by-construction for non-Phase-One games ---------

test("a game whose first question is not the exact spine text is reported not-applicable", () => {
  const state = derivePhaseOneState([entry("What color is it?", "YES")], "en");
  assert.equal(state.complete, true);
  assert.equal(state.sandbox, null);
});

test("REQUIRED 22/23 groundwork: a model-authored turn (model_id set) anywhere in the log makes Phase One inert from that point", () => {
  const state = derivePhaseOneState([modelTurn("What color is it?")], "en");
  assert.equal(state.complete, true);
  assert.equal(state.sandbox, null);
});

// --- 15/16. Reload restores exact position; correction rebuilds without provider

test("REQUIRED 15: replaying the same qa_log twice (simulating a reload) yields the identical state", () => {
  const log = [entry(EN.spine[0], "NO"), entry(EN.spine[1], "YES")];
  const first = derivePhaseOneState(log, "en");
  const second = derivePhaseOneState(log, "en");
  assert.deepEqual(first, second);
});

test("REQUIRED 16: correcting Q1 from NO to YES (simulating rewind truncation) recomputes the sandbox with no stored position to invalidate", () => {
  // Before correction: NO on Q1, currently mid-Q2.
  const before = [entry(EN.spine[0], "NO")];
  assert.equal(derivePhaseOneState(before, "en").nextQuestionText, EN.spine[1]);

  // A correction of Q1 (NO -> YES) is, from Phase One's perspective, exactly
  // splitAtTurn() truncating qa_log back to [Q1] and rewriting its answer --
  // no separate invalidation step exists or is needed.
  const corrected = [entry(EN.spine[0], "YES")];
  const state = derivePhaseOneState(corrected, "en");
  assert.equal(state.sandbox, "living");
  assert.equal(state.nextQuestionText, EN.specificity.living);
});
