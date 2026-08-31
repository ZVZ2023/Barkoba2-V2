import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { POST as runD2Route } from "../app/api/internal/benchmark/d2-eiffel-tower/route";

// ---------------------------------------------------------------------------
// TEMPORARY route, temporary test file — both belong to the M3 D-2 controlled
// benchmark case and should be deleted together once the run is verified.
// Mirrors test/benchmarkD1Route.test.ts exactly, pointed at the D-2 route and
// its "run-d2-once" confirmation string — see that file's own header comment
// for the full reasoning, not repeated here.
//
// Covers the CURRENT gate model (in-process runner, no self-HTTP):
//   1. Preview-only (VERCEL_ENV === "preview").
//   2. Exact confirmation body {"confirm":"run-d2-once"}, no other key/value.
//   3. BENCHMARK_INGRESS_SECRET is a readiness gate only — never compared
//      against anything the caller supplies, never leaked in a response or
//      log line.
//
// runD2Fixture() runs entirely in-process (createSecret/createGame/saveGame
// use the in-memory KV fallback automatically active whenever
// UPSTASH_REDIS_REST_URL/TOKEN are unset — see lib/kv.ts — and the corpus
// write is a documented no-op without DATABASE_URL, per
// test/corpusPersistence.test.ts's own established pattern). The one real
// network call it makes is to Anthropic (runRacerTurn); with no real
// ANTHROPIC_API_KEY configured in this test environment, that call is
// rejected quickly and safely, which is exactly the realistic failure path
// exercised below — no fixture game is actually completed by these tests,
// and none should be. This test file does not run the D-2 fixture for real.
//
// The external caller no longer presents any secret at all; caller
// authentication is Vercel's own Deployment Protection, which cannot be
// exercised from this in-process test — that boundary is verified
// operationally, not by this file. What this file verifies is everything the
// route's OWN code is responsible for.
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-only-benchmark-secret-do-not-use-in-prod";

const SAVED_ENV = {
  vercelEnv: process.env.VERCEL_ENV,
  benchmarkSecret: process.env.BENCHMARK_INGRESS_SECRET,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
};

function restoreEnv() {
  for (const [key, envKey] of [
    ["vercelEnv", "VERCEL_ENV"],
    ["benchmarkSecret", "BENCHMARK_INGRESS_SECRET"],
    ["anthropicKey", "ANTHROPIC_API_KEY"],
  ] as const) {
    const value = SAVED_ENV[key];
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
}

beforeEach(() => {
  delete process.env.VERCEL_ENV;
  delete process.env.BENCHMARK_INGRESS_SECRET;
  // A syntactically-plausible but definitely-invalid key — real enough that
  // callAnthropicTool attempts a real request and gets a real, fast 401,
  // rather than failing some other way (e.g. a client-side format check).
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-not-a-real-credential-000000000000000000";
});

afterEach(() => {
  restoreEnv();
});

function request(body?: unknown): Request {
  return new Request("https://preview.test/api/internal/benchmark/d2-eiffel-tower", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Captures console.log/console.error output for one call, without silencing real failures. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, logged };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------------
// Gate 1 — Preview only.
// ---------------------------------------------------------------------------

test("GATE 1: refuses with 404 when VERCEL_ENV is unset (e.g. local dev), even with a correct confirmation", async () => {
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  const res = await runD2Route(request({ confirm: "run-d2-once" }) as any);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not_found");
});

test("GATE 1: refuses with 404 when VERCEL_ENV is 'production', even with a correct confirmation", async () => {
  process.env.VERCEL_ENV = "production";
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  const res = await runD2Route(request({ confirm: "run-d2-once" }) as any);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not_found");
});

test("GATE 1: refuses with 404 when VERCEL_ENV is 'development'", async () => {
  process.env.VERCEL_ENV = "development";
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  const res = await runD2Route(request({ confirm: "run-d2-once" }) as any);
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Gate 2 — exact confirmation body, independent of gate 1.
// ---------------------------------------------------------------------------

test("GATE 2: refuses with 400 in Preview when the body is empty", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  const res = await runD2Route(request() as any);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "confirmation_required");
});

test("GATE 2: refuses with 400 in Preview when the body is not valid JSON", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  const badReq = new Request("https://preview.test/api/internal/benchmark/d2-eiffel-tower", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not json",
  });
  const res = await runD2Route(badReq as any);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "confirmation_required");
});

test("GATE 2: refuses with 400 in Preview when confirm has the wrong value", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  const res = await runD2Route(request({ confirm: "please" }) as any);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "confirmation_required");
});

test("GATE 2: refuses with 400 in Preview when the D-1 confirmation string is used instead of D-2's", async () => {
  // The two routes must never be triggerable by each other's confirmation
  // body — this is the entire reason the two strings differ.
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  const res = await runD2Route(request({ confirm: "run-d1-once" }) as any);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "confirmation_required");
});

test("GATE 2: refuses with 400 in Preview when an extra key is present alongside a correct confirm", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  const res = await runD2Route(
    request({ confirm: "run-d2-once", target: "something else" }) as any
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "confirmation_required");
});

test("GATE 2: refuses with 400 in Preview when confirm is present but not a string (type confusion)", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  const res = await runD2Route(request({ confirm: ["run-d2-once"] }) as any);
  assert.equal(res.status, 400);
});

test("GATE 2 cleared: an exact confirmation body in Preview with a configured secret actually attempts the in-process run", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  // No real Anthropic key in this environment (see beforeEach), so the run
  // fails fast at the first real model call — proving this path reaches
  // runD2Fixture() at all (past both gates and the readiness check), without
  // this test suite completing a real game.
  const res = await runD2Route(request({ confirm: "run-d2-once" }) as any);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "benchmark_run_failed");
});

test("cleared confirmation still fails closed when BENCHMARK_INGRESS_SECRET is not configured at all", async () => {
  process.env.VERCEL_ENV = "preview";
  // BENCHMARK_INGRESS_SECRET deliberately left unset.
  const res = await runD2Route(request({ confirm: "run-d2-once" }) as any);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "benchmark_secret_not_configured");
});

// ---------------------------------------------------------------------------
// No-secret-leakage — exercised on a real failure path through runD2Fixture,
// so its actual console.log lines (not just the route's own) are checked too.
// ---------------------------------------------------------------------------

test("LEAKAGE: neither the response body nor anything logged ever contains the real secret value", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = TEST_SECRET;
  // The fake ANTHROPIC_API_KEY from beforeEach forces runD2Fixture to log its
  // normal startup lines and then throw on the first real Anthropic call —
  // exercising a genuine failure path without completing a real game.

  const { result: res, logged } = await captureConsole(() =>
    runD2Route(request({ confirm: "run-d2-once" }) as any)
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, "benchmark_run_failed");

  const bodyText = JSON.stringify(body);
  assert.ok(!bodyText.includes(TEST_SECRET), "response body must never contain the secret value");
  for (const line of logged) {
    assert.ok(!line.includes(TEST_SECRET), `logged line must never contain the secret value: ${line}`);
  }
});

test("LEAKAGE: BENCHMARK_INGRESS_SECRET is never echoed back on the not-configured error path", async () => {
  process.env.VERCEL_ENV = "preview";
  const res = await runD2Route(request({ confirm: "run-d2-once" }) as any);
  const bodyText = JSON.stringify(await res.json());
  assert.ok(!bodyText.includes(TEST_SECRET), "the real secret must never be echoed back");
});
