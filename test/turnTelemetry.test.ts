import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  recordOperationStarted,
  recordOperationCompleted,
  findPresumedKilledOperations,
} from "../lib/corpus/turnTelemetry";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { splitSqlStatements } from "../lib/corpus/sqlStatements";

// ---------------------------------------------------------------------------
// S2 / RB-2 — durable turn-operation telemetry.
//
// SCOPE, STATED HONESTLY, matching test/corpusPersistence.test.ts's own
// stated scope: there is no PostgreSQL in this test environment. These tests
// verify what the application DOES (which statements it issues, in what
// order, how it maps results, and how it behaves when the database refuses)
// plus a static guard that the migration SQL is well-formed. They do NOT
// prove Postgres's own `now() - interval` arithmetic — that requires a live
// Neon run.
// ---------------------------------------------------------------------------

interface Recorded {
  sql: string;
  values: SqlValue[];
}

let calls: Recorded[] = [];
let failInsert = false;
let failUpdate = false;
/** Seeded rows a SELECT should return, when the test wants to control that directly. */
let seededSelectRows: Record<string, unknown>[] = [];

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const text = strings.join("?");
  calls.push({ sql: text, values });

  if (text.trim().startsWith("INSERT")) {
    if (failInsert) return Promise.reject(new Error("neon unavailable"));
    return Promise.resolve([{ operation_id: "op-" + calls.length }]);
  }
  if (text.trim().startsWith("UPDATE")) {
    if (failUpdate) return Promise.reject(new Error("neon unavailable"));
    return Promise.resolve([]);
  }
  if (text.trim().startsWith("SELECT")) {
    return Promise.resolve(seededSelectRows);
  }
  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

beforeEach(() => {
  calls = [];
  failInsert = false;
  failUpdate = false;
  seededSelectRows = [];
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
});

// --- REQUIRED 9: a durable started row exists before provider fetch begins -

test("REQUIRED 9: recordOperationStarted issues an INSERT and returns the new operation_id", async () => {
  const id = await recordOperationStarted({
    gameId: "g1",
    turnIndex: 3,
    operationKind: "provider_attempt",
    attemptNumber: 1,
    provider: "xai",
    modelId: null,
  });
  assert.equal(id, "op-1");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /INSERT INTO corpus\.turn_operations/);
  assert.match(calls[0]!.sql, /VALUES/);
  assert.deepEqual(calls[0]!.values, ["g1", 3, "provider_attempt", 1, "xai", null]);
});

test("REQUIRED 9: no secret-shaped fields are ever part of the insert's values", async () => {
  await recordOperationStarted({
    gameId: "g1",
    turnIndex: 1,
    operationKind: "provider_attempt",
    attemptNumber: 1,
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
  });
  const values = calls[0]!.values.map((v) => String(v));
  for (const forbidden of ["target", "answer", "prompt", "tool_call", "authorization", "api_key"]) {
    assert.equal(
      values.some((v) => v.toLowerCase().includes(forbidden)),
      false,
      `must not carry anything shaped like "${forbidden}"`
    );
  }
});

// --- REQUIRED 10: success/duplicate/provider-error/self-timeout update -----

for (const status of ["accepted", "duplicate_rejected", "provider_error", "self_timeout"] as const) {
  test(`REQUIRED 10: recordOperationCompleted(${status}) issues the matching UPDATE`, async () => {
    await recordOperationCompleted({
      operationId: "op-1",
      status,
      latencyMs: 4321,
      errorClass: status === "provider_error" || status === "self_timeout" ? status : null,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /UPDATE corpus\.turn_operations/);
    assert.match(calls[0]!.sql, /WHERE operation_id/);
    assert.deepEqual(calls[0]!.values, [
      status,
      4321,
      status === "provider_error" || status === "self_timeout" ? status : null,
      "op-1",
    ]);
  });
}

// --- REQUIRED 12: telemetry failure never blocks gameplay -------------------

test("REQUIRED 12: an insert failure is swallowed -- returns null, does not throw", async () => {
  failInsert = true;
  const id = await recordOperationStarted({
    gameId: "g1",
    turnIndex: 1,
    operationKind: "provider_attempt",
    attemptNumber: 1,
    provider: "xai",
    modelId: null,
  });
  assert.equal(id, null);
});

test("REQUIRED 12: an update failure is swallowed -- resolves, does not throw", async () => {
  failUpdate = true;
  await assert.doesNotReject(() =>
    recordOperationCompleted({ operationId: "op-1", status: "accepted", latencyMs: 100, errorClass: null })
  );
});

test("telemetry is inert when corpus is not configured (no DATABASE_URL) -- the default test environment", async () => {
  delete process.env.DATABASE_URL;
  __setSqlClientForTests(null);
  const id = await recordOperationStarted({
    gameId: "g1",
    turnIndex: 1,
    operationKind: "corpus_write",
    attemptNumber: null,
    provider: null,
    modelId: null,
  });
  assert.equal(id, null);
  assert.equal(calls.length, 0, "no query should even be attempted");
});

// --- REQUIRED 11: presumed_killed classification, no later request needed --

test("REQUIRED 11: findPresumedKilledOperations queries by status='started' and an age threshold, purely by reading -- no write is issued", async () => {
  // A "simulated platform kill" IS exactly this: a row inserted, never
  // updated (recordOperationCompleted never ran). Whether it is OLD ENOUGH
  // to classify as presumed_killed is Postgres's own now()-vs-started_at
  // arithmetic, which this environment cannot execute — see the file header.
  // What this test proves is the CONTRACT: the query targets the right
  // table/status, and the function maps whatever Postgres would have
  // filtered back into a typed result, without issuing any UPDATE.
  seededSelectRows = [
    { operation_id: "op-orphaned", game_id: "g1", turn_index: 1, operation_kind: "provider_attempt", started_at: "2026-01-01T00:00:00.000Z" },
  ];

  const found = await findPresumedKilledOperations(300_000);

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /SELECT .* FROM corpus\.turn_operations/s);
  assert.match(calls[0]!.sql, /status = 'started'/);
  assert.equal(
    calls.some((c) => /UPDATE/.test(c.sql)),
    false,
    "classification must be a pure read -- no write required for a row to be discoverable"
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.operationId, "op-orphaned");
  assert.equal(found[0]!.gameId, "g1");
});

test("findPresumedKilledOperations returns [] rather than throwing when the query itself fails", async () => {
  __setSqlClientForTests(((..._args: unknown[]) => {
    throw new Error("neon unavailable");
  }) as unknown as typeof fakeSql);
  const found = await findPresumedKilledOperations(300_000);
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------------------
// The migration itself is well-formed (same pattern as
// test/sqlStatements.test.ts's existing check against migration 0001).
// ---------------------------------------------------------------------------

test("migrations/0012_turn_operation_telemetry.sql splits into well-formed statements", () => {
  const body = readFileSync("migrations/0012_turn_operation_telemetry.sql", "utf8");
  const statements = splitSqlStatements(body);
  assert.ok(statements.length >= 3, "expected at least the CREATE TABLE and two CREATE INDEX statements");
  assert.ok(statements.some((s) => /CREATE TABLE IF NOT EXISTS corpus\.turn_operations/.test(s)));
  assert.ok(statements.some((s) => /turn_operations_game_turn_idx/.test(s)));
  assert.ok(statements.some((s) => /turn_operations_stale_started_idx/.test(s)));
});

test("the migration stores no secret-shaped, answer-shaped, or prompt-shaped columns", () => {
  // Comment lines legitimately EXPLAIN what is excluded (see the migration's
  // own header) and would otherwise trip this check on their own words —
  // strip them first so only actual column/constraint definitions are
  // scanned.
  const body = readFileSync("migrations/0012_turn_operation_telemetry.sql", "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .toLowerCase();
  for (const forbidden of [
    "target",
    "secret",
    "answer",
    "explanation",
    "prompt",
    "question_text",
    "tool_call",
    "credential",
    "authorization",
  ]) {
    assert.equal(body.includes(forbidden), false, `migration must not define a "${forbidden}"-shaped column`);
  }
});
