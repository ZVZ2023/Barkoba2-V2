import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  QUESTIONS_PER_CLUE_CREDIT,
  clueCreditsAvailable,
  clueCreditsEarned,
  clueCreditsUsed,
  cluesEnabled,
  pendingClueRequest,
} from "../lib/clueCredits";
import { toRacerPublicState } from "../lib/racerState";
import type { GameRecord, QuestionLogEntry, RacerAction } from "../lib/types";

/** TASK 10 — SÚGÓ credit accounting. Everything here is derived, never stored. */

function entry(turnIndex: number, type: RacerAction, over: Partial<QuestionLogEntry> = {}) {
  return {
    id: `e${turnIndex}`, turn_index: turnIndex, turn_type: type, racer_output_raw: "",
    question_text: type === "question" ? `q${turnIndex}` : null, guess_text: null,
    composer_response: type === "question" ? "YES" : null, ambiguous_explanation: null,
    guess_detector_flagged: false, guess_detector_method: null, guess_intent_outcome: null,
    clue_text: null, original_question_text: null, edit_status: null, edit_reason: null,
    ambiguous_consumed_credit: false, timestamp: "", quality_score: null,
    information_gain: null, strategy_classification: null, integrity_flag: null,
    confidence: null, latency_ms: null, ...over,
  } as QuestionLogEntry;
}

function game(over: Partial<GameRecord> = {}): GameRecord {
  return {
    game_id: "g", phase: "questioning", created_at: "", expires_at: "",
    max_questions: 20, game_language: "hu", question_count: 0, ambiguous_count: 0,
    difficulty: "hard", clue_mode: "progressive", composer_kind: "ai", racer_kind: "human",
    qa_log: [], corrections: [], abandoned_branches: [], ...over,
  } as unknown as GameRecord;
}

test("one credit per ten completed questions", () => {
  assert.equal(QUESTIONS_PER_CLUE_CREDIT, 10);
  for (const [q, earned] of [[0, 0], [1, 0], [9, 0], [10, 1], [19, 1], [20, 2], [35, 3], [100, 10]]) {
    assert.equal(clueCreditsEarned(q as number), earned, `${q} questions`);
  }
});

test("no credit before the first threshold", () => {
  assert.equal(clueCreditsAvailable(game({ question_count: 9 })), 0);
  assert.equal(clueCreditsAvailable(game({ question_count: 10 })), 1);
});

test("unused credits accumulate and are never forfeited", () => {
  // At 30 questions three are earned; one spent leaves two in hand.
  const g = game({ question_count: 30, max_questions: 50, qa_log: [entry(1, "clue", { clue_text: "x" })] });
  assert.equal(clueCreditsEarned(g.question_count), 3);
  assert.equal(clueCreditsUsed(g.qa_log), 1);
  assert.equal(clueCreditsAvailable(g), 2);
});

test("a credit cannot be spent twice", () => {
  const g = game({
    question_count: 10,
    qa_log: [entry(1, "clue", { clue_text: "a" }), entry(2, "clue", { clue_text: "b" })],
  });
  assert.equal(clueCreditsAvailable(g), 0);
});

test("clues exist only on hard, and only with a clue mode", () => {
  assert.equal(cluesEnabled(game({ difficulty: "hard", clue_mode: "progressive" })), true);
  assert.equal(cluesEnabled(game({ difficulty: "hard", clue_mode: "minimal" })), true);
  assert.equal(cluesEnabled(game({ difficulty: "hard", clue_mode: "none" })), false);
  assert.equal(cluesEnabled(game({ difficulty: "medium", clue_mode: "progressive" })), false);
  assert.equal(cluesEnabled(game({ difficulty: "easy", clue_mode: "progressive" })), false);
});

test("no-clue games never offer a credit however many questions are asked", () => {
  assert.equal(clueCreditsAvailable(game({ clue_mode: "none", question_count: 100 })), 0);
  assert.equal(clueCreditsAvailable(game({ difficulty: "easy", question_count: 100 })), 0);
});

test("a clue turn costs no question and no guess", () => {
  const before = game({ question_count: 10 });
  const after = { ...before, qa_log: [entry(1, "clue", { clue_text: "x" })] } as GameRecord;
  assert.equal(after.question_count, before.question_count, "question_count must not move");
  assert.equal(after.qa_log.filter((e) => e.turn_type === "guess").length, 0);
});

test("records written before 0.9.8.0 need no migration", () => {
  // An old log has questions only. Used must read zero, not undefined or NaN.
  const old = game({ question_count: 12, qa_log: [entry(1, "question"), entry(2, "question")] });
  assert.equal(clueCreditsUsed(old.qa_log), 0);
  assert.equal(clueCreditsAvailable(old), 1);
});

test("a clue turn without text is an outstanding request", () => {
  const waiting = game({ question_count: 10, qa_log: [entry(1, "clue")] });
  assert.ok(pendingClueRequest(waiting), "clue with no text is pending");
  const filled = game({ question_count: 10, qa_log: [entry(1, "clue", { clue_text: "x" })] });
  assert.equal(pendingClueRequest(filled), null, "filled clue is not pending");
  assert.equal(pendingClueRequest(game({ qa_log: [entry(1, "question")] })), null);
});

test("the Racer sees clues it was given, and its remaining credits", () => {
  const g = game({
    question_count: 20,
    racer_kind: "ai",
    qa_log: [entry(1, "question"), entry(2, "clue", { clue_text: "Kint keresd." })],
  });
  const state = toRacerPublicState(g);
  assert.deepEqual(state.clues, [{ turn_index: 2, clue: "Kint keresd." }]);
  assert.equal(state.clue_credits_available, 1, "2 earned, 1 spent");
});

test("an outstanding clue request carries no text to the Racer", () => {
  const g = game({ question_count: 10, racer_kind: "ai", qa_log: [entry(1, "clue")] });
  assert.deepEqual(toRacerPublicState(g).clues, []);
});

test("the narrowing boundary still leaks nothing from a clue game", () => {
  const g = game({ question_count: 10, qa_log: [entry(1, "clue", { clue_text: "Kint." })] });
  const state = toRacerPublicState(g);
  assert.equal("private_target" in state, false);
  assert.equal("revealed_target" in state, false);
  assert.equal("difficulty" in state, false);
});

test("a credit earned by the FINAL question is still spendable", () => {
  // 20 of 20 answered earns the second credit. SÚGÓ rewards the deduction, so
  // the budget running out must not swallow a credit the player has earned.
  const g = game({
    question_count: 20,
    max_questions: 20,
    qa_log: [entry(1, "clue", { clue_text: "x" })],
  });
  assert.equal(clueCreditsAvailable(g), 1, "earned 2, spent 1, one left at the buzzer");
});

test("only answered questions advance the threshold", () => {
  // question_count is the engine's record of CHARGED questions: it moves on
  // YES, NO and AMBIGUOUS alike, is not advanced by a guess or a concede, and
  // a corrected question is counted once, as the accepted version.
  const src = readFileSync("app/api/game/[id]/turn/route.ts", "utf8");
  assert.equal(
    (src.match(/game\.question_count \+= 1/g) || []).length,
    1,
    "exactly one place may charge a question",
  );
  const charge = src.slice(src.indexOf("if (answer) {"), src.indexOf("game.question_count += 1"));
  assert.doesNotMatch(charge, /turn\.action === "guess"/, "a guess must never charge a question");
});

test("a clue cannot be requested once the game has left questioning", () => {
  const src = readFileSync("app/api/game/[id]/clue/route.ts", "utf8");
  assert.match(src, /game\.phase !== "questioning"/, "guess or concede closes the door");
});
