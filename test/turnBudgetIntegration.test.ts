import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createGame, getGame } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { anthropicAdapter } from "../lib/providers/anthropic";
import { xaiAdapter } from "../lib/providers/xai";
import type { ToolCallResult } from "../lib/providers/types";
import { TURN_BUDGET_CONFIG } from "../lib/turnBudget";
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
        inserted.push(String(values[2])); // operation_kind
        return [{ operation_id: randomUUID() }];
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
