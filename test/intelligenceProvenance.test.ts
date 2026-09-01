import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildTurnRows, recordGameState } from "../lib/corpus/gameCorpus";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { splitSqlStatements } from "../lib/corpus/sqlStatements";
import type { GameRecord, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.5 — Game Intelligence provenance capture.
//
// SCOPE, STATED HONESTLY, in the same terms as corpusPersistence.test.ts.
//
// Three kinds of assertion live here and they are NOT equally strong:
//
//   1. PURE LOGIC — buildTurnRows and the row shape. Real coverage.
//   2. EMITTED SQL — what the writer sends, captured through the fake client.
//      Real coverage of the statement, not of PostgreSQL's response to it.
//   3. SOURCE STRUCTURE — assertions about route text, following the existing
//      precedent in cluePolicy.test.ts. These are GUARDS AGAINST REGRESSION,
//      not proof of behaviour: the routes need a live KV, a live secret store
//      and a network call to invoke, so nothing here executes them. Where a
//      test is of this kind it says so.
//
// The distinction matters because the evidence this milestone captures is only
// as good as the claim made about it, and a source-text match is a weaker claim
// than an executed one.
// ---------------------------------------------------------------------------

function entry(overrides: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(),
    turn_index: 1,
    turn_type: "question",
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
    timestamp: "2026-08-15T10:00:00.000Z",
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
    revision: 0,
    player_id: null,
    composer_player_id: null,
    racer_player_id: null,
    join_code: null,
    phase: "questioning",
    created_at: "2026-08-15T09:59:00.000Z",
    expires_at: "2026-08-16T09:59:00.000Z",
    max_questions: 20,
    game_language: "hu",
    private_target: false,
    composer_kind: "human",
    racer_kind: "ai",
    racer_provider: null,
    difficulty: "hard",
    clue_mode: "none",
    question_count: 1,
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

// ---------------------------------------------------------------------------
// 1. branch_seq — the G6 guard.
//
// NO GAME IN THE PRODUCTION CORPUS HAS EVER HAD TWO CORRECTIONS. The
// corpus-wide check returned zero rows, so this failure mode has never been
// observed in the field and a synthetic fixture is the only instrument that can
// exercise it. That is precisely why the column shipped without field evidence:
// branch identity cannot be captured retroactively, so waiting for a real
// example would mean losing the structure of every game that produced one.
// ---------------------------------------------------------------------------

test("main-branch turns carry no branch_seq", () => {
  const g = game({ qa_log: [entry({ turn_index: 1, question_text: "q1" })] });
  const rows = buildTurnRows(g);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.branch, "main");
  assert.equal(rows[0]?.branch_seq, null);
});

test("two rewinds produce two distinguishable abandoned branches", () => {
  const g = game({
    qa_log: [entry({ turn_index: 1, question_text: "kept" })],
    abandoned_branches: [
      [
        entry({ turn_index: 2, question_text: "first-rewind-a" }),
        entry({ turn_index: 3, question_text: "first-rewind-b" }),
      ],
      [entry({ turn_index: 2, question_text: "second-rewind-a" })],
    ],
  });

  const abandoned = buildTurnRows(g).filter((r) => r.branch === "abandoned");
  assert.equal(abandoned.length, 3);

  const first = abandoned.filter((r) => r.branch_seq === 1);
  const second = abandoned.filter((r) => r.branch_seq === 2);

  assert.equal(first.length, 2, "the first rewind discarded two turns");
  assert.equal(second.length, 1, "the second rewind discarded one turn");

  // Within-branch order is preserved.
  assert.equal(first[0]?.question_text, "first-rewind-a");
  assert.equal(first[1]?.question_text, "first-rewind-b");

  // THE POINT OF THE COLUMN: turn_index 2 appears in BOTH branches. Without
  // branch_seq these two rows are indistinguishable, and occurred_at does not
  // separate them either — an abandoned turn carries its original creation
  // time, not its discard time.
  const atIndexTwo = abandoned.filter((r) => r.turn_index === 2);
  assert.equal(atIndexTwo.length, 2);
  assert.notEqual(atIndexTwo[0]?.branch_seq, atIndexTwo[1]?.branch_seq);
});

// ---------------------------------------------------------------------------
// 2. raw_output purity.
//
// Pins the invariant the V2.5-1 production verification established: across all
// 86 stored turns of a real completed game, the only keys in any persisted
// raw_output were action, guess_text, question_text and rationale. Provenance
// was added in dedicated columns precisely so that stayed true — raw_output is
// defined as the participant's own structured output, and a model id is a fact
// about the call, not a move.
// ---------------------------------------------------------------------------

test("provenance never leaks into raw_output", () => {
  const racerOutput = {
    action: "question",
    question_text: "Élőlény?",
    guess_text: null,
    rationale: "Halving the space.",
  };
  const g = game({
    qa_log: [
      entry({
        turn_index: 1,
        question_text: "Élőlény?",
        racer_output_raw: JSON.stringify(racerOutput),
        model_id: "claude-haiku-4-5-20251001",
        model_provider: "anthropic",
        prompt_version: "racer/2.5.0",
      }),
    ],
  });

  const row = buildTurnRows(g)[0];
  assert.ok(row);
  assert.deepEqual(
    Object.keys(row.raw_output as Record<string, unknown>).sort(),
    ["action", "guess_text", "question_text", "rationale"]
  );

  // Present, but in their own fields.
  assert.equal(row.model_id, "claude-haiku-4-5-20251001");
  assert.equal(row.model_provider, "anthropic");
  assert.equal(row.prompt_version, "racer/2.5.0");
});

test("a turn played before 2.5.0.0 keeps null provenance rather than a guess", () => {
  const g = game({ qa_log: [entry({ turn_index: 1, question_text: "q" })] });
  const row = buildTurnRows(g)[0];
  assert.ok(row);
  // NULL means "not captured". It must never be filled in from today's config:
  // that would assert a fact nobody observed.
  assert.equal(row.model_id, null);
  assert.equal(row.model_provider, null);
  assert.equal(row.prompt_version, null);
  assert.equal(row.answered_at, null);
  assert.equal(row.pre_revision_question_text, null);
});

test("answered_at and the pre-revision question reach the row when set", () => {
  const g = game({
    qa_log: [
      entry({
        turn_index: 1,
        question_text: "Egy konkrét autó?",
        pre_revision_question_text: "Ez egy piros Citroën C4?",
        answered_at: "2026-08-15T10:00:42.000Z",
        guess_detector_flagged: true,
      }),
    ],
  });
  const row = buildTurnRows(g)[0];
  assert.ok(row);
  assert.equal(row.answered_at, "2026-08-15T10:00:42.000Z");
  assert.equal(row.pre_revision_question_text, "Ez egy piros Citroën C4?");
  // The recorded question is the revision; the original survives beside it.
  assert.notEqual(row.question_text, row.pre_revision_question_text);
});

// ---------------------------------------------------------------------------
// 3. The emitted SQL.
// ---------------------------------------------------------------------------

let calls: { sql: string; values: SqlValue[] }[] = [];

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  calls.push({ sql: strings.join("?"), values });
  return Promise.resolve([] as Record<string, unknown>[]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

beforeEach(() => {
  calls = [];
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
});

function turnsStatement(): string {
  const stmt = calls.map((c) => c.sql).find((s) => s.includes("INSERT INTO corpus.game_turns"));
  assert.ok(stmt, "expected a game_turns insert to be issued");
  return stmt;
}

const PROVENANCE_COLUMNS = [
  "model_id",
  "model_provider",
  "prompt_version",
  "answered_at",
  "pre_revision_question_text",
  "branch_seq",
];

/**
 * V2.5-B5 — the two kinds, split by WHEN the value is knowable.
 *
 * Known at row creation, and capable of differing on a later re-sync. Updating
 * them would raise the finalized-turn trigger and roll back the repair pass.
 */
const INSERT_ONLY_COLUMNS = [
  "model_id",
  "model_provider",
  "prompt_version",
  "pre_revision_question_text",
];

/**
 * Not knowable when the row is inserted — the answer arrives on the next
 * request, the branch number when a rewind happens. V2.5-3 treated these as
 * insert-only too, so they were never written at all.
 */
const WRITE_ONCE_COLUMNS = ["answered_at", "branch_seq"];

test("the turns insert, select and recordset lists stay in agreement", async () => {
  await recordGameState(
    game({ qa_log: [entry({ turn_index: 1, question_text: "q", composer_response: "YES" })] })
  );

  const stmt = turnsStatement();

  // A jsonb_to_recordset column list that drifts out of positional agreement
  // with the SELECT list shifts data silently into the wrong columns. It
  // produces no compile error and no runtime error — only wrong evidence.
  const insertList = stmt.slice(
    stmt.indexOf("INSERT INTO corpus.game_turns (") + "INSERT INTO corpus.game_turns (".length,
    stmt.indexOf(")\n      SELECT")
  );
  const recordsetList = stmt.slice(
    stmt.indexOf("AS t(") + "AS t(".length,
    stmt.indexOf(")\n      -- ---")
  );

  const insertCols = insertList.split(",").map((s) => s.trim()).filter(Boolean);
  const recordsetCols = recordsetList
    .split(",")
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean);

  // The insert list carries corpus_game_id, which is resolved by subquery and
  // is therefore not part of the recordset.
  assert.equal(
    insertCols.length,
    recordsetCols.length + 1,
    "insert column count must equal recordset column count plus corpus_game_id"
  );

  for (const col of PROVENANCE_COLUMNS) {
    assert.ok(insertCols.includes(col), `insert list must carry ${col}`);
    assert.ok(recordsetCols.includes(col), `recordset list must carry ${col}`);
  }
});

test("insert-only provenance is never written by ON CONFLICT DO UPDATE", async () => {
  await recordGameState(
    game({ qa_log: [entry({ turn_index: 1, question_text: "q", composer_response: "YES" })] })
  );

  const stmt = turnsStatement();
  const doUpdate = stmt.slice(stmt.indexOf("ON CONFLICT (turn_id) DO UPDATE SET"));

  // THE PRODUCTION HAZARD THIS GUARDS.
  //
  // reject_finalized_turn_mutation permits a no-op re-sync of a finalized
  // game's turns and raises on any real change. model_id and prompt_version can
  // legitimately differ between the first write and a later re-sync — the env
  // override may have moved, the prompt version may have been bumped — so
  // updating them here would raise and roll back the entire transaction,
  // including the repair pass that re-sync exists to serve.
  for (const col of INSERT_ONLY_COLUMNS) {
    assert.ok(
      !doUpdate.includes(`${col} `) && !doUpdate.includes(`${col}=`),
      `${col} must not appear in the turns DO UPDATE set-list`
    );
  }
});

test("write-once columns ARE updated, and only from null", async () => {
  await recordGameState(
    game({ qa_log: [entry({ turn_index: 1, question_text: "q", composer_response: "YES" })] })
  );

  const stmt = turnsStatement();
  const doUpdate = stmt.slice(stmt.indexOf("ON CONFLICT (turn_id) DO UPDATE SET"));

  for (const col of WRITE_ONCE_COLUMNS) {
    assert.ok(doUpdate.includes(col), `${col} must be in the DO UPDATE set-list`);
    // COALESCE, NOT a bare EXCLUDED assignment. A bare assignment would
    // overwrite a recorded value on every re-sync, which on a finalized game is
    // a real change and raises — the exact failure the insert-only rule was
    // protecting against. COALESCE makes it write-once: null becomes a value
    // once, then every later re-sync is a genuine no-op.
    assert.match(
      doUpdate,
      new RegExp(`${col}\\s*=\\s*COALESCE\\(corpus\\.game_turns\\.${col},\\s*EXCLUDED\\.${col}\\)`),
      `${col} must be COALESCE-guarded, never a bare EXCLUDED assignment`
    );
  }
});

test("the demotion statement numbers each abandoned turn individually", async () => {
  // Two rewinds, and turn_index 2 appears in both. A single-value array update
  // cannot express this — which is why branch_seq was null on 6 of 6 abandoned
  // turns in production.
  await recordGameState(
    game({
      qa_log: [entry({ turn_index: 1, question_text: "kept", composer_response: "YES" })],
      abandoned_branches: [
        [entry({ turn_index: 2, question_text: "first-a", composer_response: "NO" })],
        [entry({ turn_index: 2, question_text: "second-a", composer_response: "NO" })],
      ],
    })
  );

  const demote = calls
    .map((c) => c.sql)
    .find((s) => s.includes("UPDATE corpus.game_turns AS g"));
  assert.ok(demote, "expected a demotion statement");

  assert.match(demote, /SET branch = 'abandoned'/);
  assert.match(demote, /branch_seq = COALESCE\(g\.branch_seq, d\.branch_seq\)/);
  // Per-turn join, not a flat array of ids.
  assert.match(demote, /jsonb_to_recordset/);
  assert.match(demote, /AS d\(turn_id uuid, branch_seq integer\)/);
  assert.doesNotMatch(demote, /turn_id = ANY\(/, "the array form cannot carry a sequence");

  // Both branch numbers are actually sent.
  const payload = calls
    .map((c) => c.values)
    .flat()
    .map(String)
    .find((v) => v.includes("branch_seq"));
  assert.ok(payload, "the demotion payload must carry branch_seq values");
  assert.match(payload, /"branch_seq":1/);
  assert.match(payload, /"branch_seq":2/);
});

test("benchmark identity is inserted but never updated", async () => {
  await recordGameState(
    game({
      benchmark_case_id: "red-citroen-c4",
      benchmark_run_id: randomUUID(),
      qa_log: [entry({ turn_index: 1, question_text: "q", composer_response: "YES" })],
    })
  );

  const stmt = calls.map((c) => c.sql).find((s) => s.includes("INSERT INTO corpus.games"));
  assert.ok(stmt);
  assert.ok(stmt.includes("benchmark_case_id"), "the games insert must carry the case id");

  const doUpdate = stmt.slice(stmt.indexOf("DO UPDATE SET"));
  // corpus.games is immutable once finalized, and 0003's exemption list does
  // not include these. A re-sync that tried to rewrite them would raise.
  assert.ok(!doUpdate.includes("benchmark_case_id"));
  assert.ok(!doUpdate.includes("benchmark_run_id"));
});

// ---------------------------------------------------------------------------
// 4. The migration itself.
// ---------------------------------------------------------------------------

const MIGRATION = readFileSync("migrations/0005_intelligence_provenance.sql", "utf8");

test("migration 0005 is idempotent by construction", () => {
  const statements = splitSqlStatements(MIGRATION);
  assert.ok(statements.length > 0, "the splitter must find statements");

  for (const s of statements) {
    const head = s.split("\n").find((l) => l.trim().length > 0) ?? "";
    assert.match(
      s,
      /IF NOT EXISTS/i,
      `every statement must be re-runnable; this one is not: ${head}`
    );
  }
});

test("migration 0005 is purely additive — it touches no existing evidence", () => {
  // Strip comments before pattern-matching, or the migration's own prose about
  // what it deliberately does NOT do would trip every assertion below.
  const sql = MIGRATION.split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  // Nothing may rewrite existing rows or redefine existing behaviour.
  for (const forbidden of [
    /\bUPDATE\b/i,
    /\bDELETE\b/i,
    /\bDROP\b/i,
    /CREATE\s+OR\s+REPLACE\s+FUNCTION/i,
    /CREATE\s+TRIGGER/i,
  ]) {
    assert.doesNotMatch(
      sql,
      forbidden,
      `0005 must stay additive; found ${forbidden}. A backfill or a trigger ` +
        `change here would rewrite evidence or weaken an immutability guarantee.`
    );
  }

  // NOT NULL and DEFAULT are checked against COLUMN DEFINITIONS only. A blanket
  // scan would trip on `WHERE ... IS NOT NULL` in the partial index predicates,
  // which is the opposite of the thing being guarded against.
  const addColumnLines = sql
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => /ADD COLUMN/i.test(s));

  assert.ok(addColumnLines.length === 8, "0005 must add exactly the eight audited columns");

  for (const line of addColumnLines) {
    // A DEFAULT would assert a fact about historical rows that nobody observed;
    // a NOT NULL would force a rewrite of a table whose value is that it has
    // never been rewritten. NULL must keep meaning "not captured".
    assert.doesNotMatch(line, /\bNOT\s+NULL\b/i, `column must stay nullable: ${line}`);
    assert.doesNotMatch(line, /\bDEFAULT\b/i, `column must carry no default: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Route structure guards.
//
// SOURCE-TEXT ASSERTIONS, following cluePolicy.test.ts. These do not execute
// the routes — that needs a live KV, a live secret store and a network call.
// They are regression guards on the two capture points whose whole value is
// that they happen at a specific moment in the control flow, where an innocent
// reordering would silently restore the evidence loss.
// ---------------------------------------------------------------------------

const TURN_ROUTE = readFileSync("app/api/game/[id]/turn/route.ts", "utf8");

test("the flagged question is captured before either resolution branch can destroy it", () => {
  const capture = TURN_ROUTE.indexOf("preRevisionQuestion = turn.question_text");
  const confirmBranch = TURN_ROUTE.indexOf('resolution.resolution === "confirm_guess"');
  const reviseBranch = TURN_ROUTE.indexOf("resolution.revised_question");

  assert.ok(capture > 0, "the pre-revision capture must exist");
  assert.ok(confirmBranch > 0 && reviseBranch > 0, "both resolution branches must exist");

  // confirm_guess NULLS question_text; continue_questioning REPLACES it. Both
  // destroy the original, so the capture has to precede both.
  assert.ok(capture < confirmBranch, "capture must precede the confirm_guess rewrite");
  assert.ok(capture < reviseBranch, "capture must precede the revision rewrite");

  assert.match(TURN_ROUTE, /entry\.pre_revision_question_text = preRevisionQuestion/);
});

test("answered_at is stamped where the answer is recorded, not where the turn is created", () => {
  const assignment = TURN_ROUTE.indexOf("pending.composer_response = answer");
  const stamp = TURN_ROUTE.indexOf("pending.answered_at");
  assert.ok(assignment > 0 && stamp > assignment);
  // The blank-entry factory must NOT pre-fill it, or every turn would claim to
  // have been answered the moment it was asked.
  assert.match(TURN_ROUTE, /answered_at: null,/);
});

const CREATE_ROUTE = readFileSync("app/api/game/create/route.ts", "utf8");

test("benchmark tagging fails closed and is never client-supplied", () => {
  const fn = CREATE_ROUTE.slice(
    CREATE_ROUTE.indexOf("function resolveBenchmark"),
    CREATE_ROUTE.indexOf("interface CreateGameBody")
  );
  assert.ok(fn.length > 0, "could not isolate resolveBenchmark");

  // No configured secret means no tagging, ever.
  assert.match(fn, /if \(!configured\) return none;/);
  // The run id is minted here, so no caller can merge itself into an existing
  // comparison set.
  assert.match(fn, /randomUUID\(\)/);
  // The case id comes from a header, gated on the secret — never from the body.
  assert.match(fn, /x-barkoba-benchmark-case/);
  assert.doesNotMatch(fn, /body\./, "the benchmark tag must not be readable from the request body");
});
