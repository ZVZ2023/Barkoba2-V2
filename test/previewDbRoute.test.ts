import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GET, POST } from "../app/api/internal/preview-db/route";

// ---------------------------------------------------------------------------
// V2.8.7 — TEMPORARY Preview-only, operator-authorized database route.
// Covers the gates the route's OWN code is responsible for; Deployment
// Protection is verified operationally. Nothing here reaches a database:
// every case below is refused before a client is ever created.
// ---------------------------------------------------------------------------

const SAVED = {
  vercelEnv: process.env.VERCEL_ENV,
  dbUrl: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
  secret: process.env.BENCHMARK_INGRESS_SECRET,
};
const SECRET = "test-only-operator-secret";

beforeEach(() => {
  delete process.env.VERCEL_ENV;
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  delete process.env.BENCHMARK_INGRESS_SECRET;
});

afterEach(() => {
  for (const [k, v] of [
    ["VERCEL_ENV", SAVED.vercelEnv],
    ["DATABASE_URL", SAVED.dbUrl],
    ["CORPUS_ENABLED", SAVED.corpus],
    ["BENCHMARK_INGRESS_SECRET", SAVED.secret],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function post(body: Record<string, unknown>): Request {
  return new Request("https://preview.test/api/internal/preview-db", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

for (const envName of [undefined, "production", "development"]) {
  test(`GATE 1: 404 when VERCEL_ENV is ${envName ?? "unset"} — GET and an otherwise-valid POST alike`, async () => {
    if (envName) process.env.VERCEL_ENV = envName;
    process.env.BENCHMARK_INGRESS_SECRET = SECRET;
    assert.equal((await GET()).status, 404);
    assert.equal((await POST(post({ secret: SECRET, action: "apply" }))).status, 404);
  });
}

test("GATE 3: an unconfigured operator secret means no access for anyone — never falls open", async () => {
  process.env.VERCEL_ENV = "preview";
  const res = await POST(post({ secret: "", action: "status" }));
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "operator_secret_not_configured");
});

test("GATE 3: a missing or wrong operator secret is 403; a confirmation word is never a substitute", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = SECRET;
  for (const body of [{ action: "apply" }, { secret: "", action: "apply" }, { secret: "nope", action: "apply" }, { confirm: "apply-0013-once" }]) {
    const res = await POST(post(body));
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal((await res.json()).error, "forbidden");
  }
});

test("an authorized caller with an unknown action is refused before any database access", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = SECRET;
  const res = await POST(post({ secret: SECRET, action: "drop" }));
  assert.equal(res.status, 400);
});

test("an authorized caller with no database configured fails closed", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.BENCHMARK_INGRESS_SECRET = SECRET;
  const res = await POST(post({ secret: SECRET, action: "status" }));
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "database_not_configured");
});

test("GET in Preview serves only the empty operator form — no data, no secret, not cacheable", async () => {
  process.env.VERCEL_ENV = "preview";
  const res = await GET();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  const html = await res.text();
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /neon\.tech|timeline|postgres/i);
});

test("SOURCE: identity is pinned to the observed Preview tenant/timeline/database and the plan is exactly the eight authorized files", () => {
  const src = readFileSync("app/api/internal/preview-db/route.ts", "utf8");
  assert.match(src, /tenant_id: "364938e972147a257364743636f6c500"/);
  assert.match(src, /timeline_id: "6dae9a7a8a8835838a103bd3d731e427"/);
  assert.match(src, /database: "neondb"/);
  assert.match(src, /id\.in_recovery === false/);
  const plan = src.slice(src.indexOf("const PLAN = ["), src.indexOf("] as const;", src.indexOf("const PLAN = [")));
  const files = [...plan.matchAll(/"([^"]+\.sql)"/g)].map((m) => m[1]);
  assert.deepEqual(files, [
    "0006_contest_verdict.sql",
    "0007_unlimited_play.sql",
    "0008_purchase_provenance.sql",
    "0009_player_accounts.sql",
    "0010_registration_email_photo.sql",
    "0011_email_unique.sql",
    "0012_turn_operation_telemetry.sql",
    "0013_ai_usage_telemetry.sql",
  ]);
  // Ledger is matched by full filename; the unrelated 0012_* is named and checked literally.
  assert.match(src, /const UNRELATED_SAME_PREFIX = "0012_racer_guidance_catalog\.sql"/);
  assert.match(src, /before\.includes\(file\)/);
  // One transaction per file with its ledger row; first failure stops the run.
  assert.match(src, /sql\.transaction\(\[/);
  assert.match(src, /INSERT INTO public\.schema_migrations \(filename\) VALUES \(\$1\)/);
  assert.match(src, /rolled back, stopping/);
  // Never enumerates the directory for application, never resets or drops.
  assert.doesNotMatch(src, /readdirSync/);
  assert.doesNotMatch(src, /DROP (TABLE|SCHEMA)|TRUNCATE|DELETE FROM/i);
  assert.match(src, /timingSafeEqual/);
  assert.doesNotMatch(src, /secretStore|revealed_target|private_clarification/);
});

test("the route is quarantined and its migrations directory is traced", () => {
  const iso = readFileSync("scripts/check-isolation.mjs", "utf8");
  assert.ok(iso.slice(iso.indexOf("const QUARANTINED")).includes('"app/api/internal/preview-db/route.ts"'));
  assert.match(readFileSync("next.config.mjs", "utf8"), /"\/api\/internal\/preview-db": \["\.\/migrations\/\*\*"\]/);
});
