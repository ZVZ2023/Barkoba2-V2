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
  entitlementStatus,
} from "../lib/entitlements";
import { playCreditCostForBudget } from "../lib/questionBudget";

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
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  for (const [k, val] of [
    ["ENTITLEMENTS_ENABLED", SAVED.enabled],
    ["DATABASE_URL", SAVED.db],
    ["CORPUS_ENABLED", SAVED.corpus],
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
  await consumeForGame(P, randomUUID(), 20);
  await consumeForGame(P, randomUUID(), 20);
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
  assert.deepEqual(await consumeForGame(P, game, 20), { ok: true, reason: "consumed" });
  assert.equal(await getBalance(P), 1);
});

test("4. a retried creation cannot double-consume", async () => {
  await grantComplimentary(P, 5);
  const game = randomUUID();

  const first = await consumeForGame(P, game, 20);
  const second = await consumeForGame(P, game, 20);
  const third = await consumeForGame(P, game, 20);

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
  assert.equal((await consumeForGame(P, randomUUID(), 20)).ok, true);

  const denied = await consumeForGame(P, randomUUID(), 20);
  assert.deepEqual(denied, { ok: false, reason: "insufficient_balance" });
  assert.equal((await canStartGame(P)).ok, false);
  assert.equal(await getBalance(P), 0);
});

test("6. a new grant restores the ability to create a game", async () => {
  await grantComplimentary(P, 1);
  await consumeForGame(P, randomUUID(), 20);
  assert.equal((await canStartGame(P)).ok, false);

  await grantComplimentary(P, 2);
  assert.equal((await canStartGame(P)).ok, true);
  assert.equal((await consumeForGame(P, randomUUID(), 20)).ok, true);
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
  await consumeForGame(P, game, 20);

  // The player is now broke, and a later expiry drives them no lower.
  assert.equal(await getBalance(P), 0);
  assert.equal((await canStartGame(P)).ok, false);

  // The game's own consumption row is untouched and still says paid — which is
  // what a replayed creation would find.
  assert.equal((await consumeForGame(P, game, 20)).reason, "already_consumed");
});

test("7c. an entitlement-store outage denies CREATION only", async () => {
  failNext = true;
  const denied = await consumeForGame(P, randomUUID(), 20);
  assert.deepEqual(denied, { ok: false, reason: "unavailable" }, "fail closed at creation");
  assert.equal((await canStartGame(P)).ok, false);
  // The failure posture cannot reach gameplay, because gameplay never calls in
  // — proven by the route scan in test 7.
});

// --- V2.4.1: variable cost by question budget -------------------------------

test("V2.4.1-1. each budget tier charges its own Play Credit cost", async () => {
  const tiers: Array<[number, number]> = [
    [20, 1],
    [35, 2],
    [50, 3],
    [100, 5],
  ];

  for (const [budget, expected] of tiers) {
    assert.equal(playCreditCostForBudget(budget), expected, `budget ${budget}`);
  }

  // And the charge actually moves the balance by that amount.
  for (const [budget, expected] of tiers) {
    const player = `p_${budget}`;
    await grantComplimentary(player, 10);
    await consumeForGame(player, randomUUID(), budget);
    assert.equal(await getBalance(player), 10 - expected, `budget ${budget} charged wrong`);
  }
});

test("V2.4.1-1b. the curve is monotonic, and a non-tier budget is never cheaper", () => {
  // The curve is arbitrary, not a calibrated cost proxy — but it must never
  // reward a larger budget with a smaller charge.
  assert.ok(
    playCreditCostForBudget(20) < playCreditCostForBudget(35) &&
      playCreditCostForBudget(35) < playCreditCostForBudget(50) &&
      playCreditCostForBudget(50) < playCreditCostForBudget(100)
  );

  // MAX_QUESTIONS is a deployment knob and need not be one of the four tiers.
  assert.equal(playCreditCostForBudget(25), 2, "25 charges at the 35 tier");
  assert.equal(playCreditCostForBudget(1), 1);
  assert.equal(playCreditCostForBudget(500), 5, "beyond the top tier, top price");
});

test("V2.4.1-2. the charge cannot be priced by the client", async () => {
  // consumeForGame takes a BUDGET, never a cost, and the table lives in
  // lib/questionBudget.ts — no caller holds it.
  const ent = readFileSync("lib/entitlements.ts", "utf8");
  const charge = ent.slice(ent.indexOf("export async function consumeForGame"));
  assert.match(charge, /playCreditCostForBudget\(questionBudget\)/);
  assert.doesNotMatch(charge, /body\.|req\.|request\./, "the charge must not read a request");

  // The route hands over the PERSISTED budget, not anything from the body.
  const route = readFileSync("app/api/game/create/route.ts", "utf8");
  assert.match(route, /consumeForGame\(playerId, aiGame\.game_id, aiGame\.max_questions\)/);
  assert.match(route, /consumeForGame\(playerId, game\.game_id, game\.max_questions\)/);
  assert.doesNotMatch(route, /consumeForGame\([^)]*body\./, "never from the request body");

  // No environment setting can price a game either.
  assert.doesNotMatch(readFileSync("lib/env.ts", "utf8"), /entitlementCostPerGame/);

  // Behaviourally: an inflated budget argument would change the price, so the
  // only thing that matters is that the route sources it from the record —
  // asserted above. Here we prove the mapping itself is fixed.
  await grantComplimentary(P, 10);
  await consumeForGame(P, randomUUID(), 100);
  assert.equal(await getBalance(P), 5, "budget-100 costs exactly 5, never a client's number");
});

test("V2.4.1-3. insufficient balance for the RESOLVED tier is refused", async () => {
  await grantComplimentary(P, 3);

  // 3 credits, budget-100 game costs 5 -> refused.
  const denied = await consumeForGame(P, randomUUID(), 100);
  assert.deepEqual(denied, { ok: false, reason: "insufficient_balance" });
  assert.equal(await getBalance(P), 3, "a refused charge takes nothing");

  // Same 3 credits, budget-35 game costs 2 -> succeeds.
  const allowed = await consumeForGame(P, randomUUID(), 35);
  assert.deepEqual(allowed, { ok: true, reason: "consumed" });
  assert.equal(await getBalance(P), 1);
});

test("V2.4.1-3b. the dimension-blind pre-check passes, the charge still refuses", async () => {
  // The pre-check runs before the body is parsed, so it cannot know the tier.
  // A player with SOME balance passes it and is correctly refused later.
  await grantComplimentary(P, 1);
  assert.equal((await canStartGame(P)).ok, true, "pre-check sees a positive balance");
  assert.equal((await consumeForGame(P, randomUUID(), 100)).ok, false, "charge knows the tier");
  assert.equal(await getBalance(P), 1);
});

test("V2.4.1-5/6. a new player gets exactly 10, once, spendable on any tier", async () => {
  const fresh = "new_player_1";
  const amount = 10;

  // Reuses the existing at-most-once grant_key mechanism, not a new one.
  await grantComplimentary(fresh, amount, { grantKey: "initial_complimentary" });
  await grantComplimentary(fresh, amount, { grantKey: "initial_complimentary" });
  await grantComplimentary(fresh, amount, { grantKey: "initial_complimentary" });
  assert.equal(await getBalance(fresh), 10, "granted once, not three times");

  // No complimentary-specific tier restriction: budget-100 is spendable.
  assert.deepEqual(await consumeForGame(fresh, randomUUID(), 100), {
    ok: true,
    reason: "consumed",
  });
  assert.equal(await getBalance(fresh), 5);

  // And the default really is 10.
  const envSrc = readFileSync("lib/env.ts", "utf8");
  assert.match(envSrc, /optionalInt\("ENTITLEMENT_COMPLIMENTARY_GRANT", 10\)/);
});

// --- CONCURRENT DOUBLE-SPEND: different games, same last credit -------------
//
// The unique index proves retry idempotency for the SAME game. This is the
// separate case: two genuinely concurrent creations, different
// operational_game_ids, one credit between them.
//
// The fake below models PostgreSQL READ COMMITTED honestly — a statement's
// balance subquery sees only rows committed before that statement began — and
// models pg_advisory_xact_lock as a per-player mutex held for the transaction.
// That is what lets the two cases be told apart here.

interface PgSim {
  rows: Row[];
  locks: Set<string>;
}

/** Runs one charge attempt against a simulated READ COMMITTED Postgres. */
async function simulateCharge(
  pg: PgSim,
  playerId: string,
  gameId: string,
  cost: number,
  opts: { useAdvisoryLock: boolean }
): Promise<boolean> {
  // Transaction begins. With the lock, a second caller waits here.
  if (opts.useAdvisoryLock) {
    while (pg.locks.has(playerId)) await new Promise((r) => setTimeout(r, 1));
    pg.locks.add(playerId);
  }

  try {
    // Statement snapshot: sum of rows committed so far.
    const balance = pg.rows
      .filter((r) => r.player_id === playerId)
      .reduce((n, r) => n + r.amount, 0);

    // Yield, so an unguarded concurrent caller can interleave right here —
    // exactly the window between reading the balance and committing the write.
    await new Promise((r) => setTimeout(r, 5));

    if (pg.rows.some((r) => r.kind === "consumption" && r.operational_game_id === gameId)) {
      return false; // unique index on operational_game_id
    }
    if (balance < cost) return false;

    pg.rows.push({
      player_id: playerId,
      kind: "consumption",
      amount: -cost,
      operational_game_id: gameId,
      grant_key: null,
    });
    return true;
  } finally {
    if (opts.useAdvisoryLock) pg.locks.delete(playerId);
  }
}

test("CONCURRENCY: without serialisation the last credit is double-spent", async () => {
  // Documents the flaw class the advisory lock exists to close. If this ever
  // stops reproducing, the fake has stopped modelling READ COMMITTED and the
  // guard test below is no longer meaningful.
  const pg: PgSim = { rows: [], locks: new Set() };
  pg.rows.push({ player_id: P, kind: "complimentary_grant", amount: 1, operational_game_id: null, grant_key: null });

  const [a, b] = await Promise.all([
    simulateCharge(pg, P, randomUUID(), 1, { useAdvisoryLock: false }),
    simulateCharge(pg, P, randomUUID(), 1, { useAdvisoryLock: false }),
  ]);

  const balance = pg.rows.reduce((n, r) => n + r.amount, 0);
  assert.equal(a && b, true, "both succeed — the unguarded write skew");
  assert.equal(balance, -1, "balance goes negative: this is the defect");
});

test("CONCURRENCY: the guard holds with VARIABLE cost, not only cost=1", async () => {
  // V2.4.1 — the prior pass proved this for a single credit. Re-proved for a
  // budget-100 game costing 5: 7 credits fund exactly one such game, and two
  // concurrent attempts must not both take 5.
  const pg: PgSim = { rows: [], locks: new Set() };
  pg.rows.push({ player_id: P, kind: "complimentary_grant", amount: 7, operational_game_id: null, grant_key: null });

  const cost = playCreditCostForBudget(100);
  assert.equal(cost, 5);

  const [a, b] = await Promise.all([
    simulateCharge(pg, P, randomUUID(), cost, { useAdvisoryLock: true }),
    simulateCharge(pg, P, randomUUID(), cost, { useAdvisoryLock: true }),
  ]);

  const balance = pg.rows.reduce((n, r) => n + r.amount, 0);
  assert.equal([a, b].filter(Boolean).length, 1, "exactly one budget-100 game is funded");
  assert.equal(balance, 2, "7 - 5, not 7 - 10");
  assert.ok(balance >= 0, "balance must never go negative");
});

test("CONCURRENCY: mixed tiers cannot overspend a shared balance", async () => {
  // 5 credits, three concurrent attempts at different tiers. Whatever wins, the
  // balance must never go below zero.
  const pg: PgSim = { rows: [], locks: new Set() };
  pg.rows.push({ player_id: P, kind: "complimentary_grant", amount: 5, operational_game_id: null, grant_key: null });

  await Promise.all(
    [100, 50, 35].map((budget) =>
      simulateCharge(pg, P, randomUUID(), playCreditCostForBudget(budget), {
        useAdvisoryLock: true,
      })
    )
  );

  const balance = pg.rows.reduce((n, r) => n + r.amount, 0);
  assert.ok(balance >= 0, `balance went negative: ${balance}`);
  assert.ok(balance <= 5);
});

test("CONCURRENCY: with the advisory lock, exactly one succeeds and balance never goes negative", async () => {
  const pg: PgSim = { rows: [], locks: new Set() };
  pg.rows.push({ player_id: P, kind: "complimentary_grant", amount: 1, operational_game_id: null, grant_key: null });

  const [a, b] = await Promise.all([
    simulateCharge(pg, P, randomUUID(), 1, { useAdvisoryLock: true }),
    simulateCharge(pg, P, randomUUID(), 1, { useAdvisoryLock: true }),
  ]);

  const balance = pg.rows.reduce((n, r) => n + r.amount, 0);
  assert.equal([a, b].filter(Boolean).length, 1, "exactly one consumption succeeds");
  assert.equal(balance, 0, "balance lands at zero");
  assert.ok(balance >= 0, "balance must never be negative");
  assert.equal(pg.rows.filter((r) => r.kind === "consumption").length, 1);
});

test("CONCURRENCY: ten concurrent attempts on three credits consume exactly three", async () => {
  const pg: PgSim = { rows: [], locks: new Set() };
  pg.rows.push({ player_id: P, kind: "complimentary_grant", amount: 3, operational_game_id: null, grant_key: null });

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      simulateCharge(pg, P, randomUUID(), 1, { useAdvisoryLock: true })
    )
  );

  assert.equal(results.filter(Boolean).length, 3);
  assert.equal(pg.rows.reduce((n, r) => n + r.amount, 0), 0);
});

test("the shipped charge serialises per player INSIDE the same transaction", () => {
  // The behavioural tests above prove the mechanism is correct. This proves the
  // shipped code actually uses it — the two together are the invariant.
  const src = readFileSync("lib/entitlements.ts", "utf8");
  const charge = src.slice(src.indexOf("export async function consumeForGame"));

  assert.match(charge, /sql\.transaction\(\[/, "check and write must share one transaction");
  assert.match(charge, /pg_advisory_xact_lock\(4242, hashtext\(/, "serialised per player");

  // Lock first, insert second — the order is the whole point.
  const lockAt = charge.indexOf("pg_advisory_xact_lock");
  const insertAt = charge.indexOf("INSERT INTO accounts.entitlement_ledger");
  assert.ok(lockAt > 0 && insertAt > lockAt, "the lock must precede the conditional insert");

  // And the conditional insert still carries its balance guard.
  assert.match(charge, /WHERE \(\s*\n?\s*SELECT COALESCE\(SUM\(amount\), 0\)/);
  assert.match(charge, /ON CONFLICT \(operational_game_id\) WHERE kind = 'consumption' DO NOTHING/);
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

// --- observability: the gate's state must be readable from outside ----------

test("the status names WHICH half of the conjunction failed", () => {
  process.env.CORPUS_ENABLED = "true";

  delete process.env.ENTITLEMENTS_ENABLED;
  let s = entitlementStatus();
  assert.equal(s.enforced, false);
  assert.equal(s.flagEnabled, false);
  assert.equal(s.storeReady, true);
  assert.equal(s.reason, "flag_unset", "never configured");

  process.env.ENTITLEMENTS_ENABLED = "ture";
  s = entitlementStatus();
  assert.equal(s.reason, "flag_not_enabled", "set but unreadable — a different fix");

  process.env.ENTITLEMENTS_ENABLED = "true";
  assert.equal(entitlementStatus().reason, "enforcing");
  assert.equal(entitlementStatus().enforced, true);

  // Store outranks the flag: there is nothing to enforce against without one.
  process.env.CORPUS_ENABLED = "false";
  s = entitlementStatus();
  assert.equal(s.reason, "store_unavailable");
  assert.equal(s.flagEnabled, true, "the flag is still reported truthfully");
  assert.equal(s.enforced, false);
});

test("the status reports the grant, so an empty gate is visible from outside", () => {
  process.env.ENTITLEMENTS_ENABLED = "true";
  process.env.ENTITLEMENT_COMPLIMENTARY_GRANT = "0";
  const s = entitlementStatus();
  assert.equal(s.enforced, true);
  assert.equal(s.complimentaryGrant, 0, "gate on, nothing behind it — blocks everyone");
  delete process.env.ENTITLEMENT_COMPLIMENTARY_GRANT;
  assert.equal(entitlementStatus().complimentaryGrant, 10);
});

test("the status carries no secret, no player and no ledger data", () => {
  process.env.DATABASE_URL = "postgresql://user:SECRET@host/db";
  process.env.ENTITLEMENTS_ENABLED = "true";
  const serialized = JSON.stringify(entitlementStatus());

  assert.doesNotMatch(serialized, /SECRET/);
  assert.doesNotMatch(serialized, /postgresql/);
  assert.doesNotMatch(serialized, /player|balance|ledger|credit_cost/i);
  // Booleans, one small integer, one reason code — nothing else.
  assert.deepEqual(
    Object.keys(entitlementStatus()).sort(),
    ["complimentaryGrant", "enforced", "flagEnabled", "reason", "storeReady"]
  );
});

test("/api/version exposes the block without pricing or player data", () => {
  const src = readFileSync("app/api/version/route.ts", "utf8");
  assert.match(src, /entitlements: \{/);
  assert.match(src, /enforced: entitlement\.enforced/);
  assert.match(src, /flag_enabled: entitlement\.flagEnabled/);
  assert.match(src, /store_ready: entitlement\.storeReady/);
  assert.match(src, /complimentary_grant: entitlement\.complimentaryGrant/);
  assert.match(src, /reason: entitlement\.reason/);
  // Deliberately excluded: the cost table and anything per-player.
  assert.doesNotMatch(src, /playCreditCostForBudget|getBalance|getStatus|player_id/);
});

test("the gate ships OFF and is a no-op until switched on", async () => {
  process.env.ENTITLEMENTS_ENABLED = "false";
  assert.equal(isEntitlementEnabled(), false);
  assert.deepEqual(await consumeForGame(P, randomUUID(), 20), { ok: true, reason: "disabled" });
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
