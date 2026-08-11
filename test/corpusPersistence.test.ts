import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { recordGameState, unlinkPlayer } from "../lib/corpus/gameCorpus";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import type { GameRecord, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.2 — corpus orchestration, failure isolation, and the SQL guarantees.
//
// SCOPE, STATED HONESTLY: there is no PostgreSQL in this test environment, so
// these tests verify what the application DOES (which statements it issues, in
// what order, and how it behaves when the database refuses) plus a static guard
// that the SQL still carries the constraints idempotency depends on.
//
// They do NOT prove end-to-end idempotency inside PostgreSQL — that requires a
// live Neon run and is listed as such in the completion report. Asserting it
// here would be claiming evidence this environment cannot produce.
// ---------------------------------------------------------------------------

interface Recorded {
  sql: string;
  values: SqlValue[];
}

let calls: Recorded[] = [];
let failNext = false;
/** Statement arrays submitted through sql.transaction(), newest last. */
let transactions: number[] = [];

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const text = strings.join("?");
  calls.push({ sql: text, values });
  if (failNext) return Promise.reject(new Error("neon unavailable"));
  return Promise.resolve([] as Record<string, unknown>[]);
}

// Since 2.2.0.3 the whole record is written as ONE transaction, so the fake has
// to model that rather than a sequence of independent statements.
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => {
  transactions.push(queries.length);
  return Promise.all(queries);
};

beforeEach(() => {
  calls = [];
  transactions = [];
  failNext = false;
  // Must include a username: since 2.2.0.2 the config gate validates the URL,
  // and a username-less string is correctly rejected before any write.
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
});

function entry(overrides: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(),
    turn_index: 1,
    turn_type: "question",
    racer_output_raw: "",
    question_text: "q",
    guess_text: null,
    composer_response: "YES",
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
    player_id: "abc123",
    phase: "questioning",
    created_at: "2026-08-11T09:59:00.000Z",
    expires_at: "2026-08-12T09:59:00.000Z",
    max_questions: 20,
    game_language: "hu",
    private_target: false,
    composer_kind: "ai",
    racer_kind: "human",
    difficulty: "easy",
    clue_mode: "none",
    question_count: 1,
    ambiguous_count: 0,
    qa_log: [entry()],
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
    ...overrides,
  };
}

const issued = () => calls.map((c) => c.sql).join("\n---\n");

// --- gating -----------------------------------------------------------------

test("writes nothing when CORPUS_ENABLED is off, even with a DATABASE_URL", async () => {
  process.env.CORPUS_ENABLED = "false";
  assert.equal(await recordGameState(game()), "disabled");
  assert.equal(calls.length, 0);
});

test("writes nothing when DATABASE_URL is absent", async () => {
  delete process.env.DATABASE_URL;
  assert.equal(await recordGameState(game()), "disabled");
  assert.equal(calls.length, 0);
});

test("a below-threshold game issues no statements at all", async () => {
  const g = game({ qa_log: [entry({ composer_response: null })], question_count: 0 });
  assert.equal(await recordGameState(g), "below_threshold");
  assert.equal(calls.length, 0);
});

// --- the happy path ---------------------------------------------------------

test("a qualifying in-progress game writes the game and its turns", async () => {
  assert.equal(await recordGameState(game()), "written");
  const text = issued();
  assert.match(text, /INSERT INTO corpus\.games/);
  assert.match(text, /INSERT INTO corpus\.game_turns/);
  // Not resolved, so neither of these may exist yet.
  assert.doesNotMatch(text, /INSERT INTO corpus\.game_resolutions/);
  assert.doesNotMatch(text, /INSERT INTO corpus\.game_targets/);
});

test("an unresolved game never writes target metadata", async () => {
  await recordGameState(game({ phase: "resolving", final_action: "guess" }));
  assert.doesNotMatch(issued(), /corpus\.game_targets/);
});

test("a completed game writes target metadata and the resolution", async () => {
  const g = game({
    phase: "complete",
    result: "racer_incorrect",
    final_action: "guess",
    final_guess_text: "kés",
    adjudicator_verdict: "incorrect",
    integrity_verdict: "upheld",
    adjudication_confidence: 0.93,
    revealed_target: "kanál",
    revealed_definition: "evőeszköz folyékony ételhez",
    revealed_granularity: "generic_type",
    revealed_modifiers: null,
    revealed_locked_at: "2026-08-11T09:59:30.000Z",
  });
  assert.equal(await recordGameState(g), "written");

  const text = issued();
  assert.match(text, /INSERT INTO corpus\.game_targets/);
  assert.match(text, /INSERT INTO corpus\.game_resolutions/);

  const flat = calls.flatMap((c) => c.values);
  assert.ok(flat.includes("kanál"), "declassified target must be persisted");
  assert.ok(flat.includes("generic_type"), "granularity must be persisted");
  assert.ok(
    flat.includes(0.93),
    "adjudicator confidence must be persisted — the gap V2.2 was asked to close"
  );
});

test("adjudicator confidence of exactly 0 is stored, not treated as absent", async () => {
  const g = game({
    phase: "complete",
    result: "racer_incorrect",
    final_action: "guess",
    adjudicator_verdict: "incorrect",
    adjudication_confidence: 0,
    revealed_target: "x",
  });
  await recordGameState(g);
  assert.ok(calls.flatMap((c) => c.values).includes(0));
});

// --- rewind ordering --------------------------------------------------------

test("abandoned turns are demoted before main turns are upserted", async () => {
  const discarded = [entry({ turn_index: 2 }), entry({ turn_index: 3 })];
  await recordGameState(
    game({ qa_log: [entry({ turn_index: 1 })], abandoned_branches: [discarded] })
  );

  const demote = calls.findIndex((c) => /UPDATE corpus\.game_turns SET branch/.test(c.sql));
  const upsert = calls.findIndex((c) => /INSERT INTO corpus\.game_turns/.test(c.sql));
  assert.ok(demote >= 0, "a rewind must demote the abandoned branch");
  assert.ok(
    demote < upsert,
    "demotion must precede the upsert, or the partial unique index on the main " +
      "sequence can reject a reused turn_index"
  );
});

test("a game with no rewind issues no demotion statement", async () => {
  await recordGameState(game());
  assert.doesNotMatch(issued(), /UPDATE corpus\.game_turns SET branch/);
});

// --- failure isolation (the critical property) ------------------------------

test("a database failure never throws out of recordGameState", async () => {
  failNext = true;
  const outcome = await recordGameState(game());
  assert.equal(outcome, "deferred");
});

test("a database failure does not mutate the GameRecord", async () => {
  failNext = true;
  const g = game();
  const before = JSON.stringify(g);
  await recordGameState(g);
  assert.equal(JSON.stringify(g), before, "the corpus is strictly downstream of game state");
});

test("a successful write does not mutate the GameRecord either", async () => {
  const g = game();
  const before = JSON.stringify(g);
  await recordGameState(g);
  assert.equal(JSON.stringify(g), before);
});

test("unlinkPlayer never throws when the database is unavailable", async () => {
  failNext = true;
  assert.equal(await unlinkPlayer("abc123"), null);
});

test("unlinkPlayer clears player_id rather than deleting evidence", async () => {
  await unlinkPlayer("abc123");
  const text = issued();
  assert.match(text, /UPDATE corpus\.games SET player_id = NULL/);
  assert.doesNotMatch(text, /DELETE FROM corpus\.games/);
});

// --- repeated writes --------------------------------------------------------

test("replaying an identical sync issues the same statements and never throws", async () => {
  const g = game();
  const first = await recordGameState(g);
  const firstShape = calls.map((c) => c.sql);
  calls = [];
  const second = await recordGameState(g);
  assert.equal(first, "written");
  assert.equal(second, "written");
  assert.deepEqual(calls.map((c) => c.sql), firstShape);
});

// --- atomicity: the 2.2.0.2 partial-record defect ---------------------------

test("the whole record is written as ONE transaction, not a sequence", async () => {
  const g = game({
    phase: "complete",
    result: "composer_win_integrity_upheld",
    final_action: "concede",
    integrity_verdict: "upheld",
    revealed_target: "kanál",
  });
  assert.equal(await recordGameState(g), "written");

  assert.equal(transactions.length, 1, "exactly one transaction per sync");
  assert.equal(
    calls.length,
    transactions[0],
    "every statement must be inside that transaction — a statement outside it " +
      "is one that can commit while a later one fails, which is how a " +
      "'completed' game ended up with no resolution row"
  );
});

test("a concede game persists BOTH target and resolution in that transaction", async () => {
  // The exact production shape: 15 questions, turn 16 concede, integrity upheld.
  const qa = [...Array(15)].map((_, i) => entry({ turn_index: i + 1 }));
  qa.push(entry({ turn_index: 16, turn_type: "concede", question_text: null, composer_response: null }));

  const g = game({
    qa_log: qa,
    question_count: 15,
    phase: "complete",
    result: "composer_win_integrity_upheld",
    final_action: "concede",
    final_guess_text: null,
    adjudicator_verdict: null,
    integrity_verdict: "upheld",
    revealed_target: "kanál",
    revealed_definition: "evőeszköz",
    revealed_granularity: "generic_type",
  });

  assert.equal(await recordGameState(g), "written");
  const text = issued();
  assert.match(text, /INSERT INTO corpus\.game_targets/, "target row missing — the 2.2.0.2 defect");
  assert.match(text, /INSERT INTO corpus\.game_resolutions/, "resolution row missing");
});

test("children resolve the parent by subquery, never by a returned id", async () => {
  await recordGameState(game({ phase: "complete", revealed_target: "x" }));
  const children = calls.filter((c) => !/INSERT INTO corpus\.games/.test(c.sql));

  assert.ok(children.length > 0);
  for (const c of children) {
    assert.match(
      c.sql,
      /SELECT corpus_game_id FROM corpus\.games\s+WHERE operational_game_id/,
      `child statement must look the parent up: ${c.sql.slice(0, 60)}`
    );
  }
  // RETURNING would imply a value flowing between statements, which a
  // non-interactive transaction cannot do.
  assert.doesNotMatch(issued(), /RETURNING corpus_game_id/);
});

test("the parent upsert is the FIRST statement in the transaction", async () => {
  await recordGameState(game({ phase: "complete", revealed_target: "x" }));
  assert.match(
    calls[0]!.sql,
    /INSERT INTO corpus\.games/,
    "every child depends on the parent being visible, so it must run first"
  );
});

test("array parameters are sent as Postgres literals, not JSON", async () => {
  // `[1,2]` cannot cast to integer[]; `{1,2}` can.
  const g = game({
    phase: "complete",
    final_action: "guess",
    adjudicator_verdict: "incorrect",
    integrity_verdict: "violated",
    integrity_flagged_turns: [3, 7],
    revealed_target: "x",
  });
  await recordGameState(g);
  const flat = calls.flatMap((c) => c.values);
  assert.ok(flat.includes("{3,7}"), "expected a Postgres array literal");
  assert.equal(flat.includes("[3,7]" as unknown as SqlValue), false);
});

// --- static guards on the SQL that idempotency actually depends on ----------
//
// The application cannot enforce these; PostgreSQL does. What this file CAN do
// is fail loudly if a future edit removes them, which is the failure mode worth
// catching in CI.

const MIGRATION = readFileSync("migrations/0001_corpus_foundation.sql", "utf8");

test("migration keeps the operational-game uniqueness that upserts rely on", () => {
  assert.match(MIGRATION, /operational_game_id\s+uuid NOT NULL UNIQUE/);
});

test("migration keeps the main-sequence partial unique index", () => {
  assert.match(MIGRATION, /CREATE UNIQUE INDEX[\s\S]*?game_turns_main_sequence/);
  assert.match(MIGRATION, /WHERE branch = 'main'/);
});

test("migration keeps turn_id as the natural idempotency key", () => {
  assert.match(MIGRATION, /turn_id\s+uuid PRIMARY KEY/);
});

test("migration keeps finalized evidence immutable", () => {
  assert.match(MIGRATION, /games_immutable_once_finalized/);
  assert.match(MIGRATION, /turns_immutable_once_finalized/);
});

test("0002 lets a finalized turn be re-synced when nothing changes", () => {
  // Without this, replay and repair are impossible for exactly the games that
  // need them: full-state sync UPDATEs every existing turn, and the 0001
  // trigger raised on any UPDATE of a finalized game — even a no-op — rolling
  // the whole repair transaction back.
  const m2 = readFileSync("migrations/0002_repairable_finalized_turns.sql", "utf8");
  assert.match(m2, /CREATE OR REPLACE FUNCTION corpus\.reject_finalized_turn_mutation/);
  assert.match(m2, /ROW\(NEW\.\*\) IS DISTINCT FROM ROW\(OLD\.\*\)/);
  assert.match(m2, /RAISE EXCEPTION/, "a REAL change to finalized evidence must still raise");
  // Trigger body only — no schema change.
  assert.doesNotMatch(m2, /CREATE TABLE|ALTER TABLE|DROP TABLE|CREATE INDEX/);
});

test("immutability still permits the player_id unlink that deletion needs", () => {
  assert.match(MIGRATION, /- 'player_id'/);
});

test("raw and derived layers are separate schemas, not just separate tables", () => {
  assert.match(MIGRATION, /CREATE SCHEMA IF NOT EXISTS corpus/);
  assert.match(MIGRATION, /CREATE SCHEMA IF NOT EXISTS derived/);
  // Derived analysis must be attributable, or two contradictory scores on one
  // turn cannot be told apart.
  assert.match(MIGRATION, /derived\.analysis_runs/);
});

test("dormant per-turn analysis fields did NOT leak into raw evidence", () => {
  // quality_score / information_gain / strategy_classification are derived
  // analysis wearing a raw-evidence costume. They belong in derived.*.
  const turnsBlock = MIGRATION.slice(
    MIGRATION.indexOf("CREATE TABLE IF NOT EXISTS corpus.game_turns"),
    MIGRATION.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS game_turns_main_sequence")
  );
  for (const field of ["quality_score", "information_gain", "strategy_classification"]) {
    assert.doesNotMatch(turnsBlock, new RegExp(field));
  }
});
