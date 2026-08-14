import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import {
  canStartGame,
  consumeForGame,
  getBalance,
  getStatus,
  grantComplimentary,
  isEntitlementEnabled,
} from "../lib/entitlements";

// ---------------------------------------------------------------------------
// V2.4 — Play Credit entitlement.
//
// The ledger is modelled in memory here so the nine required behaviours can be
// proven without a database: an append-only list of {kind, amount}, a partial
// unique index on (operational_game_id) for consumption, and SUM(amount) as the
// only definition of balance. Where a behaviour is guaranteed by SQL rather
// than by application code, the SQL is asserted directly.
// ---------------------------------------------------------------------------

interface Row {
  player_id: string;
  kind: string;
  amount: number;
  operational_game_id: string | null;
  grant_key: string | null;
}

let ledger: Row[] = [];
let failNext = false;

const SAVED = {
  enabled: process.env.ENTITLEMENTS_ENABLED,
  db: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
  cost: process.env.ENTITLEMENT_COST_PER_GAME,
};

/** Minimal in-memory stand-in for accounts.entitlement_ledger. */
function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  if (failNext) return Promise.reject(new Error("neon unavailable"));
  const sql = strings.join(" ");
  const v = values as unknown[];

  const balanceOf = (player: string) =>
    ledger.filter((r) => r.player_id === player).reduce((n, r) => n + r.amount, 0);

  if (/SELECT COALESCE\(SUM\(amount\), 0\) AS balance/.test(sql)) {
    return Promise.resolve([{ balance: balanceOf(String(v[0])) }]);
  }

  if (/FILTER \(WHERE kind = 'complimentary_grant'\)/.test(sql)) {
    const player = String(v[0]);
    const mine = ledger.filter((r) => r.player_id === player);
    const sum = (k: string) => mine.filter((r) => r.kind === k).reduce((n, r) => n + r.amount, 0);
    return Promise.resolve([
      {
        balance: balanceOf(player),
        complimentary_granted: sum("complimentary_grant"),
        purchased: sum("purchase"),
        consumed: -sum("consumption"),
        expired: -sum("expiry"),
      },
    ]);
  }

  // Idempotency probe.
  if (/SELECT entry_id FROM accounts\.entitlement_ledger/.test(sql)) {
    const gameId = String(v[0]);
    const hit = ledger.find((r) => r.kind === "consumption" && r.operational_game_id === gameId);
    return Promise.resolve(hit ? [{ entry_id: 1 }] : []);
  }

  // Conditional, atomic consumption.
  if (/'consumption'/.test(sql) && /INSERT INTO accounts\.entitlement_ledger/.test(sql)) {
    // Parameter order in the real statement:
    //   $1 player, $2 -cost, $3 game, $4 player (balance subquery), $5 cost
    const [player, amount, gameId] = [String(v[0]), Number(v[1]), String(v[2])];
    const cost = Number(v[4]);
    // Partial unique index on (operational_game_id) WHERE kind='consumption'.
    if (ledger.some((r) => r.kind === "consumption" && r.operational_game_id === gameId)) {
      return Promise.resolve([]);
    }
    if (balanceOf(player) < cost) return Promise.resolve([]);
    ledger.push({
      player_id: player,
      kind: "consumption",
      amount,
      operational_game_id: gameId,
      grant_key: null,
    });
    return Promise.resolve([{ entry_id: ledger.length }]);
  }

  // Grants.
  if (/INSERT INTO accounts\.entitlement_ledger/.test(sql)) {
    const kind = /'complimentary_grant'/.test(sql)
      ? "complimentary_grant"
      : /'purchase'/.test(sql)
        ? "purchase"
        : "expiry";
    const player = String(v[0]);
    const amount = Number(v[1]);
    const grantKey = kind === "expiry" ? null : (v[2] as string | null);
    // Partial unique index on (player_id, grant_key) WHERE grant_key IS NOT NULL.
    if (grantKey && ledger.some((r) => r.player_id === player && r.grant_key === grantKey)) {
      return Promise.resolve([]);
    }
    ledger.push({ player_id: player, kind, amount, operational_game_id: null, grant_key: grantKey });
    return Promise.resolve([{ entry_id: ledger.length }]);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (q: Promise<Record<string, unknown>[]>[]) => Promise.all(q);

beforeEach(() => {
  ledger = [];
  failNext = false;
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  process.env.ENTITLEMENTS_ENABLED = "true";
  process.env.ENTITLEMENT_COST_PER_GAME = "1";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  for (const [k, val] of [
    ["ENTITLEMENTS_ENABLED", SAVED.enabled],
    ["DATABASE_URL", SAVED.db],
    ["CORPUS_ENABLED", SAVED.corpus],
    ["ENTITLEMENT_COST_PER_GAME", SAVED.cost],
  ] as const) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
});

const P = "a".repeat(32);

// --- 1. complimentary credits can be granted --------------------------------

test("1. complimentary Play Credits can be granted to an anonymous player", async () => {
  assert.equal(await grantComplimentary(P, 3), true);
  assert.equal(await getBalance(P), 3);
});

test("1b. an at-most-once grant key cannot double-grant", async () => {
  await grantComplimentary(P, 3, { grantKey: "initial_complimentary" });
  await grantComplimentary(P, 3, { grantKey: "initial_complimentary" });
  assert.equal(await getBalance(P), 3);
});

// --- 2. balance is derived, never stored ------------------------------------

test("2. balance is SUM(amount) over the ledger, not a counter", async () => {
  await grantComplimentary(P, 5);
  await consumeForGame(P, randomUUID());
  await consumeForGame(P, randomUUID());
  assert.equal(await getBalance(P), 3);

  // Provenance survives: complimentary and purchased never collapse.
  const s = await getStatus(P);
  assert.equal(s.complimentary_granted, 5);
  assert.equal(s.consumed, 2);
  assert.equal(s.balance, 3);

  // No stored balance column exists to drift from the ledger.
  const migration = readFileSync("migrations/0004_accounts_entitlements.sql", "utf8");
  assert.doesNotMatch(migration, /balance\s+(integer|numeric|bigint)/i);
});

// --- 3 & 4. consumption happens once, and only once -------------------------

test("3. creating a game consumes exactly one charge", async () => {
  await grantComplimentary(P, 2);
  const game = randomUUID();
  assert.deepEqual(await consumeForGame(P, game), { ok: true, reason: "consumed" });
  assert.equal(await getBalance(P), 1);
});

test("4. a retried creation cannot double-consume", async () => {
  await grantComplimentary(P, 5);
  const game = randomUUID();

  const first = await consumeForGame(P, game);
  const second = await consumeForGame(P, game);
  const third = await consumeForGame(P, game);

  assert.equal(first.reason, "consumed");
  assert.equal(second.reason, "already_consumed");
  assert.equal(third.reason, "already_consumed");
  assert.equal(second.ok, true, "a replay is success — the game IS paid for");
  assert.equal(await getBalance(P), 4, "charged once, not three times");
});

test("4b. the idempotency guarantee is a database constraint, not app care", () => {
  const m = readFileSync("migrations/0004_accounts_entitlements.sql", "utf8");
  assert.match(m, /CREATE UNIQUE INDEX[\s\S]*?entitlement_one_consumption_per_game/);
  assert.match(m, /\(operational_game_id\)\s*\n?\s*WHERE kind = 'consumption'/);
});

// --- 5 & 6. exhaustion blocks, replenishment restores -----------------------

test("5. an exhausted balance prevents a new game", async () => {
  await grantComplimentary(P, 1);
  assert.equal((await consumeForGame(P, randomUUID())).ok, true);

  const denied = await consumeForGame(P, randomUUID());
  assert.deepEqual(denied, { ok: false, reason: "insufficient_balance" });
  assert.equal((await canStartGame(P)).ok, false);
  assert.equal(await getBalance(P), 0);
});

test("6. a new grant restores the ability to create a game", async () => {
  await grantComplimentary(P, 1);
  await consumeForGame(P, randomUUID());
  assert.equal((await canStartGame(P)).ok, false);

  await grantComplimentary(P, 2);
  assert.equal((await canStartGame(P)).ok, true);
  assert.equal((await consumeForGame(P, randomUUID())).ok, true);
  assert.equal(await getBalance(P), 1);
});

// --- 7. THE ONE THAT STRUCTURALLY MATTERS -----------------------------------

test("7. an in-flight game survives exhaustion — enforced by there being ONE gate", () => {
  // This is a structural guarantee, not a runtime one: no route other than
  // creation may consult entitlement, so there is no second checkpoint that
  // exhaustion, expiry or an outage could fail.
  const routes = [
    "app/api/game/[id]/ask/route.ts",
    "app/api/game/[id]/turn/route.ts",
    "app/api/game/[id]/hh/turn/route.ts",
    "app/api/game/[id]/clue/route.ts",
    "app/api/game/[id]/correct/route.ts",
    "app/api/game/[id]/resolve/route.ts",
    "app/api/game/[id]/view/route.ts",
    "app/api/game/join/route.ts",
  ];
  for (const r of routes) {
    const src = readFileSync(r, "utf8");
    assert.doesNotMatch(src, /entitlements|consumeForGame|canStartGame|play_credit/i,
      `${r} must never consult entitlement — an in-flight game would become killable`);
  }

  // And creation is the only importer.
  const create = readFileSync("app/api/game/create/route.ts", "utf8");
  assert.match(create, /from "@\/lib\/entitlements"/);
});

test("7b. exhausting a balance mid-game leaves the game's charge intact", async () => {
  await grantComplimentary(P, 1);
  const game = randomUUID();
  await consumeForGame(P, game);

  // The player is now broke, and a later expiry drives them no lower.
  assert.equal(await getBalance(P), 0);
  assert.equal((await canStartGame(P)).ok, false);

  // The game's own consumption row is untouched and still says paid — which is
  // what a replayed creation would find.
  assert.equal((await consumeForGame(P, game)).reason, "already_consumed");
});

test("7c. an entitlement-store outage denies CREATION only", async () => {
  failNext = true;
  const denied = await consumeForGame(P, randomUUID());
  assert.deepEqual(denied, { ok: false, reason: "unavailable" }, "fail closed at creation");
  assert.equal((await canStartGame(P)).ok, false);
  // The failure posture cannot reach gameplay, because gameplay never calls in
  // — proven by the route scan in test 7.
});

// --- 8 & 9. frozen surfaces and V1 isolation --------------------------------

test("8. no frozen V2.2/V2.3 surface is touched by entitlement", () => {
  const ent = readFileSync("lib/entitlements.ts", "utf8");
  for (const forbidden of ["secretStore", "gameView", "./seats", "gameStore"]) {
    assert.ok(!ent.includes(`from "./${forbidden}"`) && !ent.includes(`from "${forbidden}"`),
      `entitlements must not reach ${forbidden}`);
  }
  // Quarantined, so the above is enforced at build time rather than here.
  const iso = readFileSync("scripts/check-isolation.mjs", "utf8");
  const quarantined = iso.slice(iso.indexOf("const QUARANTINED"));
  assert.match(quarantined, /"lib\/entitlements\.ts"/);

  // The allowlist did not grow.
  const permitted = iso.slice(
    iso.indexOf("const PERMITTED_SECRET_IMPORTERS"),
    iso.indexOf("const QUARANTINED")
  );
  assert.doesNotMatch(permitted, /entitlements/);
});

test("9. no new Redis key exists, so nothing can escape the v2: namespace", () => {
  // Entitlement is PostgreSQL-only. It adds no KV key at all, and V1 has no
  // Postgres connection, so accounts.* is unreachable from V1 by construction.
  const ent = readFileSync("lib/entitlements.ts", "utf8");
  assert.doesNotMatch(ent, /getKV|from "\.\/kv"/);
  assert.match(ent, /accounts\.entitlement_ledger/);
});

test("9b. entitlement lives in its own schema, never in immutable corpus.*", () => {
  const m = readFileSync("migrations/0004_accounts_entitlements.sql", "utf8");
  assert.match(m, /CREATE SCHEMA IF NOT EXISTS accounts/);
  // No corpus TABLE is targeted. The header comment explains why entitlement
  // is not in corpus.*, so a bare substring check would flag its own rationale.
  assert.doesNotMatch(m, /(INTO|ON|TABLE|FROM|ALTER TABLE)\s+corpus\./);
  // Append-only, enforced.
  assert.match(m, /BEFORE UPDATE OR DELETE ON accounts\.entitlement_ledger/);
});

// --- the gate is off by default ---------------------------------------------

test("the gate ships OFF and is a no-op until switched on", async () => {
  process.env.ENTITLEMENTS_ENABLED = "false";
  assert.equal(isEntitlementEnabled(), false);
  assert.deepEqual(await consumeForGame(P, randomUUID()), { ok: true, reason: "disabled" });
  assert.deepEqual(await canStartGame(P), { ok: true, reason: "disabled" });
  assert.equal(ledger.length, 0, "nothing is written while disabled");
});

test("Play Credit shares no storage or code path with the SÚGÓ clue credit", () => {
  // They are unrelated mechanisms: the clue credit is derived per game from the
  // transcript and stores nothing; Play Credit is a durable ledger. Neither may
  // import the other, and neither may touch the other's storage.
  const clue = readFileSync("lib/clueCredits.ts", "utf8");
  const ent = readFileSync("lib/entitlements.ts", "utf8");

  const imports = (src: string) =>
    (src.match(/^\s*import[\s\S]*?from\s+["'][^"']+["']/gm) || []).join("\n");

  assert.doesNotMatch(imports(clue), /entitlements/);
  assert.doesNotMatch(imports(ent), /clueCredits/);

  // Storage is disjoint: the clue credit has none at all.
  assert.doesNotMatch(clue, /accounts\.|entitlement_ledger|getKV/);
  assert.doesNotMatch(ent, /QUESTIONS_PER_CLUE_CREDIT|clueCreditsEarned/);
});
