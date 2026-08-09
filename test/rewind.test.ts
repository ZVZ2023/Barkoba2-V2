import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCorrectable,
  isNoOpCorrection,
  recomputeCounters,
  splitAtTurn,
} from "../lib/rewind";
import type { ComposerAnswer, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// Rewind arithmetic. This decides how many questions a Racer has left after a
// correction, so an error here silently changes the game's difficulty rather
// than failing visibly.
// ---------------------------------------------------------------------------

function entry(turnIndex: number, answer: ComposerAnswer | null): QuestionLogEntry {
  return {
    id: `e${turnIndex}`,
    turn_index: turnIndex,
    turn_type: "question",
    racer_output_raw: "",
    question_text: `Q${turnIndex}`,
    guess_text: null,
    composer_response: answer,
    ambiguous_explanation: null,
    guess_detector_flagged: false,
    guess_detector_method: null,
    guess_intent_outcome: null,
    clue_text: null,
    ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(),
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
  };
}

test("counters are derived from the log, not tracked separately", () => {
  const log = [entry(1, "YES"), entry(2, "NO"), entry(3, "YES")];
  const c = recomputeCounters(log);
  assert.equal(c.questionCount, 3);
  assert.equal(c.ambiguousCount, 0);
});

test("unanswered questions are not charged", () => {
  // The Racer has asked, the Composer has not replied. Nothing is spent until
  // an answer exists — otherwise a pending question would cost the budget even
  // if the game were abandoned there.
  const log = [entry(1, "YES"), entry(2, null)];
  const c = recomputeCounters(log);
  assert.equal(c.questionCount, 1);
});

test("MILESTONE 1: AMBIGUOUS is unlimited in count but still costs a question", () => {
  // No quota — ten AMBIGUOUS answers are all permitted. Each still costs one
  // of the Racer's 20, because every question it asks costs one.
  const log = Array.from({ length: 10 }, (_, i) => entry(i + 1, "AMBIGUOUS"));
  const c = recomputeCounters(log);
  assert.equal(c.questionCount, 10, "ten questions asked, ten questions charged");
  assert.equal(c.ambiguousCount, 10, "and tracked, for later abuse analysis");
  for (const e of log) {
    assert.equal(e.ambiguous_consumed_credit, false, "the retired flag stays false");
  }
});

test("every answer type costs exactly the same: one question", () => {
  const log = [
    entry(1, "YES"),
    entry(2, "AMBIGUOUS"),
    entry(3, "NO"),
    entry(4, "AMBIGUOUS"),
    entry(5, "AMBIGUOUS"),
    entry(6, "YES"),
  ];
  const c = recomputeCounters(log);
  assert.equal(c.questionCount, 6, "six answered questions, six charged");
  assert.equal(c.ambiguousCount, 3, "three of which were ambiguous");
});

test("records written under either earlier rule are repaired on read", () => {
  // A stored entry may still carry ambiguous_consumed_credit = true from the
  // quota era. Under a flat cost the flag is meaningless and must be cleared,
  // and it must not cause a double charge.
  const log = [entry(1, "AMBIGUOUS"), entry(2, "AMBIGUOUS")];
  log[0]!.ambiguous_consumed_credit = true;
  const c = recomputeCounters(log);
  assert.equal(log[0]!.ambiguous_consumed_credit, false, "stale flag cleared");
  assert.equal(c.questionCount, 2, "charged once each, not twice for the flagged one");
});

test("unanswered and non-question turns are not counted", () => {
  const pending = entry(4, null);
  const guess = entry(5, "YES");
  guess.turn_type = "guess";
  const log = [entry(1, "YES"), pending, guess];
  const c = recomputeCounters(log);
  assert.equal(c.questionCount, 1);
});

test("splitAtTurn keeps the corrected turn and discards everything after it", () => {
  const log = [entry(1, "YES"), entry(2, "NO"), entry(3, "YES"), entry(4, null)];
  const split = splitAtTurn(log, 2);
  assert.ok(split);
  assert.deepEqual(split!.retained.map((e) => e.turn_index), [1, 2]);
  assert.deepEqual(split!.abandoned.map((e) => e.turn_index), [3, 4]);
});

test("correcting the latest answer discards nothing", () => {
  const log = [entry(1, "YES"), entry(2, "NO")];
  const split = splitAtTurn(log, 2);
  assert.equal(split!.abandoned.length, 0);
});

test("splitAtTurn returns null for an unknown turn", () => {
  assert.equal(splitAtTurn([entry(1, "YES")], 99), null);
});

test("only answered questions are correctable", () => {
  assert.equal(isCorrectable(entry(1, "YES")), true);
  assert.equal(isCorrectable(entry(1, null)), false, "unanswered");
  const guess = entry(2, "YES");
  guess.turn_type = "guess";
  assert.equal(isCorrectable(guess), false, "a guess is not an answer");
  assert.equal(isCorrectable(undefined), false);
});

test("re-submitting the same answer is a no-op", () => {
  const e = entry(1, "YES");
  assert.equal(isNoOpCorrection(e, "YES", null), true);
  assert.equal(isNoOpCorrection(e, "NO", null), false);

  const amb = entry(2, "AMBIGUOUS");
  amb.ambiguous_explanation = "depends";
  assert.equal(isNoOpCorrection(amb, "AMBIGUOUS", "depends"), true);
  assert.equal(
    isNoOpCorrection(amb, "AMBIGUOUS", "depends on the handle"),
    false,
    "a changed explanation is a real correction"
  );
});

test("a full rewind restores credits exactly, not approximately", () => {
  // 6 answered turns, then rewind to turn 2.
  const log = [
    entry(1, "YES"),
    entry(2, "NO"),
    entry(3, "AMBIGUOUS"),
    entry(4, "YES"),
    entry(5, "AMBIGUOUS"),
    entry(6, "NO"),
  ];
  const before = recomputeCounters(log);
  assert.equal(before.questionCount, 6, "six answered questions, all charged");
  assert.equal(before.ambiguousCount, 2);

  const split = splitAtTurn(log, 2)!;
  const after = recomputeCounters(split.retained);
  assert.equal(after.questionCount, 2, "turns 3-6 released their credits");
  assert.equal(after.ambiguousCount, 0);
  assert.equal(split.abandoned.length, 4);
});

// ---------------------------------------------------------------------------
// The abandoned branch must be structurally unreachable from gameplay, not
// merely unused. If a discarded line of questioning could reach the Racer or
// the Integrity Review, a rewind would leak information the Composer chose to
// discard — and the Racer would be reasoning from answers that no longer exist.
// ---------------------------------------------------------------------------

import { toRacerPublicState } from "../lib/racerState";
import type { GameRecord } from "../lib/types";

function gameWith(qaLog: QuestionLogEntry[], abandoned: QuestionLogEntry[][]): GameRecord {
  return {
    game_id: "g",
    phase: "questioning",
    created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(),
    max_questions: 20,
    game_language: "en",
    composer_kind: "human",
    racer_kind: "ai",
    difficulty: null,
    clue_mode: null,
    question_count: 0,
    ambiguous_count: 0,
    qa_log: qaLog,
    final_action: null,
    final_guess_text: null,
    result: null,
    integrity_notes: null,
    integrity_flagged_turns: null,
    adjudication_notes: null,
    revealed_target: null,
    corrections: [],
    abandoned_branches: abandoned,
    clarification_prompt: null,
  };
}

test("the Racer cannot see an abandoned branch", () => {
  const live = entry(1, "YES");
  const discarded = entry(2, "NO");
  discarded.question_text = "SECRET-DISCARDED-QUESTION";

  const state = toRacerPublicState(gameWith([live], [[discarded]]));

  assert.equal(state.transcript.length, 1, "only the live branch is visible");
  assert.equal(
    JSON.stringify(state).includes("SECRET-DISCARDED-QUESTION"),
    false,
    "a discarded question must not reach the Racer by any path"
  );
});
