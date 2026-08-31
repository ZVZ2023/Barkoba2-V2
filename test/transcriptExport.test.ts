import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  fetchFullTranscriptByCorpusGameId,
  fetchFullTranscriptByOperationalGameId,
  fetchFullTranscriptsByBenchmarkRunId,
} from "../lib/corpus/transcriptExport";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";

// ---------------------------------------------------------------------------
// M3 — full-transcript export.
//
// Exercised against a fake SqlClient, the same pattern
// test/gameIntelligenceSignals.test.ts uses — never run against live Neon
// here. Shaped after the frozen M1 D-1 fixture (corpus_game_id
// aaaaaaaa-..., operational_game_id 76041765-...), but with invented turn
// content: no live corpus read has happened yet, so these rows are test
// fixtures, not the real D-1 transcript.
// ---------------------------------------------------------------------------

interface Recorded {
  sql: string;
}

let calls: Recorded[] = [];
let gameRows: Record<string, unknown>[] = [];
let turnRows: Record<string, unknown>[] = [];
let targetRows: Record<string, unknown>[] = [];
let resolutionRows: Record<string, unknown>[] = [];

const GAME_ROW = {
  corpus_game_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  operational_game_id: "76041765-4654-4eb1-8713-32591d396600",
  benchmark_case_id: "m1-d1-generic-backpack",
  benchmark_run_id: "c1e02ec4-fedb-4583-9ef8-63dde24eed3a",
  lifecycle_state: "completed",
  outcome: "racer_correct",
  difficulty: "medium",
  game_language: "en",
  max_questions: "50",
  question_count: "49",
  ambiguous_count: "9",
  created_at: "2026-08-30T18:00:00.000Z",
  finalized_at: "2026-08-30T18:20:00.000Z",
};

const MAIN_TURN_1 = {
  turn_index: 1,
  branch: "main",
  branch_seq: null,
  turn_type: "question",
  actor: "ai_racer",
  question_text: "Is it man-made?",
  guess_text: null,
  clue_text: null,
  composer_response: "YES",
  ambiguous_explanation: null,
  guess_detector_flagged: false,
  guess_detector_method: null,
  guess_intent_outcome: null,
  original_question_text: null,
  edit_status: null,
  edit_reason: null,
  raw_output: { action: "question", question_text: "Is it man-made?", guess_text: null, rationale: "Start broad." },
  occurred_at: "2026-08-30T18:00:01.000Z",
  model_id: "claude-x",
  model_provider: "anthropic",
  prompt_version: "racer/4.0.0",
  answered_at: "2026-08-30T18:00:02.000Z",
  pre_revision_question_text: null,
};

const MAIN_TURN_2 = {
  ...MAIN_TURN_1,
  turn_index: 2,
  question_text: "Is it worn on the body?",
  composer_response: "YES",
  // raw_output as a JSON STRING rather than a pre-parsed object, to exercise
  // the string-fallback branch of extractRationale.
  raw_output: JSON.stringify({
    action: "question",
    question_text: "Is it worn on the body?",
    guess_text: null,
    rationale: "Narrowing to wearables.",
  }),
};

const ABANDONED_TURN = {
  ...MAIN_TURN_1,
  turn_index: 5,
  branch: "abandoned",
  branch_seq: 1,
  question_text: "Is it a hat?",
  composer_response: "NO",
  raw_output: { action: "question", question_text: "Is it a hat?", guess_text: null, rationale: "Dead end, abandoned on rewind." },
};

const TARGET_ROW = {
  target: "a backpack",
  definition: "A backpack as a general kind of object...",
  granularity: "generic_type",
  modifiers: null,
  locked_at: "2026-08-30T17:59:00.000Z",
};

const RESOLUTION_ROW = {
  final_action: "guess",
  final_guess_text: "a backpack",
  adjudicator_verdict: "correct",
  adjudicator_confidence: "0.95",
  adjudication_notes: "Matches target exactly.",
  integrity_verdict: null,
  integrity_notes: null,
  integrity_flagged_turns: null,
  resolved_at: "2026-08-30T18:20:00.000Z",
};

function fakeSql(strings: TemplateStringsArray, ..._values: SqlValue[]) {
  const text = strings.join("?");
  calls.push({ sql: text });
  if (text.includes("FROM corpus.games")) return Promise.resolve(gameRows);
  if (text.includes("FROM corpus.game_turns")) return Promise.resolve(turnRows);
  if (text.includes("FROM corpus.game_targets")) return Promise.resolve(targetRows);
  if (text.includes("FROM corpus.game_resolutions")) return Promise.resolve(resolutionRows);
  return Promise.resolve([] as Record<string, unknown>[]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

beforeEach(() => {
  calls = [];
  gameRows = [GAME_ROW];
  turnRows = [MAIN_TURN_2, MAIN_TURN_1, ABANDONED_TURN]; // deliberately out of order
  targetRows = [TARGET_ROW];
  resolutionRows = [RESOLUTION_ROW];
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
});

test("fetchFullTranscriptByCorpusGameId assembles game metadata, target, and resolution", async () => {
  const transcript = await fetchFullTranscriptByCorpusGameId(
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  );
  assert.ok(transcript);
  assert.equal(transcript!.operational_game_id, "76041765-4654-4eb1-8713-32591d396600");
  assert.equal(transcript!.outcome, "racer_correct");
  assert.equal(transcript!.max_questions, 50);
  assert.equal(transcript!.question_count, 49);
  assert.equal(transcript!.target?.granularity, "generic_type");
  assert.equal(transcript!.resolution?.adjudicator_verdict, "correct");
  assert.equal(transcript!.resolution?.adjudicator_confidence, 0.95);
});

test("main-branch turns are ordered by turn_index ascending, regardless of row order returned", async () => {
  const transcript = await fetchFullTranscriptByCorpusGameId(
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  );
  assert.equal(transcript!.turns.length, 2);
  assert.equal(transcript!.turns[0]!.turn_index, 1);
  assert.equal(transcript!.turns[1]!.turn_index, 2);
});

test("abandoned turns are kept structurally separate from the main branch", async () => {
  const transcript = await fetchFullTranscriptByCorpusGameId(
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  );
  assert.equal(transcript!.abandoned_turns.length, 1);
  assert.equal(transcript!.abandoned_turns[0]!.turn_index, 5);
  assert.ok(!transcript!.turns.some((t) => t.branch === "abandoned"));
});

test("rationale is extracted from raw_output whether it arrives as an object or a JSON string", async () => {
  const transcript = await fetchFullTranscriptByCorpusGameId(
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  );
  assert.equal(transcript!.turns[0]!.rationale, "Start broad.");
  assert.equal(transcript!.turns[1]!.rationale, "Narrowing to wearables.");
});

test("a turn with no rationale key reports null, never a fabricated string", async () => {
  turnRows = [{ ...MAIN_TURN_1, raw_output: { action: "question" } }];
  const transcript = await fetchFullTranscriptByCorpusGameId(
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  );
  assert.equal(transcript!.turns[0]!.rationale, null);
});

test("an unresolved game (no target/resolution row yet) reports null, not a fabricated shape", async () => {
  targetRows = [];
  resolutionRows = [];
  const transcript = await fetchFullTranscriptByCorpusGameId(
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  );
  assert.equal(transcript!.target, null);
  assert.equal(transcript!.resolution, null);
});

test("fetchFullTranscriptByOperationalGameId returns null for an unknown game, without error", async () => {
  gameRows = [];
  const transcript = await fetchFullTranscriptByOperationalGameId(
    "00000000-0000-0000-0000-000000000000"
  );
  assert.equal(transcript, null);
});

test("fetchFullTranscriptsByBenchmarkRunId returns a list", async () => {
  const transcripts = await fetchFullTranscriptsByBenchmarkRunId(
    "c1e02ec4-fedb-4583-9ef8-63dde24eed3a"
  );
  assert.equal(transcripts?.length, 1);
  assert.equal(transcripts![0]!.benchmark_case_id, "m1-d1-generic-backpack");
});

test("no query issues an INSERT, UPDATE or DELETE against the frozen corpus", async () => {
  await fetchFullTranscriptByCorpusGameId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  await fetchFullTranscriptsByBenchmarkRunId("c1e02ec4-fedb-4583-9ef8-63dde24eed3a");
  for (const call of calls) {
    assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE)\b/i);
  }
});

test("integrity_flagged_turns is read as an array when present, null otherwise", async () => {
  resolutionRows = [{ ...RESOLUTION_ROW, integrity_flagged_turns: [3, 7] }];
  const transcript = await fetchFullTranscriptByCorpusGameId(
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  );
  assert.deepEqual(transcript!.resolution?.integrity_flagged_turns, [3, 7]);
});
