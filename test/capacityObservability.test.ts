import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { consumeModelCall, peekModelCallUsage } from "../lib/callBudget";
import { questionBudgetDistributionToday } from "../lib/corpus/gameCorpus";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { GET as getCapacity } from "../app/api/admin/capacity/route";
import { createAccountSession } from "../lib/accountSession";

// ---------------------------------------------------------------------------
// V2.7 — capacity observability against the existing RACER_DAILY_CALL_CEILING
// and the 1,400/70% policy-review trigger named in the spec. Nothing here
// enforces anything; lib/callBudget.ts's consumeModelCall already does that,
// unchanged. This only reads the same counters back out.
// ---------------------------------------------------------------------------

type Entry = { value: unknown; expiresAt: number | null };
const devStore = globalThis as unknown as { __barkobaDevKV?: Map<string, Entry> };

function resetKv() {
  (devStore.__barkobaDevKV ??= new Map<string, Entry>()).clear();
}

const SAVED_ENV = {
  ceiling: process.env.RACER_DAILY_CALL_CEILING,
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL,
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
};

beforeEach(() => {
  resetKv();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    const envKey =
      key === "ceiling"
        ? "RACER_DAILY_CALL_CEILING"
        : key === "upstashUrl"
          ? "UPSTASH_REDIS_REST_URL"
          : "UPSTASH_REDIS_REST_TOKEN";
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

// ---------------------------------------------------------------------------
// peekModelCallUsage — must read, never write.
// ---------------------------------------------------------------------------

test("peekModelCallUsage reports zero usage before any call is made, without creating a key", async () => {
  const snapshot = await peekModelCallUsage("racer");
  assert.equal(snapshot.used, 0);
  assert.equal(snapshot.ceiling, 2000, "the documented default ceiling");
  assert.equal(snapshot.utilization, 0);
});

test("peekModelCallUsage reflects consumeModelCall's real counter, exactly", async () => {
  await consumeModelCall("racer");
  await consumeModelCall("racer");
  await consumeModelCall("racer");

  const snapshot = await peekModelCallUsage("racer");
  assert.equal(snapshot.used, 3);
});

test("THE CORE GUARANTEE: peeking does not itself consume budget", async () => {
  await consumeModelCall("racer");
  const first = await peekModelCallUsage("racer");
  const second = await peekModelCallUsage("racer");
  const third = await peekModelCallUsage("racer");
  assert.equal(first.used, 1);
  assert.equal(second.used, 1);
  assert.equal(third.used, 1, "repeated observation must never move the counter");
});

test("racer and resolve are independent counters, matching consumeModelCall's own separation", async () => {
  await consumeModelCall("racer");
  await consumeModelCall("racer");
  await consumeModelCall("resolve");

  assert.equal((await peekModelCallUsage("racer")).used, 2);
  assert.equal((await peekModelCallUsage("resolve")).used, 1);
});

test("utilization is used/ceiling, and the 70% review-trigger threshold is crossable", async () => {
  process.env.RACER_DAILY_CALL_CEILING = "10";
  for (let i = 0; i < 7; i += 1) await consumeModelCall("racer");
  const snapshot = await peekModelCallUsage("racer");
  assert.equal(snapshot.used, 7);
  assert.equal(snapshot.ceiling, 10);
  assert.equal(snapshot.utilization, 0.7);
});

// ---------------------------------------------------------------------------
// questionBudgetDistributionToday
// ---------------------------------------------------------------------------

interface Row {
  max_questions: number;
  count: number;
}

let groupedRows: Row[];
// Shared with the BEHAVIORAL section below — ONE fake and ONE beforeEach for
// the whole file's corpus-backed tests, so a second registration can never
// silently override the first for tests that only intended to set one of
// these up. (An earlier version of this file had two separate beforeEach
// pairs; node:test runs every beforeEach for every test in the file, so the
// second silently clobbered the first's fake for unrelated tests.)
let registeredPlayers: Set<string>;
let sessionHashes: Map<string, string>;

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const query = strings.join(" ");
  const v = values as unknown[];

  if (/FROM corpus\.games/.test(query) && /GROUP BY max_questions/.test(query)) {
    return Promise.resolve(groupedRows as unknown as Record<string, unknown>[]);
  }
  if (/INSERT INTO accounts\.player_sessions/.test(query)) {
    // INSERT ... SELECT hash, player_id, expires_at FROM accounts.players
    // WHERE player_id = $3 — the interpolation order is (hash, expiresAt,
    // playerId), matching lib/accountSession.ts's createAccountSession.
    const hash = String(v[0]);
    const playerId = String(v[2]);
    if (!registeredPlayers.has(playerId)) return Promise.resolve([]);
    sessionHashes.set(hash, playerId);
    return Promise.resolve([{ player_id: playerId }]);
  }
  if (/FROM accounts\.player_sessions/.test(query)) {
    const hash = String(v[0]);
    const playerId = sessionHashes.get(hash);
    return Promise.resolve(playerId ? [{ player_id: playerId }] : []);
  }
  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

const SAVED_ADMIN_IDS = process.env.ADMIN_PLAYER_IDS;

beforeEach(() => {
  groupedRows = [];
  registeredPlayers = new Set();
  sessionHashes = new Map();
  delete process.env.ADMIN_PLAYER_IDS;
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  if (SAVED_ADMIN_IDS === undefined) delete process.env.ADMIN_PLAYER_IDS;
  else process.env.ADMIN_PLAYER_IDS = SAVED_ADMIN_IDS;
  __setSqlClientForTests(null);
});

test("questionBudgetDistributionToday scopes to today's UTC calendar day, matching the daily call ceiling's own window", () => {
  const src = readFileSync("lib/corpus/gameCorpus.ts", "utf8");
  const fn = src.slice(
    src.indexOf("export async function questionBudgetDistributionToday"),
    src.indexOf("// ---", src.indexOf("export async function questionBudgetDistributionToday"))
  );
  assert.match(fn, /date_trunc\('day', timezone\('UTC', now\(\)\)\)/);
});

test("returns the grouped counts as-is, coerced to numbers", async () => {
  groupedRows = [
    { max_questions: 20, count: 5 },
    { max_questions: 50, count: 2 },
  ];
  const result = await questionBudgetDistributionToday();
  assert.deepEqual(result, [
    { max_questions: 20, count: 5 },
    { max_questions: 50, count: 2 },
  ]);
});

test("a corpus read failure returns null, not an empty distribution", async () => {
  __setSqlClientForTests((() => Promise.reject(new Error("neon unavailable"))) as unknown as typeof fakeSql);
  const result = await questionBudgetDistributionToday();
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// V2.7 — capacity telemetry was briefly public on /api/version and moved,
// on review, to an admin-gated route: this is aggregate business/capacity
// data (roughly how many games play per day, how close to the spend
// ceiling), not deployment configuration, and any registered account could
// otherwise have read it. /api/version keeps everything it had before.
// ---------------------------------------------------------------------------

const VERSION_ROUTE = readFileSync("app/api/version/route.ts", "utf8");
const ADMIN_CAPACITY_ROUTE = readFileSync("app/api/admin/capacity/route.ts", "utf8");

test("/api/version does not expose capacity telemetry — it moved behind the admin gate", () => {
  // A comment explaining WHY it moved is fine and expected; the leak vectors
  // this actually guards are the function calls and the response field.
  assert.doesNotMatch(VERSION_ROUTE, /peekModelCallUsage/);
  assert.doesNotMatch(VERSION_ROUTE, /questionBudgetDistributionToday/);
  assert.doesNotMatch(VERSION_ROUTE, /capacity:\s*\{/);
});

test("/api/admin/capacity requires an account AND admin-allowlist membership, not merely login", () => {
  assert.match(ADMIN_CAPACITY_ROUTE, /resolveActingPlayer\(req\.headers\)/);
  assert.match(ADMIN_CAPACITY_ROUTE, /context\.kind === "account" && isAdminPlayer\(context\.playerId\)/);
  assert.match(ADMIN_CAPACITY_ROUTE, /status: 403/);
  // The check must happen before any capacity data is computed.
  const gateAt = ADMIN_CAPACITY_ROUTE.indexOf("if (!authorized)");
  const readAt = ADMIN_CAPACITY_ROUTE.indexOf("peekModelCallUsage(");
  assert.ok(gateAt > 0 && readAt > gateAt);
});

test("the admin check is a distinct allowlist, deliberately NOT accounts.unlimited_play", () => {
  // A comment explaining what was deliberately NOT reused, and why, is
  // expected and good documentation — the actual leak vector this guards is
  // the route calling hasUnlimitedPlay() as its gate, which it must not.
  assert.doesNotMatch(ADMIN_CAPACITY_ROUTE, /hasUnlimitedPlay\(/);
  assert.match(ADMIN_CAPACITY_ROUTE, /import \{ isAdminPlayer \} from "@\/lib\/admin"/);

  const adminLib = readFileSync("lib/admin.ts", "utf8");
  assert.match(adminLib, /adminPlayerIds\(\)\.has\(playerId\)/);
  assert.doesNotMatch(adminLib, /FROM accounts\.unlimited_play|hasUnlimitedPlay\(/);

  const envLib = readFileSync("lib/env.ts", "utf8");
  assert.match(envLib, /adminPlayerIds: \(\): ReadonlySet<string> =>/);
  assert.match(envLib, /process\.env\.ADMIN_PLAYER_IDS/);
});

test("/api/admin/capacity reports capacity as a read, never a reservation", () => {
  assert.match(ADMIN_CAPACITY_ROUTE, /peekModelCallUsage\("racer"\)/);
  assert.match(ADMIN_CAPACITY_ROUTE, /peekModelCallUsage\("resolve"\)/);
  assert.match(ADMIN_CAPACITY_ROUTE, /questionBudgetDistributionToday\(\)/);
  assert.doesNotMatch(
    ADMIN_CAPACITY_ROUTE,
    /consumeModelCall/,
    "the observability endpoint must never spend budget"
  );
});

test("/api/admin/capacity's review_trigger is informational, and no cap is introduced alongside it", () => {
  assert.match(ADMIN_CAPACITY_ROUTE, /review_trigger: racerCalls\.utilization >= 0\.7/);
  assert.doesNotMatch(
    ADMIN_CAPACITY_ROUTE,
    /max_questions\s*=|forceBudget|disallow.*(20|35)/i,
    "observability must not itself implement the 20\\/35Q cap the spec says not to add yet"
  );
});

test("/api/admin/capacity never returns player_id, target, or transcript content", () => {
  assert.doesNotMatch(ADMIN_CAPACITY_ROUTE, /player_id:|target|transcript|question_text|guess_text/);
});

test("/api/admin/capacity marks its response private, no-store — this is not meant to be cached or shared", () => {
  const bodyReturns = ADMIN_CAPACITY_ROUTE.match(/PRIVATE_NO_STORE/g) ?? [];
  assert.ok(bodyReturns.length >= 2, "both the 403 and the success response must set it");
});

// ---------------------------------------------------------------------------
// Behavioral: driving the real route handler, not just reading its source.
// Reuses the same fake and beforeEach/afterEach declared above — it already
// covers accounts.player_sessions and accounts.unlimited_play, modeled the
// same way test/unlimitedPlay.test.ts and test/emailVerification.test.ts
// already model these same tables, not a new convention.
// ---------------------------------------------------------------------------

async function sessionCookieFor(playerId: string): Promise<string> {
  registeredPlayers.add(playerId);
  const token = await createAccountSession(playerId);
  return `bk_account_session=${token}`;
}

test("BEHAVIORAL: no session at all is refused", async () => {
  const res = await getCapacity(new Request("https://barkoba.test/api/admin/capacity") as Request);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "forbidden");
});

test("BEHAVIORAL: a real, ordinary account session is refused — login alone is not enough", async () => {
  const cookie = await sessionCookieFor("o".repeat(32));
  const res = await getCapacity(
    new Request("https://barkoba.test/api/admin/capacity", {
      headers: { cookie },
    }) as Request
  );
  assert.equal(res.status, 403);
});

test("BEHAVIORAL: a logged-in account NOT on the allowlist is refused, even with ADMIN_PLAYER_IDS set to others", async () => {
  const playerId = "b".repeat(32);
  const cookie = await sessionCookieFor(playerId);
  process.env.ADMIN_PLAYER_IDS = `${"z".repeat(32)},${"y".repeat(32)}`;
  const res = await getCapacity(
    new Request("https://barkoba.test/api/admin/capacity", {
      headers: { cookie },
    }) as Request
  );
  assert.equal(res.status, 403);
});

test("BEHAVIORAL: an account on the admin allowlist is admitted and sees the data", async () => {
  const playerId = "a".repeat(32);
  const cookie = await sessionCookieFor(playerId);
  // Allowlist is a comma-separated set; this id sits among others, matching
  // how the env var would actually be configured for more than one operator.
  process.env.ADMIN_PLAYER_IDS = `${"z".repeat(32)},${playerId},${"y".repeat(32)}`;
  groupedRows = [{ max_questions: 20, count: 3 }];

  const res = await getCapacity(
    new Request("https://barkoba.test/api/admin/capacity", {
      headers: { cookie },
    }) as Request
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.racer_calls_today.used, 0);
  assert.equal(body.racer_calls_today.ceiling, 2000);
  assert.deepEqual(body.question_budget_distribution_today, [{ max_questions: 20, count: 3 }]);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, new RegExp(playerId), "the caller's own id must not be echoed back");
});

test("BEHAVIORAL: an unset ADMIN_PLAYER_IDS admits nobody, including a real account", async () => {
  const playerId = "c".repeat(32);
  const cookie = await sessionCookieFor(playerId);
  delete process.env.ADMIN_PLAYER_IDS;
  const res = await getCapacity(
    new Request("https://barkoba.test/api/admin/capacity", {
      headers: { cookie },
    }) as Request
  );
  assert.equal(res.status, 403, "an unconfigured allowlist must fail closed, not fail open");
});
