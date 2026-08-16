import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  hasPreservableEvidence,
  deriveLifecycle,
  buildTurnRows,
} from "../lib/corpus/gameCorpus";
import type { GameRecord, QuestionLogEntry, ComposerAnswer, RacerAction } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.2 — the pure half of corpus persistence.
//
// Everything tested here is a pure function of a GameRecord: the preservation
// threshold, the lifecycle derivation, and the row shape. These are the parts
// that decide WHAT becomes history, so they are tested without a database in
// the way — the same reason lib/resolveResult.ts is a pure module.
// ---------------------------------------------------------------------------

function entry(overrides: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(),
    turn_index: 1,
    turn_type: "question" as RacerAction,
    racer_output_raw: "",
    question_text: null,
    guess_text: null,
    composer_response: null,
    ambiguous_explanation: null,
    guess_detector_flagged: false,
    guess_detector_method: null,
    guess_intent_outcome: null,
    clue_text: null,
    original_question_text: null,
    edit_status: null,
    edit_reason: null,
    ambiguous_consumed_credit: false,
    timestamp: "2026-08-11T10:00:00.000Z",
    model_id: null,
    model_provider: null,
    prompt_version: null,
    answered_at: null,
    pre_revision_question_text: null,
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
    ...overrides,
  };
}

function game(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    game_id: randomUUID(),
    player_id: null,
    composer_player_id: null,
    racer_player_id: null,
    join_code: null,
    phase: "questioning",
    created_at: "2026-08-11T09:59:00.000Z",
    expires_at: "2026-08-12T09:59:00.000Z",
    max_questions: 20,
    game_language: "hu",
    private_target: false,
    composer_kind: "ai",
    racer_kind: "human",
    racer_provider: null,
    difficulty: "easy",
    clue_mode: "none",
    question_count: 0,
    ambiguous_count: 0,
    qa_log: [],
    final_action: null,
    final_guess_text: null,
    result: null,
    integrity_notes: null,
    integrity_flagged_turns: null,
    adjudication_notes: null,
    adjudicator_verdict: null,
    integrity_verdict: null,
    adjudication_confidence: null,
    revealed_target: null,
    revealed_definition: null,
    revealed_granularity: null,
    revealed_modifiers: null,
    revealed_locked_at: null,
    corrections: [],
    abandoned_branches: [],
    clarification_prompt: null,
    benchmark_case_id: null,
    benchmark_run_id: null,
    ...overrides,
  };
}

const answered = (i: number, a: ComposerAnswer = "YES") =>
  entry({ turn_index: i, question_text: `q${i}`, composer_response: a });

/** tsconfig sets noUncheckedIndexedAccess, so indexing is narrowed explicitly. */
function rowAt(g: GameRecord, index: number) {
  const row = buildTurnRows(g)[index];
  assert.ok(row, `expected a turn row at index ${index}`);
  return row;
}

// --- the preservation threshold (approved option B) -------------------------

test("a game with no turns at all is below the threshold", () => {
  assert.equal(hasPreservableEvidence(game()), false);
});

test("a question with no answer yet is below the threshold", () => {
  const g = game({ qa_log: [entry({ turn_index: 1, question_text: "q1" })] });
  assert.equal(hasPreservableEvidence(g), false);
});

test("one completed question/answer crosses the threshold", () => {
  assert.equal(hasPreservableEvidence(game({ qa_log: [answered(1)] })), true);
});

test("an AMBIGUOUS answer is still a completed interaction", () => {
  assert.equal(hasPreservableEvidence(game({ qa_log: [answered(1, "AMBIGUOUS")] })), true);
});

test("a clue alone does not cross the threshold — no question was answered", () => {
  const g = game({ qa_log: [entry({ turn_index: 1, turn_type: "clue", clue_text: "hint" })] });
  assert.equal(hasPreservableEvidence(g), false);
});

test("an immediate guess with no answered question does not cross the threshold", () => {
  // Matches the real 'Eiffel-torony' field game: guess on turn 1, zero questions.
  const g = game({
    qa_log: [entry({ turn_index: 1, turn_type: "guess", guess_text: "Eiffel-torony" })],
    phase: "complete",
  });
  assert.equal(hasPreservableEvidence(g), false);
});

// --- lifecycle: preservation is NOT the same question as completion ---------

test("an abandoned mid-play game is preserved as in_progress with no outcome", () => {
  const g = game({ qa_log: [answered(1), answered(2)] });
  assert.equal(hasPreservableEvidence(g), true);
  const life = deriveLifecycle(g);
  assert.equal(life.lifecycle_state, "in_progress");
  assert.equal(life.outcome, null);
  assert.equal(life.finalized_at, null);
});

test("a game stuck in resolving is in_progress, not silently completed", () => {
  const g = game({ phase: "resolving", qa_log: [answered(1)], final_action: "guess" });
  assert.equal(deriveLifecycle(g).lifecycle_state, "in_progress");
  assert.equal(deriveLifecycle(g).outcome, null);
});

test("a completed game carries its outcome and is finalized", () => {
  const g = game({ phase: "complete", result: "racer_incorrect", final_action: "guess" });
  const life = deriveLifecycle(g);
  assert.equal(life.lifecycle_state, "completed");
  assert.equal(life.outcome, "racer_incorrect");
  assert.ok(life.finalized_at);
});

test("every GameResult maps to a distinct stored outcome", () => {
  const results = [
    "racer_correct",
    "racer_incorrect",
    "composer_win_integrity_upheld",
    "racer_win_integrity_violation",
  ] as const;
  const mapped = results.map(
    (r) => deriveLifecycle(game({ phase: "complete", result: r })).outcome
  );
  assert.deepEqual(mapped, [...results]);
  assert.equal(new Set(mapped).size, 4);
});

// --- chronology -------------------------------------------------------------

test("turn rows reproduce qa_log order exactly", () => {
  const log = [answered(1), answered(2, "NO"), answered(3, "AMBIGUOUS")];
  const rows = buildTurnRows(game({ qa_log: log })).filter((r) => r.branch === "main");
  assert.deepEqual(
    rows.map((r) => r.turn_index),
    [1, 2, 3]
  );
  assert.deepEqual(
    rows.map((r) => r.turn_id),
    log.map((e) => e.id)
  );
});

test("main turn_index values are contiguous from 1", () => {
  const rows = buildTurnRows(
    game({ qa_log: [answered(1), answered(2), answered(3), answered(4)] })
  ).filter((r) => r.branch === "main");
  rows.forEach((r, i) => assert.equal(r.turn_index, i + 1));
});

test("rewound turns are preserved on the abandoned branch, never interleaved", () => {
  const discarded = [answered(3), answered(4)];
  const rows = buildTurnRows(
    game({ qa_log: [answered(1), answered(2)], abandoned_branches: [discarded] })
  );
  const main = rows.filter((r) => r.branch === "main");
  const aband = rows.filter((r) => r.branch === "abandoned");

  assert.equal(main.length, 2);
  assert.equal(aband.length, 2);
  // The discarded branch is kept as evidence...
  assert.deepEqual(
    aband.map((r) => r.turn_id),
    discarded.map((e) => e.id)
  );
  // ...and does not pollute the game as played.
  assert.equal(main.some((r) => discarded.some((d) => d.id === r.turn_id)), false);
});

test("an edited question preserves both the original and the correction", () => {
  const g = game({
    qa_log: [
      entry({
        turn_index: 1,
        question_text: "Fizikai tárgy?",
        original_question_text: "Fizikaj targy?",
        edit_status: "accepted",
        edit_reason: "same intent",
        composer_response: "YES",
      }),
    ],
  });
  const row = rowAt(g, 0);
  assert.equal(row.question_text, "Fizikai tárgy?");
  assert.equal(row.original_question_text, "Fizikaj targy?");
  assert.equal(row.edit_status, "accepted");
});

// --- evidence fidelity ------------------------------------------------------

test("guess-detector evidence survives into the row", () => {
  const g = game({
    qa_log: [
      entry({
        turn_index: 1,
        question_text: "Ez a kanál?",
        composer_response: "NO",
        guess_detector_flagged: true,
        guess_detector_method: "heuristic",
        guess_intent_outcome: "continue_questioning",
      }),
    ],
  });
  const row = rowAt(g, 0);
  assert.equal(row.guess_detector_flagged, true);
  assert.equal(row.guess_detector_method, "heuristic");
  assert.equal(row.guess_intent_outcome, "continue_questioning");
});

test("the ambiguity explanation is preserved — the only IS-IS evidence there is", () => {
  const g = game({
    qa_log: [
      entry({
        turn_index: 1,
        question_text: "Nagy?",
        composer_response: "AMBIGUOUS",
        ambiguous_explanation: "Attól függ, mihez képest.",
      }),
    ],
  });
  assert.equal(rowAt(g, 0).ambiguous_explanation, "Attól függ, mihez képest.");
});

test("actor attribution follows the seats, not the turn shape", () => {
  const g = game({
    composer_kind: "ai",
    racer_kind: "human",
    racer_provider: null,
    qa_log: [
      answered(1),
      entry({ turn_index: 2, turn_type: "clue", clue_text: "hint" }),
      entry({ turn_index: 3, turn_type: "guess", guess_text: "kanál" }),
    ],
  });
  assert.equal(rowAt(g, 0).actor, "human_racer");
  assert.equal(rowAt(g, 1).actor, "ai_composer"); // a clue is the Composer steering
  assert.equal(rowAt(g, 2).actor, "human_racer");
});

test("unparseable raw output is preserved rather than discarded", () => {
  const g = game({
    qa_log: [entry({ turn_index: 1, composer_response: "YES", racer_output_raw: "not json{" })],
  });
  assert.deepEqual(rowAt(g, 0).raw_output, { unparsed: "not json{" });
});

test("valid raw output is stored as structured jsonb, not a string", () => {
  const g = game({
    qa_log: [
      entry({
        turn_index: 1,
        composer_response: "YES",
        racer_output_raw: JSON.stringify({ answer: "YES", reasoning: "r" }),
      }),
    ],
  });
  assert.deepEqual(rowAt(g, 0).raw_output, { answer: "YES", reasoning: "r" });
});
