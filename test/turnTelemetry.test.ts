import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  recordOperationStarted,
  recordOperationCompleted,
  findPresumedKilledOperations,
  TELEMETRY_TIMEOUT_CONFIG,
  type OperationHandle,
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
// prove Postgres's own `now() - interval` or `ON CONFLICT` execution
// semantics — that requires a live Neon run.
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
    if (text.includes("DO NOTHING") && failInsert) return Promise.reject(new Error("neon unavailable"));
    if (text.includes("DO UPDATE") && failUpdate) return Promise.reject(new Error("neon unavailable"));
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

test("REQUIRED 9: recordOperationStarted issues an INSERT ... ON CONFLICT DO NOTHING and always returns a usable handle", async () => {
  const handle = await recordOperationStarted({
    gameId: "g1",
    turnIndex: 3,
    operationKind: "provider_attempt",
    attemptNumber: 1,
    provider: "xai",
    modelId: null,
  });
  assert.equal(typeof handle.operationId, "string");
  assert.ok(handle.operationId.length > 0);
  assert.equal(handle.gameId, "g1");
  assert.equal(handle.turnIndex, 3);
  assert.equal(handle.operationKind, "provider_attempt");
  assert.equal(handle.attemptNumber, 1);
  assert.equal(handle.provider, "xai");
  assert.equal(handle.requestedModelId, null);

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /INSERT INTO corpus\.turn_operations/);
  assert.match(calls[0]!.sql, /ON CONFLICT \(operation_id\) DO NOTHING/);
  assert.deepEqual(calls[0]!.values, [handle.operationId, "g1", 3, "provider_attempt", 1, "xai", null]);
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

// --- REQUIRED 10: success/duplicate/provider-error/self-timeout terminal ---
// upsert. Terminal writes now go through the SAME idempotent
// INSERT ... ON CONFLICT DO UPDATE statement regardless of outcome.

function makeHandle(overrides: Partial<OperationHandle> = {}): OperationHandle {
  return {
    operationId: "op-1",
    gameId: "g1",
    turnIndex: 3,
    operationKind: "provider_attempt",
    attemptNumber: 1,
    provider: "xai",
    requestedModelId: "grok-requested",
    ...overrides,
  };
}

for (const status of ["accepted", "duplicate_rejected", "provider_error", "self_timeout"] as const) {
  test(`REQUIRED 10: recordOperationCompleted(${status}) issues the idempotent terminal upsert`, async () => {
    const handle = makeHandle();
    await recordOperationCompleted(handle, {
      status,
      latencyMs: 4321,
      errorClass: status === "provider_error" || status === "self_timeout" ? status : null,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /INSERT INTO corpus\.turn_operations/);
    assert.match(calls[0]!.sql, /ON CONFLICT \(operation_id\) DO UPDATE/);
    assert.match(calls[0]!.sql, /WHERE corpus\.turn_operations\.status = 'started'/, "a terminal row must never be overwritten by a later write");
    assert.match(calls[0]!.sql, /model_id = COALESCE\(EXCLUDED\.model_id, corpus\.turn_operations\.model_id\)/);
    // (operation_id, game_id, turn_index, operation_kind, attempt_number, provider, model_id, status, latency_ms, error_class)
    assert.deepEqual(calls[0]!.values, [
      "op-1",
      "g1",
      3,
      "provider_attempt",
      1,
      "xai",
      "grok-requested", // modelId omitted on completion -- falls back to the handle's requested model
      status,
      4321,
      status === "provider_error" || status === "self_timeout" ? status : null,
    ]);
  });
}

test("REQUIRED (model tracking): recordOperationCompleted's row carries the RESOLVED model when one is explicitly given (a successful attempt)", async () => {
  const handle = makeHandle();
  await recordOperationCompleted(handle, {
    status: "accepted",
    latencyMs: 100,
    errorClass: null,
    modelId: "grok-4.20-0309-reasoning",
  });
  assert.deepEqual(calls[0]!.values, [
    "op-1",
    "g1",
    3,
    "provider_attempt",
    1,
    "xai",
    "grok-4.20-0309-reasoning",
    "accepted",
    100,
    null,
  ]);
});

// ---------------------------------------------------------------------------
// ROUND 2 REVIEW FIX — the orphaned-row problem, closed via a client-
// generated operation_id and an idempotent start/terminal write pair.
//
// `fakeSql` above only records WHAT was asked. These tests need to verify
// RESULTING STATE ("a late start write can never revive a terminal row"),
// which requires actually applying the same ON CONFLICT semantics a real
// Postgres server would to an in-memory row per operation_id. Everything
// about TIMING here is small and controlled (a handful of milliseconds via
// real setTimeout, never a 45–300s wait) — only the ORDER of writes is what
// each test manipulates and asserts on.
// ---------------------------------------------------------------------------

interface FakeRow {
  status: string;
  latency_ms: unknown;
  error_class: unknown;
  model_id: unknown;
}

function statefulFakeSql(opts: { delayStartMs?: number; failStart?: boolean } = {}) {
  const rows = new Map<string, FakeRow>();
  const fn = Object.assign(
    async (strings: TemplateStringsArray, ...values: SqlValue[]) => {
      const text = strings.join("?");
      if (text.trim().startsWith("SELECT")) {
        // Mirrors findPresumedKilledOperations' own WHERE status = 'started'
        // predicate; the real age comparison is Postgres-only (see the file
        // header), so every row still 'started' is returned regardless of age
        // — sufficient to prove a TERMINAL row is never among them.
        return Array.from(rows.entries())
          .filter(([, row]) => row.status === "started")
          .map(([operationId]) => ({
            operation_id: operationId,
            game_id: "g1",
            turn_index: 1,
            operation_kind: "provider_attempt",
            started_at: "2020-01-01T00:00:00.000Z",
          }));
      }
      if (!text.trim().startsWith("INSERT INTO corpus.turn_operations")) return [];

      const operationId = String(values[0]);
      const modelId = values[6] ?? null;

      if (text.includes("DO NOTHING")) {
        if (opts.delayStartMs) {
          await new Promise((resolve) => setTimeout(resolve, opts.delayStartMs));
        }
        if (opts.failStart) throw new Error("simulated start-write failure");
        if (!rows.has(operationId)) {
          rows.set(operationId, { status: "started", latency_ms: null, error_class: null, model_id: modelId });
        }
        return [];
      }

      // ON CONFLICT (operation_id) DO UPDATE ... WHERE status = 'started'
      const status = String(values[7]);
      const latencyMs = values[8] ?? null;
      const errorClass = values[9] ?? null;
      const existing = rows.get(operationId);
      if (!existing) {
        rows.set(operationId, { status, latency_ms: latencyMs, error_class: errorClass, model_id: modelId });
      } else if (existing.status === "started") {
        existing.status = status;
        existing.latency_ms = latencyMs;
        existing.error_class = errorClass;
        existing.model_id = modelId ?? existing.model_id;
      }
      return [];
    },
    { transaction: (qs: Promise<Record<string, unknown>[]>[]) => Promise.all(qs), rows }
  );
  return fn;
}

test("ROUND 2 REQUIRED: a start write that exceeds the local ceiling and lands late (AFTER the terminal write already ran) never reverts the row to 'started'", async () => {
  const originalTimeoutMs = TELEMETRY_TIMEOUT_CONFIG.timeoutMs;
  TELEMETRY_TIMEOUT_CONFIG.timeoutMs = 5; // tiny, controlled ceiling -- not a real wait
  const sql = statefulFakeSql({ delayStartMs: 40 }); // exceeds the 5ms ceiling, still small and deterministic
  __setSqlClientForTests(sql as unknown as Parameters<typeof __setSqlClientForTests>[0]);
  try {
    const handle = await recordOperationStarted({
      gameId: "g1",
      turnIndex: 1,
      operationKind: "provider_attempt",
      attemptNumber: 1,
      provider: "xai",
      modelId: "requested-model",
    });
    // recordOperationStarted already returned (bounded by the 5ms ceiling);
    // its own underlying write is still in flight (40ms). The provider then
    // succeeds -- complete immediately, well before the delayed start lands.
    await recordOperationCompleted(handle, {
      status: "accepted",
      latencyMs: 10,
      errorClass: null,
      modelId: "resolved-model",
    });
    assert.equal(sql.rows.get(handle.operationId)?.status, "accepted", "terminal write landed first and created the row directly");

    // Now let the delayed start write actually land.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      sql.rows.get(handle.operationId)?.status,
      "accepted",
      "the late start write must never revert a terminal row back to 'started'"
    );
    assert.equal(sql.rows.get(handle.operationId)?.model_id, "resolved-model");
  } finally {
    TELEMETRY_TIMEOUT_CONFIG.timeoutMs = originalTimeoutMs;
    __setSqlClientForTests(fakeSql);
  }
});

test("ROUND 2 REQUIRED: a start write that fails outright still lets the terminal write create the correct terminal row", async () => {
  const sql = statefulFakeSql({ failStart: true });
  __setSqlClientForTests(sql as unknown as Parameters<typeof __setSqlClientForTests>[0]);
  try {
    const handle = await recordOperationStarted({
      gameId: "g1",
      turnIndex: 2,
      operationKind: "provider_attempt",
      attemptNumber: 1,
      provider: "anthropic",
      modelId: "requested-model",
    });
    assert.equal(typeof handle.operationId, "string", "the handle is still usable even though the start write failed");
    assert.equal(sql.rows.has(handle.operationId), false, "the start write never landed -- no row exists yet");

    await recordOperationCompleted(handle, {
      status: "provider_error",
      latencyMs: 75,
      errorClass: "provider_error",
    });
    const row = sql.rows.get(handle.operationId);
    assert.ok(row, "the terminal write must create the row directly when the start write never landed");
    assert.equal(row!.status, "provider_error");
    assert.equal(row!.latency_ms, 75);
    assert.equal(row!.model_id, "requested-model", "falls back to the handle's own requested model");
  } finally {
    __setSqlClientForTests(fakeSql);
  }
});

test("ROUND 2 REQUIRED: findPresumedKilledOperations does not return operations that completed via either path above", async () => {
  const sql = statefulFakeSql();
  __setSqlClientForTests(sql as unknown as Parameters<typeof __setSqlClientForTests>[0]);
  try {
    const h1 = await recordOperationStarted({
      gameId: "g1",
      turnIndex: 1,
      operationKind: "provider_attempt",
      attemptNumber: 1,
      provider: "xai",
      modelId: "m1",
    });
    await recordOperationCompleted(h1, { status: "accepted", latencyMs: 5, errorClass: null });

    const h2 = await recordOperationStarted({
      gameId: "g1",
      turnIndex: 2,
      operationKind: "provider_attempt",
      attemptNumber: 1,
      provider: "xai",
      modelId: "m2",
    });
    await recordOperationCompleted(h2, { status: "shared_budget_exhausted", latencyMs: 1, errorClass: "shared_budget_exhausted" });

    // A genuinely abandoned operation -- started, never completed -- must
    // still be found, or this test would trivially pass by finding nothing.
    await recordOperationStarted({
      gameId: "g1",
      turnIndex: 3,
      operationKind: "provider_attempt",
      attemptNumber: 1,
      provider: "xai",
      modelId: "m3",
    });

    const found = await findPresumedKilledOperations(300_000);
    assert.equal(found.length, 1, `expected exactly the one genuinely-abandoned operation; got ${JSON.stringify(found)}`);
    assert.notEqual(found[0]!.operationId, h1.operationId);
    assert.notEqual(found[0]!.operationId, h2.operationId);
  } finally {
    __setSqlClientForTests(fakeSql);
  }
});

// --- REQUIRED 12: telemetry failure never blocks gameplay -------------------

test("REQUIRED 12: a start write failure is swallowed -- the handle is still returned, does not throw", async () => {
  failInsert = true;
  const handle = await recordOperationStarted({
    gameId: "g1",
    turnIndex: 1,
    operationKind: "provider_attempt",
    attemptNumber: 1,
    provider: "xai",
    modelId: null,
  });
  assert.equal(typeof handle.operationId, "string");
});

test("REQUIRED 12: a terminal write failure is swallowed -- resolves, does not throw", async () => {
  failUpdate = true;
  await assert.doesNotReject(() =>
    recordOperationCompleted(makeHandle(), { status: "accepted", latencyMs: 100, errorClass: null })
  );
});

test("telemetry is inert when corpus is not configured (no DATABASE_URL) -- the default test environment, but the handle is still usable", async () => {
  delete process.env.DATABASE_URL;
  __setSqlClientForTests(null);
  const handle = await recordOperationStarted({
    gameId: "g1",
    turnIndex: 1,
    operationKind: "corpus_write",
    attemptNumber: null,
    provider: null,
    modelId: null,
  });
  assert.equal(typeof handle.operationId, "string");
  assert.equal(calls.length, 0, "no query should even be attempted");

  await assert.doesNotReject(() =>
    recordOperationCompleted(handle, { status: "written", latencyMs: 10, errorClass: null })
  );
  assert.equal(calls.length, 0, "still no query -- corpus remains unconfigured");
});

// --- REQUIRED 11: presumed_killed classification, no later request needed --

test("REQUIRED 11: findPresumedKilledOperations queries by status='started' and an age threshold, purely by reading -- no write is issued", async () => {
  // A "simulated platform kill" IS exactly this: a row inserted, never
  // updated (recordOperationCompleted never ran). Whether it is OLD ENOUGH
  // to classify as presumed_killed is Postgres's own now()-vs-started_at
  // arithmetic, which this environment cannot execute — see the file header.
  // What this test proves is the CONTRACT: the query targets the right
  // table/status, and the function maps whatever Postgres would have
  // filtered back into a typed result, without issuing any write.
  seededSelectRows = [
    { operation_id: "op-orphaned", game_id: "g1", turn_index: 1, operation_kind: "provider_attempt", started_at: "2026-01-01T00:00:00.000Z" },
  ];

  const found = await findPresumedKilledOperations(300_000);

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /SELECT .* FROM corpus\.turn_operations/s);
  assert.match(calls[0]!.sql, /status = 'started'/);
  assert.equal(
    calls.some((c) => /INSERT|UPDATE/.test(c.sql)),
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
