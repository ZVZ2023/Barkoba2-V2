import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createGame, getGame, acquireTurnLock } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { anthropicAdapter } from "../lib/providers/anthropic";
import { xaiAdapter } from "../lib/providers/xai";
import type { ToolCallRequest, ToolCallResult } from "../lib/providers/types";
import { TURN_BUDGET_CONFIG } from "../lib/turnBudget";
import { TELEMETRY_TIMEOUT_CONFIG } from "../lib/corpus/turnTelemetry";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";

// ---------------------------------------------------------------------------
// S2 / RB-2 — end-to-end route behavior for the bounded turn-execution
// budget. Same harness pattern as test/turnIntegrityHotfix.test.ts: the REAL
// route handler, the REAL gameStore, the in-memory KV fallback (no
// UPSTASH_*/DATABASE_URL set), only the Racer LLM call itself mocked.
// ---------------------------------------------------------------------------

async function makeGame() {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: "en",
  });
  return { gameId, game };
}

function turnRequest(gameId: string, body: Record<string, unknown> | undefined) {
  const json = body === undefined ? "" : JSON.stringify(body);
  return new NextRequest(`http://localhost/api/game/${gameId}/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": body === undefined ? "0" : String(Buffer.byteLength(json)),
    },
    body: body === undefined ? undefined : json,
  });
}

async function callTurn(gameId: string, body?: Record<string, unknown>) {
  const res = await turnPOST(turnRequest(gameId, body), { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

function stubRacerQuestions(questions: string[]) {
  const original = anthropicAdapter.callTool;
  let calls = 0;
  anthropicAdapter.callTool = (async () => {
    const q = questions[calls];
    calls += 1;
    return {
      output: { action: "question", question_text: q ?? `unexpected-call-${calls}`, guess_text: null, rationale: "test" },
      resolvedModel: "stub",
    } as ToolCallResult<unknown>;
  }) as typeof anthropicAdapter.callTool;
  return {
    callCount: () => calls,
    restore: () => {
      anthropicAdapter.callTool = original;
    },
  };
}

function stubRacerControlled() {
  const original = anthropicAdapter.callTool;
  let calls = 0;
  let resolveFn: ((v: ToolCallResult<unknown>) => void) | null = null;
  anthropicAdapter.callTool = (async () => {
    calls += 1;
    return new Promise<ToolCallResult<unknown>>((resolve) => {
      resolveFn = resolve;
    });
  }) as typeof anthropicAdapter.callTool;
  return {
    callCount: () => calls,
    resolveNext: (questionText: string) => {
      assert.ok(resolveFn, "no pending Racer call to resolve");
      resolveFn!({
        output: { action: "question", question_text: questionText, guess_text: null, rationale: "test" },
        resolvedModel: "stub",
      } as ToolCallResult<unknown>);
      resolveFn = null;
    },
    restore: () => {
      anthropicAdapter.callTool = original;
    },
  };
}

async function waitUntil(check: () => boolean, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition never became true");
}

// ---------------------------------------------------------------------------
// REQUIRED 1 & 2 — duplicate-guard attempts remain possible when fast; the
// shared budget does not shrink MAX_DUPLICATE_QUESTION_ATTEMPTS.
// ---------------------------------------------------------------------------

test("REQUIRED 1: a fast duplicate attempt followed by a valid replacement still succeeds within one invocation", async () => {
  const { gameId } = await makeGame();
  const opener = stubRacerQuestions(["Q1?"]);
  const opening = await callTurn(gameId);
  opener.restore();
  const rev = opening.data.game.revision;

  const stub = stubRacerQuestions(["Q1?", "Q2?"]); // Q1? duplicates the existing question
  try {
    const result = await callTurn(gameId, { answer: "YES", expected_revision: rev });
    assert.equal(result.status, 200);
    assert.equal(stub.callCount(), 2, "one blocked duplicate, one accepted replacement");
    assert.equal(result.data.game.qa_log.at(-1).question_text, "Q2?");
  } finally {
    stub.restore();
  }
});

test("REQUIRED 2: three attempts remain possible when earlier attempts are fast (two duplicates, then acceptance)", async () => {
  const { gameId } = await makeGame();
  const opener = stubRacerQuestions(["Q1?"]);
  const opening = await callTurn(gameId);
  opener.restore();
  const rev = opening.data.game.revision;

  const stub = stubRacerQuestions(["Q1?", "Q1?", "Q3?"]);
  try {
    const result = await callTurn(gameId, { answer: "YES", expected_revision: rev });
    assert.equal(result.status, 200);
    assert.equal(stub.callCount(), 3, "the shared budget must not cut this short when every attempt is fast");
    assert.equal(result.data.game.qa_log.at(-1).question_text, "Q3?");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// REQUIRED 5 — budget exhaustion: existing recoverable 502, answer preserved
// exactly once, no question appended. Forced deterministically by shrinking
// the shared config for the duration of one test — no real waiting.
// ---------------------------------------------------------------------------

test("REQUIRED 5: insufficient shared provider time returns the existing recoverable 502, preserves the submitted answer once, appends no question", async () => {
  const { gameId } = await makeGame();
  const opener = stubRacerQuestions(["Q1?"]);
  const opening = await callTurn(gameId);
  opener.restore();
  const rev = opening.data.game.revision;

  const originalSharedDeadlineMs = TURN_BUDGET_CONFIG.sharedDeadlineMs;
  TURN_BUDGET_CONFIG.sharedDeadlineMs = -1; // guarantees remainingMs < the 45s floor on attempt 1
  const stub = stubRacerQuestions(["SHOULD-NEVER-BE-CALLED"]);
  try {
    const result = await callTurn(gameId, { answer: "YES", expected_revision: rev });
    assert.equal(result.status, 502);
    assert.equal(result.data.error, "racer_unavailable");
    assert.equal(stub.callCount(), 0, "the model must never be called when shared budget is already exhausted");

    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log.length, 1, "no new question was appended");
    assert.equal(canonical!.qa_log[0]!.composer_response, "YES", "the submitted answer was preserved exactly once");
  } finally {
    TURN_BUDGET_CONFIG.sharedDeadlineMs = originalSharedDeadlineMs;
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// REQUIRED 13 — accepted questions populate QuestionLogEntry.latency_ms.
// ---------------------------------------------------------------------------

test("REQUIRED 13: an accepted question's latency_ms is populated with the provider attempt's own measured duration", async () => {
  const { gameId } = await makeGame();
  const stub = stubRacerQuestions(["Q1?"]);
  try {
    const result = await callTurn(gameId);
    assert.equal(result.status, 200);
    const entry = result.data.game.qa_log[0];
    assert.equal(typeof entry.latency_ms, "number");
    assert.ok(entry.latency_ms >= 0, "latency_ms must be a non-negative measured duration");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// REQUIRED 12 (route level) — telemetry failure never blocks gameplay or
// alters the player-facing result.
// ---------------------------------------------------------------------------

test("REQUIRED 12 (route level): a telemetry backend that always throws does not prevent an ordinary turn from succeeding", async () => {
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  const throwingSql = Object.assign(
    () => {
      throw new Error("neon unavailable");
    },
    { transaction: () => Promise.reject(new Error("neon unavailable")) }
  );
  __setSqlClientForTests(throwingSql as unknown as Parameters<typeof __setSqlClientForTests>[0]);

  const { gameId } = await makeGame();
  const stub = stubRacerQuestions(["Q1?"]);
  try {
    const result = await callTurn(gameId);
    assert.equal(result.status, 200, "a fully-failing telemetry backend must not surface as a player-facing error");
    assert.equal(result.data.game.qa_log[0].question_text, "Q1?");
  } finally {
    stub.restore();
    delete process.env.DATABASE_URL;
    delete process.env.CORPUS_ENABLED;
    __setSqlClientForTests(null);
  }
});

// ---------------------------------------------------------------------------
// REQUIRED 14 — corpus-write timing is recorded without changing persistence
// behavior: the CAS save still succeeds and reports the correct revision
// with telemetry wired in (mocked backend, since there is no live Postgres
// in this environment).
// ---------------------------------------------------------------------------

test("REQUIRED 14: corpus-write telemetry does not change the CAS/save outcome", async () => {
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  const inserted: string[] = [];
  const fakeSql = Object.assign(
    async (strings: TemplateStringsArray, ...values: SqlValue[]) => {
      const text = strings.join("?");
      if (text.trim().startsWith("INSERT")) {
        // (operation_id, game_id, turn_index, operation_kind, ...) in both
        // the start (DO NOTHING) and terminal (DO UPDATE) write shapes.
        inserted.push(String(values[3]));
        return [];
      }
      return [];
    },
    { transaction: (qs: Promise<Record<string, unknown>[]>[]) => Promise.all(qs) }
  );
  __setSqlClientForTests(fakeSql as unknown as Parameters<typeof __setSqlClientForTests>[0]);

  const { gameId } = await makeGame();
  const stub = stubRacerQuestions(["Q1?"]);
  try {
    const result = await callTurn(gameId);
    assert.equal(result.status, 200, "the save/CAS outcome is unchanged");
    assert.equal(result.data.game.revision, 1, "revision still advances exactly as before S2");
    assert.ok(inserted.includes("corpus_write"), "a corpus_write telemetry row must have been attempted");
  } finally {
    stub.restore();
    delete process.env.DATABASE_URL;
    delete process.env.CORPUS_ENABLED;
    __setSqlClientForTests(null);
  }
});

// ---------------------------------------------------------------------------
// REQUIRED 16 — the V2.8.1 CAS rule still prevents a discarded concurrent
// generation from being written, with the new budget/telemetry plumbing in
// runOneRacerAttempt. (test/turnIntegrityHotfix.test.ts's own CONCURRENCY
// test — unmodified by S2 — already covers concurrent ANSWERS; this covers
// concurrent GENERATION specifically, the scenario the S2 discovery pass
// flagged as newly possible once the lock TTL could theoretically outlive a
// slow call.)
// ---------------------------------------------------------------------------

test("REQUIRED 16: two concurrent generation attempts for the same turn — only one lands, via the existing lock, not a new mechanism", async () => {
  const { gameId } = await makeGame();
  const controlled = stubRacerControlled();
  try {
    const pA = callTurn(gameId);
    await waitUntil(() => controlled.callCount() === 1);

    const resultB = await callTurn(gameId);
    assert.equal(resultB.status, 409, "B must be rejected while A holds the lock");
    assert.equal(resultB.data.error, "turn_in_progress");
    assert.equal(controlled.callCount(), 1, "the losing request must never have reached the Racer");

    controlled.resolveNext("Q1?");
    const resultA = await pA;
    assert.equal(resultA.status, 200);

    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log.length, 1, "exactly one generation landed");
  } finally {
    controlled.restore();
  }
});

// ---------------------------------------------------------------------------
// REQUIRED 7 — AbortSignal reaches both provider fetch implementations.
// Direct adapter-level tests: mock the global fetch, assert the same signal
// object is forwarded. No network, no waiting.
// ---------------------------------------------------------------------------

test("REQUIRED 7: xaiAdapter forwards the caller's AbortSignal to fetch", async () => {
  const originalFetch = global.fetch;
  let capturedSignal: AbortSignal | undefined;
  global.fetch = (async (_url: string, options?: RequestInit) => {
    capturedSignal = options?.signal ?? undefined;
    return new Response(
      JSON.stringify({
        model: "grok-stub",
        choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "submit_turn", arguments: "{}" } }] } }],
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    process.env.XAI_API_KEY = "test-key";
    const controller = new AbortController();
    await xaiAdapter.callTool({
      model: "grok-stub",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      toolName: "submit_turn",
      toolDescription: "d",
      inputSchema: {},
      signal: controller.signal,
    });
    assert.equal(capturedSignal, controller.signal, "the exact same AbortSignal must reach fetch");
  } finally {
    global.fetch = originalFetch;
    delete process.env.XAI_API_KEY;
  }
});

test("REQUIRED 7: anthropicAdapter forwards the caller's AbortSignal to fetch", async () => {
  const originalFetch = global.fetch;
  let capturedSignal: AbortSignal | undefined;
  global.fetch = (async (_url: string, options?: RequestInit) => {
    capturedSignal = options?.signal ?? undefined;
    return new Response(
      JSON.stringify({ model: "claude-stub", content: [{ type: "tool_use", input: {} }] }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const controller = new AbortController();
    await anthropicAdapter.callTool({
      model: "claude-stub",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      toolName: "submit_turn",
      toolDescription: "d",
      inputSchema: {},
      signal: controller.signal,
    });
    assert.equal(capturedSignal, controller.signal, "the exact same AbortSignal must reach fetch");
  } finally {
    global.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("REQUIRED 7: unset signal produces a byte-identical request to pre-S2 (no signal key sent)", async () => {
  const originalFetch = global.fetch;
  let capturedOptions: RequestInit | undefined;
  global.fetch = (async (_url: string, options?: RequestInit) => {
    capturedOptions = options;
    return new Response(
      JSON.stringify({
        model: "grok-stub",
        choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "submit_turn", arguments: "{}" } }] } }],
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    process.env.XAI_API_KEY = "test-key";
    await xaiAdapter.callTool({
      model: "grok-stub",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      toolName: "submit_turn",
      toolDescription: "d",
      inputSchema: {},
      // signal deliberately omitted
    });
    assert.equal("signal" in (capturedOptions ?? {}), false, "unset signal must mean unchanged -- no signal key at all");
  } finally {
    global.fetch = originalFetch;
    delete process.env.XAI_API_KEY;
  }
});

// ---------------------------------------------------------------------------
// CODE REVIEW CORRECTIONS (verdict: REVISE) — findings 1-6.
// ---------------------------------------------------------------------------

/**
 * A fake corpus.turn_operations backend that DISCRIMINATES by operation_kind
 * (provider_attempt vs corpus_write) and by write phase (start vs terminal).
 *
 * ROUND 2 REVIEW FIX — both the start write and the terminal write are now
 * `INSERT INTO corpus.turn_operations` statements (an idempotent
 * `ON CONFLICT (operation_id) DO NOTHING` for the start, an idempotent
 * `ON CONFLICT (operation_id) DO UPDATE ... WHERE status = 'started'` for
 * the terminal write) — see lib/corpus/turnTelemetry.ts's module doc. They
 * are told apart here by that literal SQL text (DO NOTHING vs DO UPDATE),
 * and operation_kind is read directly out of each statement's own values
 * (position 3 in both shapes: operation_id, game_id, turn_index,
 * operation_kind, ...) — no id-to-kind lookup map is needed any more, since
 * every terminal write already carries its own operation_kind.
 */
function fakeSqlWithHooks(opts: {
  onStart?: (info: { kind: string; operationId: string; values: SqlValue[] }) => void;
  onTerminal?: (info: { kind: string; operationId: string; values: SqlValue[] }) => void;
  failEverythingElse?: boolean;
}) {
  const fn = Object.assign(
    async (strings: TemplateStringsArray, ...values: SqlValue[]) => {
      const text = strings.join("?");
      if (text.trim().startsWith("INSERT INTO corpus.turn_operations")) {
        const operationId = String(values[0]);
        const kind = String(values[3]);
        if (text.includes("DO NOTHING")) {
          opts.onStart?.({ kind, operationId, values });
        } else if (text.includes("DO UPDATE")) {
          opts.onTerminal?.({ kind, operationId, values });
        }
        return [];
      }
      if (opts.failEverythingElse) {
        throw new Error("simulated corpus write failure");
      }
      return [];
    },
    { transaction: (qs: Promise<Record<string, unknown>[]>[]) => Promise.all(qs) }
  );
  return fn as unknown as Parameters<typeof __setSqlClientForTests>[0];
}

function withFakeCorpus<T>(sql: ReturnType<typeof fakeSqlWithHooks>, fn: () => Promise<T>): Promise<T> {
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(sql);
  return fn().finally(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CORPUS_ENABLED;
    __setSqlClientForTests(null);
  });
}

// --- Finding 1: the shared deadline must be hard-bounded --------------------

test("FINDING 1a: the final gate recomputes the budget and can abandon an attempt the early gate had allowed", async () => {
  const { gameId } = await makeGame();
  const opener = stubRacerQuestions(["Q1?"]);
  const opening = await callTurn(gameId);
  opener.restore();
  const rev = opening.data.game.revision;

  const originalNow = Date.now;
  const startedAt = originalNow();
  let now = startedAt;
  Date.now = () => now;

  // Simulate slow pre-provider work (consumeModelCall + this very insert)
  // by advancing the clock the moment the telemetry start write runs --
  // exactly the gap the early gate cannot see.
  const terminalWrites: Array<{ kind: string; status: unknown }> = [];
  const sql = fakeSqlWithHooks({
    onStart: () => {
      now += 200_000; // leaves 40s of the 240s shared deadline -- below the 45s floor
    },
    onTerminal: ({ kind, values }) => terminalWrites.push({ kind, status: values[7] }),
  });

  const stub = stubRacerQuestions(["SHOULD-NEVER-BE-CALLED"]);
  try {
    const result = await withFakeCorpus(sql, () => callTurn(gameId, { answer: "YES", expected_revision: rev }));
    assert.equal(stub.callCount(), 0, "the provider must never be called once the recomputed budget is below the floor");
    assert.equal(result.status, 502);
    assert.equal(result.data.error, "racer_unavailable");
    // ROUND 2 REQUIRED: the final gate's abandoned attempt must be recorded
    // as a genuine terminal outcome, never left at 'started' (which would
    // make it indistinguishable from a killed attempt).
    const abandoned = terminalWrites.find((w) => w.kind === "provider_attempt");
    assert.ok(abandoned, `expected a provider_attempt terminal write; got ${JSON.stringify(terminalWrites)}`);
    assert.equal(abandoned!.status, "shared_budget_exhausted");
  } finally {
    stub.restore();
    Date.now = originalNow;
  }
});

test("FINDING 1b: a shrunk-but-sufficient remaining budget still proceeds, with the RECOMPUTED (smaller) allowance enforced", async () => {
  const { gameId } = await makeGame();
  const opener = stubRacerQuestions(["Q1?"]);
  const opening = await callTurn(gameId);
  opener.restore();
  const rev = opening.data.game.revision;

  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;

  const sql = fakeSqlWithHooks({
    onStart: () => {
      now += 100_000; // 240s - 100s = 140s remaining -- above the floor, below the 150s cap
    },
  });

  // Capture every setTimeout call and pick the one that is NOT
  // TELEMETRY_TIMEOUT_CONFIG.timeoutMs (2000ms) — recordOperationStarted's
  // OWN internal race timer fires first and would otherwise be mistaken for
  // runWithAbortTimeout's.
  const capturedMs: number[] = [];
  const originalSetTimeout = global.setTimeout;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
    if (typeof ms === "number") capturedMs.push(ms);
    return originalSetTimeout(fn as never, ms as never);
  }) as typeof setTimeout;

  const stub = stubRacerQuestions(["Q2?"]);
  try {
    const result = await withFakeCorpus(sql, () => callTurn(gameId, { answer: "YES", expected_revision: rev }));
    assert.equal(result.status, 200, "still enough budget to proceed");
    const providerTimers = capturedMs.filter((ms) => ms !== TELEMETRY_TIMEOUT_CONFIG.timeoutMs);
    assert.equal(providerTimers.length, 1, `expected exactly one runWithAbortTimeout timer; captured ${JSON.stringify(capturedMs)}`);
    const capturedAllowanceMs = providerTimers[0]!;
    // Recomputed AFTER the 100s simulated delay: ~140s, NOT the stale ~240s
    // (capped at 150s) the early gate would have produced before the delay.
    assert.ok(
      capturedAllowanceMs! <= 140_000 && capturedAllowanceMs! > 130_000,
      `expected the recomputed ~140s allowance, got ${capturedAllowanceMs}ms`
    );
  } finally {
    stub.restore();
    global.setTimeout = originalSetTimeout;
    Date.now = originalNow;
  }
});

test("FINDING 1c: insufficient shared budget can strike AFTER at least one duplicate, not only before attempt 1", async () => {
  const { gameId } = await makeGame();
  const opener = stubRacerQuestions(["Q1?"]);
  const opening = await callTurn(gameId);
  opener.restore();
  const rev = opening.data.game.revision;

  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;

  let startCount = 0;
  const sql = fakeSqlWithHooks({
    onStart: () => {
      startCount += 1;
      if (startCount === 2) now += 200_000; // only the SECOND attempt's pre-work is slow
    },
  });

  // Attempt 1 duplicates "Q1?" (fast, blocked by the duplicate guard).
  // Attempt 2 would be a fresh question, but its final gate must abandon it.
  const stub = stubRacerQuestions(["Q1?", "SHOULD-NEVER-BE-CALLED"]);
  try {
    const result = await withFakeCorpus(sql, () => callTurn(gameId, { answer: "YES", expected_revision: rev }));
    assert.equal(stub.callCount(), 1, "only attempt 1 (the duplicate) ever reached the provider");
    assert.equal(result.status, 502);
    assert.equal(result.data.error, "racer_unavailable");
  } finally {
    stub.restore();
    Date.now = originalNow;
  }
});

// --- Finding 2: latency_ms must reach corpus.game_turns, not only turn_operations

test("FINDING 2: an accepted turn's latency_ms reaches the corpus.game_turns INSERT payload", async () => {
  // A game with only an UNANSWERED Q1 does not qualify for corpus
  // preservation (hasPreservableEvidence requires at least one completed
  // question/answer interaction) -- syncGame() is never called and there is
  // no game_turns row to check yet. Answer Q1 first so preservation actually
  // runs, then inspect Q1's OWN latency_ms in that payload.
  let q1LatencyInPayload: unknown = "not-found";
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: SqlValue[]) => {
      const text = strings.join("?");
      if (text.includes("jsonb_to_recordset") && text.includes("INSERT INTO corpus.game_turns")) {
        // values[0] is game.game_id (used in the subquery ahead of the
        // jsonb_to_recordset() call); the turns payload is values[1].
        const turns = JSON.parse(String(values[1])) as Array<{ latency_ms: unknown; turn_index: number }>;
        const q1 = turns.find((t) => t.turn_index === 1);
        if (q1) q1LatencyInPayload = q1.latency_ms;
        return [];
      }
      if (text.trim().startsWith("INSERT INTO corpus.turn_operations")) return [{ operation_id: randomUUID() }];
      return [];
    },
    { transaction: (qs: Promise<Record<string, unknown>[]>[]) => Promise.all(qs) }
  );

  const { gameId } = await makeGame();
  const stub = stubRacerQuestions(["Q1?", "Q2?"]);
  try {
    const opening = await callTurn(gameId);
    const rev = opening.data.game.revision;
    const result = await withFakeCorpus(sql as unknown as ReturnType<typeof fakeSqlWithHooks>, () =>
      callTurn(gameId, { answer: "YES", expected_revision: rev })
    );
    assert.equal(result.status, 200);
    assert.equal(
      typeof q1LatencyInPayload,
      "number",
      `latency_ms must reach the game_turns row for Q1, not only turn_operations/HTTP/Redis (got ${JSON.stringify(q1LatencyInPayload)})`
    );
    assert.ok((q1LatencyInPayload as number) >= 0);
  } finally {
    stub.restore();
  }
});

// --- Finding 3: requested vs resolved model_id -------------------------------

test("FINDING 3a: a successful attempt's telemetry is updated with the RESOLVED model", async () => {
  const updates: Array<{ kind: string; status: unknown; modelId: unknown }> = [];
  const sql = fakeSqlWithHooks({
    onTerminal: ({ kind, values }) => {
      // (operation_id, game_id, turn_index, operation_kind, attempt_number, provider, model_id, status, latency_ms, error_class)
      updates.push({ kind, status: values[7], modelId: values[6] });
    },
  });

  const { gameId } = await makeGame();
  const stub = stubRacerQuestions(["Q1?"]);
  try {
    const result = await withFakeCorpus(sql, () => callTurn(gameId));
    assert.equal(result.status, 200);
    const accepted = updates.find((u) => u.kind === "provider_attempt" && u.status === "accepted");
    assert.ok(accepted, `an 'accepted' provider_attempt telemetry update must have been issued; got ${JSON.stringify(updates)}`);
    assert.equal(accepted!.modelId, result.data.game.qa_log[0].model_id, "telemetry's resolved model must match the turn's own recorded model_id");
    assert.notEqual(accepted!.modelId, null);
  } finally {
    stub.restore();
  }
});

test("FINDING 3b: a failed/timed-out attempt's terminal row keeps the REQUESTED model (never becomes null)", async () => {
  const starts: Array<{ kind: string; modelId: unknown }> = [];
  const updates: Array<{ kind: string; status: unknown; modelId: unknown }> = [];
  const sql = fakeSqlWithHooks({
    onStart: ({ kind, values }) => starts.push({ kind, modelId: values[6] }),
    onTerminal: ({ kind, values }) => updates.push({ kind, status: values[7], modelId: values[6] }),
  });

  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => {
    throw new Error("simulated provider failure");
  }) as typeof anthropicAdapter.callTool;

  const { gameId } = await makeGame();
  try {
    const result = await withFakeCorpus(sql, () => callTurn(gameId));
    assert.equal(result.status, 502);
    const providerStarts = starts.filter((i) => i.kind === "provider_attempt");
    assert.equal(providerStarts.length, 1);
    assert.notEqual(providerStarts[0]!.modelId, null, "the REQUESTED model must be recorded at start time");
    const failed = updates.find((u) => u.kind === "provider_attempt" && u.status === "provider_error");
    assert.ok(failed, `expected a provider_attempt provider_error terminal write; got ${JSON.stringify(updates)}`);
    assert.equal(
      failed!.modelId,
      providerStarts[0]!.modelId,
      "omitted on completion -- the terminal row falls back to the requested model recorded at start time, never nulling it"
    );
  } finally {
    anthropicAdapter.callTool = original;
  }
});

// --- Finding 4: a hung telemetry operation must not block gameplay ---------

test("FINDING 4: a telemetry INSERT that never settles does not prevent the provider call or the authoritative game save", async () => {
  const originalTimeoutMs = TELEMETRY_TIMEOUT_CONFIG.timeoutMs;
  TELEMETRY_TIMEOUT_CONFIG.timeoutMs = 20; // a controlled, tiny ceiling -- not a real 45-300s wait

  const sql = Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.trim().startsWith("INSERT INTO corpus.turn_operations")) {
        return new Promise<Record<string, unknown>[]>(() => {
          /* never settles -- simulates a stalled Neon connection */
        });
      }
      return [];
    },
    { transaction: (qs: Promise<Record<string, unknown>[]>[]) => Promise.all(qs) }
  );

  const { gameId } = await makeGame();
  const stub = stubRacerQuestions(["Q1?"]);
  try {
    const result = await withFakeCorpus(sql as unknown as ReturnType<typeof fakeSqlWithHooks>, () => callTurn(gameId));
    assert.equal(result.status, 200, "the provider call and authoritative save must proceed despite a hung telemetry insert");
    assert.equal(result.data.game.qa_log[0].question_text, "Q1?");
    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log[0]!.question_text, "Q1?", "the authoritative Redis record is unaffected");
  } finally {
    stub.restore();
    TELEMETRY_TIMEOUT_CONFIG.timeoutMs = originalTimeoutMs;
  }
});

// --- Finding 5: recordGameState()'s real outcome must be recorded honestly -

test("FINDING 5: a 'deferred' corpus outcome is durably distinguished from a 'written' one", async () => {
  const corpusWriteStatuses: unknown[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: SqlValue[]) => {
      const text = strings.join("?");
      if (text.trim().startsWith("INSERT INTO corpus.turn_operations")) {
        // Only the terminal write (DO UPDATE) carries a status; filter to
        // corpus_write specifically (operation_kind is values[3] in both
        // the start and terminal shapes) -- a provider_attempt's own
        // terminal statuses (accepted, etc.) must not leak into this list.
        if (text.includes("DO UPDATE") && String(values[3]) === "corpus_write") {
          corpusWriteStatuses.push(values[7]);
        }
        return [];
      }
      // Every other statement (corpus.games / corpus.game_turns / the
      // pending-replay queue) fails, forcing recordGameState() into its
      // documented 'deferred' branch (a caught exception during syncGame).
      throw new Error("simulated corpus write failure");
    },
    { transaction: (qs: Promise<Record<string, unknown>[]>[]) => Promise.all(qs) }
  );

  const { gameId } = await makeGame();
  const stub = stubRacerQuestions(["Q1?"]);
  try {
    // Q1 alone does not qualify for corpus preservation (no ANSWERED
    // question yet) -- answer it so hasPreservableEvidence() is true and
    // recordGameState() actually attempts syncGame() rather than returning
    // 'below_threshold' first.
    const opening = await withFakeCorpus(sql as unknown as ReturnType<typeof fakeSqlWithHooks>, () => callTurn(gameId));
    const rev = opening.data.game.revision;
    const stub2 = stubRacerQuestions(["Q2?"]);
    try {
      await withFakeCorpus(sql as unknown as ReturnType<typeof fakeSqlWithHooks>, () =>
        callTurn(gameId, { answer: "YES", expected_revision: rev })
      );
    } finally {
      stub2.restore();
    }
  } finally {
    stub.restore();
  }

  assert.ok(corpusWriteStatuses.includes("deferred"), `expected a 'deferred' corpus_write status; got ${JSON.stringify(corpusWriteStatuses)}`);
  assert.equal(corpusWriteStatuses.includes("written"), false, "a failed sync must never be recorded as written");
});

// --- Finding 6: additional route-level coverage -----------------------------

test("FINDING 6: the telemetry INSERT is issued before the real provider invocation", async () => {
  const order: string[] = [];
  const sql = fakeSqlWithHooks({ onStart: () => order.push("telemetry_insert") });

  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => {
    order.push("provider_call");
    return {
      output: { action: "question", question_text: "Q1?", guess_text: null, rationale: "test" },
      resolvedModel: "stub",
    } as ToolCallResult<unknown>;
  }) as typeof anthropicAdapter.callTool;

  const { gameId } = await makeGame();
  try {
    await withFakeCorpus(sql, () => callTurn(gameId));
    // The FIRST provider_attempt telemetry insert must precede the ONE
    // provider call this test makes. (A second, LATER telemetry insert for
    // the unrelated corpus_write of the accepted turn is expected and
    // irrelevant here -- only the ordering relative to the provider call
    // matters.)
    assert.deepEqual(order.slice(0, 2), ["telemetry_insert", "provider_call"]);
  } finally {
    anthropicAdapter.callTool = original;
  }
});

test("FINDING 6: a real local timeout is classified as self_timeout in telemetry, with the requested model retained", async () => {
  const originalPerAttempt = TURN_BUDGET_CONFIG.perAttemptMaxMs;
  const originalShared = TURN_BUDGET_CONFIG.sharedDeadlineMs;
  const originalMinRemaining = TURN_BUDGET_CONFIG.minRemainingToStartMs;
  TURN_BUDGET_CONFIG.perAttemptMaxMs = 10; // a controlled, tiny allowance -- not a real 150s wait
  TURN_BUDGET_CONFIG.sharedDeadlineMs = 10_000;
  // Must also shrink below sharedDeadlineMs, or the early/final gate sees
  // "10s remaining < the (still 45_000ms) floor" and abandons before ever
  // reaching the provider -- this is testing the ABORT path, not the budget
  // gate (that's FINDING 1's own coverage).
  TURN_BUDGET_CONFIG.minRemainingToStartMs = 1;

  const updates: Array<{ kind: string; status: unknown }> = [];
  const sql = fakeSqlWithHooks({ onTerminal: ({ kind, values }) => updates.push({ kind, status: values[7] }) });

  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async (request: ToolCallRequest) => {
    return new Promise((_, reject) => {
      request.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as typeof anthropicAdapter.callTool;

  const { gameId } = await makeGame();
  try {
    const result = await withFakeCorpus(sql, () => callTurn(gameId));
    assert.equal(result.status, 502);
    assert.ok(
      updates.some((u) => u.kind === "provider_attempt" && u.status === "self_timeout"),
      `expected a provider_attempt self_timeout status; got ${JSON.stringify(updates)}`
    );
  } finally {
    anthropicAdapter.callTool = original;
    TURN_BUDGET_CONFIG.perAttemptMaxMs = originalPerAttempt;
    TURN_BUDGET_CONFIG.sharedDeadlineMs = originalShared;
    TURN_BUDGET_CONFIG.minRemainingToStartMs = originalMinRemaining;
  }
});

test("FINDING 6: the turn lock, using a controlled clock, stays held past the 270s route boundary and is only acquirable after its own 300s TTL", async () => {
  const { gameId } = await createGame(randomUUID(), {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: "en",
  }).then((g) => ({ gameId: g.game_id }));

  const originalNow = Date.now;
  const start = originalNow();
  let now = start;
  Date.now = () => now;

  try {
    const firstAcquire = await acquireTurnLock(gameId, 300);
    assert.equal(firstAcquire, true);

    now = start + 270_000; // exactly the route's maxDuration boundary
    const stillHeld = await acquireTurnLock(gameId, 300);
    assert.equal(stillHeld, false, "the lock must still be held at the 270s route boundary");

    now = start + 300_000; // exactly its own TTL
    const stillHeldAtTtl = await acquireTurnLock(gameId, 300);
    assert.equal(stillHeldAtTtl, false, "the lock is live through its own TTL, not merely up to it");

    now = start + 300_001;
    const nowFree = await acquireTurnLock(gameId, 300);
    assert.equal(nowFree, true, "the lock must be acquirable the instant its TTL has actually elapsed");
  } finally {
    Date.now = originalNow;
  }
});
