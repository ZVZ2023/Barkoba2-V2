import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GET, POST } from "../app/api/internal/preview-db/route";

// ---------------------------------------------------------------------------
// V2.8.7 — TEMPORARY Preview-only database diagnostic / scoped-migration route.
// Covers the gates the route's OWN code is responsible for; Deployment
// Protection is verified operationally, not here. Nothing here reaches a
// database: every case below is refused before a client is ever created.
// ---------------------------------------------------------------------------

const SAVED = { vercelEnv: process.env.VERCEL_ENV, dbUrl: process.env.DATABASE_URL, corpus: process.env.CORPUS_ENABLED };

beforeEach(() => {
  delete process.env.VERCEL_ENV;
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
});

afterEach(() => {
  for (const [k, v] of [["VERCEL_ENV", SAVED.vercelEnv], ["DATABASE_URL", SAVED.dbUrl], ["CORPUS_ENABLED", SAVED.corpus]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function post(body?: unknown): Request {
  return new Request("https://preview.test/api/internal/preview-db", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "not json" : JSON.stringify(body),
  });
}

for (const envName of [undefined, "production", "development"]) {
  test(`GATE 1: refuses with 404 when VERCEL_ENV is ${envName ?? "unset"} — GET and a correct POST alike`, async () => {
    if (envName) process.env.VERCEL_ENV = envName;
    assert.equal((await GET()).status, 404);
    assert.equal((await POST(post({ confirm: "apply-0013-once" }))).status, 404);
  });
}

test("GATE 3: in Preview, POST refuses anything but the exact confirmation body", async () => {
  process.env.VERCEL_ENV = "preview";
  for (const body of [undefined, {}, { confirm: "please" }, { confirm: ["apply-0013-once"] }, { confirm: "apply-0013-once", extra: 1 }]) {
    const res = await POST(post(body));
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be refused`);
    assert.equal((await res.json()).error, "confirmation_required");
  }
});

test("in Preview with no database configured, both methods fail closed without touching anything", async () => {
  process.env.VERCEL_ENV = "preview";
  const get = await GET();
  assert.equal(get.status, 500);
  assert.equal((await get.json()).error, "database_not_configured");
  const res = await POST(post({ confirm: "apply-0013-once" }));
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "database_not_configured");
});

test("the route applies exactly one named migration, requires its prerequisite, and never enumerates pending files for application", () => {
  const src = readFileSync("app/api/internal/preview-db/route.ts", "utf8");
  assert.match(src, /const TARGET_MIGRATION = "0013_ai_usage_telemetry\.sql"/);
  assert.match(src, /const PREREQUISITE_MIGRATION = "0012_turn_operation_telemetry\.sql"/);
  assert.match(src, /readFileSync\(file, "utf8"\)/);
  // The only file ever read for application is the target; `pending` is reported, never iterated.
  assert.doesNotMatch(src, /for \(const file of pending\)/);
  assert.doesNotMatch(src, /secretStore|revealed_target|private_clarification/);
  // Never echoes the connection string.
  assert.doesNotMatch(src, /databaseUrl\(\)\s*\}|url:\s*url|DATABASE_URL\b.*json/);
});

test("the route is quarantined and traced", () => {
  const iso = readFileSync("scripts/check-isolation.mjs", "utf8");
  assert.ok(iso.slice(iso.indexOf("const QUARANTINED")).includes('"app/api/internal/preview-db/route.ts"'));
  const cfg = readFileSync("next.config.mjs", "utf8");
  assert.match(cfg, /"\/api\/internal\/preview-db": \["\.\/migrations\/\*\*"\]/);
});
