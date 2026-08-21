import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  canStartGame,
  consumeForGame,
  ensureInitialComplimentary,
  hasUnlimitedPlay,
  inspectUnlimitedPlay,
} from "../lib/entitlements";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { QUESTION_BUDGETS } from "../lib/questionBudget";

// ---------------------------------------------------------------------------
// V2.6 — developer / tester unlimited play.
//
// SCOPE, STATED HONESTLY, as every other database-facing suite here states it:
// there is no PostgreSQL in this test environment. These tests verify what the
// application DOES — which statements it issues, which it does NOT issue, and
// how it behaves when the lookup fails — plus static guards that migration 0007
// still says what the application assumes.
//
// The behaviour most worth proving is a NEGATIVE: that an exempt identity
// writes nothing to the ledger. A test that only checked "the game starts"
// would pass just as happily against an implementation that silently granted
// itself credits, which is the failure this design exists to avoid.
// ---------------------------------------------------------------------------

const UNLIMITED = "u".repeat(32);
const ORDINARY = "o".repeat(32);

/** player_id -> email_verified_at, or absent entirely for "no account at all". */
let emailVerifiedAt: Map<string, string | null>;

interface Recorded {
  sql: string;
  values: SqlValue[];
}

let calls: Recorded[] = [];
/** Which player ids the fake treats as holding an active grant. */
let exempt = new Set<string>();
/** Ordinary players' balances, for the non-exempt path. */
let balances = new Map<string, number>();
let unlimitedLookupFails = false;

/**
 * Ledger rows the fake actually APPLIED, as distinct from statements issued.
 *
 * The distinction is load-bearing. `consumeForGame`'s charge is a CONDITIONAL
 * insert — the balance test lives inside the SQL — so the statement is issued
 * even when it writes nothing. Asserting on statements alone would report
 * contamination where there is none, and would hide the difference between
 * "the gate refused" and "the gate never ran".
 */
let applied: Array<{ player_id: string; kind: string; amount: number }> = [];

const SAVED = {
  enabled: process.env.ENTITLEMENTS_ENABLED,
  db: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
};

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const sql = strings.join(" ");
  calls.push({ sql, values });
  const v = values as unknown[];

  if (/FROM accounts\.unlimited_play/.test(sql)) {
    if (unlimitedLookupFails) {
      return Promise.reject(new Error("relation accounts.unlimited_play does not exist"));
    }
    return Promise.resolve(exempt.has(String(v[0])) ? [{ "?column?": 1 }] : []);
  }

  if (/SELECT COALESCE\(SUM\(amount\), 0\) AS balance/.test(sql)) {
    return Promise.resolve([{ balance: balances.get(String(v[0])) ?? 0 }]);
  }

  // The conditional charge. Parameters, in statement order:
  //   [playerId, -cost, gameId, playerId, cost]
  // The WHERE clause is the balance test, so the fake has to evaluate it —
  // returning a row unconditionally would model a ledger with no gate at all.
  if (/'consumption'/.test(sql) && /INSERT INTO\s+accounts\.entitlement_ledger/i.test(sql)) {
    const player = String(v[0]);
    const amount = Number(v[1]);
    const cost = Number(v[4]);
    if ((balances.get(player) ?? 0) >= cost) {
      balances.set(player, (balances.get(player) ?? 0) + amount);
      applied.push({ player_id: player, kind: "consumption", amount });
      return Promise.resolve([{ entry_id: applied.length }]);
    }
    return Promise.resolve([]);
  }

  if (/'complimentary_grant'/.test(sql) && /INSERT INTO\s+accounts\.entitlement_ledger/i.test(sql)) {
    const player = String(v[0]);
    const amount = Number(v[1]);
    balances.set(player, (balances.get(player) ?? 0) + amount);
    applied.push({ player_id: player, kind: "complimentary_grant", amount });
    return Promise.resolve([{ entry_id: applied.length }]);
  }

  // getPlayerAccount(), which ensureInitialComplimentary now consults to gate
  // on email_verified_at. Absent from the map models "no accounts.players row
  // at all" — a guest — the same way a real SELECT returns no rows for one.
  if (/FROM accounts\.players/.test(sql) && /player_id =/.test(sql)) {
    const playerId = String(v[0]);
    if (!emailVerifiedAt.has(playerId)) return Promise.resolve([]);
    return Promise.resolve([
      {
        player_id: playerId,
        recovery_key: "k".repeat(64),
        display_name: null,
        created_at: new Date().toISOString(),
        registered_at: new Date().toISOString(),
        email: "player@example.com",
        email_verified_at: emailVerifiedAt.get(playerId) ?? null,
        email_verification_token: null,
        email_verification_expires_at: null,
        photo_url: null,
      },
    ]);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

/** Rows that actually landed in the ledger. See the note on `applied`. */
function ledgerWrites() {
  return applied;
}

/** Statements ISSUED against the ledger, regardless of whether they wrote. */
function ledgerStatements(): Recorded[] {
  return calls.filter((c) => /INSERT INTO\s+accounts\.entitlement_ledger/i.test(c.sql));
}

beforeEach(() => {
  calls = [];
  applied = [];
  exempt = new Set([UNLIMITED]);
  balances = new Map();
  emailVerifiedAt = new Map();
  unlimitedLookupFails = false;
  process.env.ENTITLEMENTS_ENABLED = "true";
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  process.env.ENTITLEMENTS_ENABLED = SAVED.enabled ?? "";
  process.env.DATABASE_URL = SAVED.db ?? "";
  process.env.CORPUS_ENABLED = SAVED.corpus ?? "";
  if (SAVED.enabled === undefined) delete process.env.ENTITLEMENTS_ENABLED;
  if (SAVED.db === undefined) delete process.env.DATABASE_URL;
  if (SAVED.corpus === undefined) delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
});

// ---------------------------------------------------------------------------
// The lookup itself.
// ---------------------------------------------------------------------------

test("an active grant is found; an ordinary player has none", async () => {
  assert.equal(await hasUnlimitedPlay(UNLIMITED), true);
  assert.equal(await hasUnlimitedPlay(ORDINARY), false);
  assert.deepEqual(await inspectUnlimitedPlay(UNLIMITED), {
    active: true,
    lookup: "ok",
  });
  assert.deepEqual(await inspectUnlimitedPlay(ORDINARY), {
    active: false,
    lookup: "ok",
  });
});

test("the lookup only ever considers ACTIVE grants", async () => {
  await hasUnlimitedPlay(UNLIMITED);
  const lookup = calls.find((c) => /accounts\.unlimited_play/.test(c.sql));
  assert.ok(lookup);
  // A revoked grant must be invisible to the gate. Asserted against the query
  // because the predicate is the entire revocation mechanism.
  assert.match(lookup.sql, /revoked_at\s+IS NULL/i);
  assert.ok(lookup.values.includes(UNLIMITED));
});

test("a null player is never exempt, and costs no query", async () => {
  assert.equal(await hasUnlimitedPlay(null), false);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// The guarantee: no ledger contamination.
// ---------------------------------------------------------------------------

test("an unlimited player starts a game at EVERY budget tier", async () => {
  for (const budget of QUESTION_BUDGETS) {
    const r = await consumeForGame(UNLIMITED, randomUUID(), budget);
    assert.deepEqual(
      r,
      { ok: true, reason: "unlimited" },
      `budget ${budget} must not be refused`
    );
  }
});

test("THE CORE GUARANTEE: an unlimited player writes NOTHING to the ledger", async () => {
  // The negative that matters. An implementation that silently granted itself
  // credits would pass a "the game starts" test and fail this one.
  for (const budget of QUESTION_BUDGETS) {
    await consumeForGame(UNLIMITED, randomUUID(), budget);
  }
  await canStartGame(UNLIMITED);
  await ensureInitialComplimentary(UNLIMITED);

  assert.deepEqual(
    ledgerWrites(),
    [],
    "the ledger must never learn that an exempt game happened"
  );
  // Stronger, and the reason this design is safe rather than merely correct:
  // no ledger statement is even ISSUED. There is no conditional write whose
  // predicate could later be loosened into a leak.
  assert.deepEqual(ledgerStatements(), []);
});

test("the exemption is budget-INDEPENDENT, not budget-exempt", async () => {
  // No price is ever computed for an exempt identity, so a 100-question game
  // and a 20-question game take an identical path. Proven by the absence of any
  // balance read: the cost check cannot have run.
  await consumeForGame(UNLIMITED, randomUUID(), 100);
  assert.equal(
    calls.some((c) => /SUM\(amount\)/.test(c.sql)),
    false,
    "an exempt charge must not reach the balance test at all"
  );
});

test("an unlimited player never accrues complimentary value", async () => {
  // UNLIMITED deliberately has no accounts.players row in this test — the
  // point is that the exemption fires from hasUnlimitedPlay() alone, before
  // the email-verification gate is ever consulted, not that it happens to
  // also pass that gate.
  await ensureInitialComplimentary(UNLIMITED);
  assert.deepEqual(ledgerWrites(), []);
  // The contrast, in the same test so the two can never drift apart: an
  // ordinary player with a verified email still receives the first-contact
  // allowance unchanged.
  emailVerifiedAt.set(ORDINARY, new Date().toISOString());
  await ensureInitialComplimentary(ORDINARY);
  assert.deepEqual(
    ledgerWrites().map((r) => ({ player_id: r.player_id, kind: r.kind })),
    [{ player_id: ORDINARY, kind: "complimentary_grant" }]
  );
});

// ---------------------------------------------------------------------------
// V2.6.x — the complimentary grant now requires a VERIFIED email, not merely
// a registered account. Closes the abuse path where "verify your email" had
// no actual enforcement: credits arrived at registration regardless of
// whether the address was ever confirmed.
// ---------------------------------------------------------------------------

test("ensureInitialComplimentary refuses a player with no account at all", async () => {
  // A guest player_id with no accounts.players row — getPlayerAccount returns
  // null. Guests are refused for the same reason as an unverified account:
  // neither has a verified email, and the grant must not be reachable by
  // simply not registering.
  const guest = "g".repeat(32);
  await ensureInitialComplimentary(guest);
  assert.deepEqual(ledgerWrites(), []);
});

test("ensureInitialComplimentary refuses a registered account whose email is not yet verified", async () => {
  emailVerifiedAt.set(ORDINARY, null);
  await ensureInitialComplimentary(ORDINARY);
  assert.deepEqual(
    ledgerWrites(),
    [],
    "an unverified address must not be worth the same as a confirmed one"
  );
});

test("ensureInitialComplimentary grants once the account's email is verified", async () => {
  emailVerifiedAt.set(ORDINARY, new Date().toISOString());
  await ensureInitialComplimentary(ORDINARY);
  assert.deepEqual(
    ledgerWrites().map((r) => ({ player_id: r.player_id, kind: r.kind, amount: r.amount })),
    [{ player_id: ORDINARY, kind: "complimentary_grant", amount: 10 }]
  );
});

test("canStartGame reports the exemption rather than a balance", async () => {
  assert.deepEqual(await canStartGame(UNLIMITED), { ok: true, reason: "unlimited" });
});

// ---------------------------------------------------------------------------
// Ordinary players are semantically unchanged.
// ---------------------------------------------------------------------------

test("an ordinary player with no balance is still refused", async () => {
  assert.deepEqual(await canStartGame(ORDINARY), {
    ok: false,
    reason: "insufficient_balance",
  });
  assert.deepEqual(await consumeForGame(ORDINARY, randomUUID(), 20), {
    ok: false,
    reason: "insufficient_balance",
  });
});

test("an ordinary player with balance is charged exactly as before", async () => {
  balances.set(ORDINARY, 5);
  const r = await consumeForGame(ORDINARY, randomUUID(), 20);
  assert.deepEqual(r, { ok: true, reason: "consumed" });
  assert.deepEqual(ledgerWrites(), [
    { player_id: ORDINARY, kind: "consumption", amount: -1 },
  ]);
  assert.equal(balances.get(ORDINARY), 4, "20 questions still costs 1 credit");
});

test("an unconfigured player id is unchanged", async () => {
  assert.deepEqual(await canStartGame(null), { ok: false, reason: "no_player" });
  assert.deepEqual(await consumeForGame(null, randomUUID(), 20), {
    ok: false,
    reason: "no_player",
  });
});

test("with the gate off, nothing consults the grant table", async () => {
  process.env.ENTITLEMENTS_ENABLED = "false";
  assert.deepEqual(await canStartGame(UNLIMITED), { ok: true, reason: "disabled" });
  assert.deepEqual(await consumeForGame(UNLIMITED, randomUUID(), 20), {
    ok: true,
    reason: "disabled",
  });
  await ensureInitialComplimentary(UNLIMITED);
  assert.equal(
    calls.some((c) => /unlimited_play/.test(c.sql)),
    false,
    "a disabled gate must not pay for a lookup it cannot act on"
  );
});

// ---------------------------------------------------------------------------
// Failure posture.
// ---------------------------------------------------------------------------

test("FAILS CLOSED: a broken lookup falls through to ordinary enforcement", async () => {
  // The single most important failure test. If this ever returned true on
  // error, an outage of a two-row table would become free play for everyone.
  unlimitedLookupFails = true;

  assert.deepEqual(await inspectUnlimitedPlay(UNLIMITED), {
    active: false,
    lookup: "error",
  });
  assert.equal(await hasUnlimitedPlay(UNLIMITED), false);
  assert.deepEqual(await canStartGame(UNLIMITED), {
    ok: false,
    reason: "insufficient_balance",
  });
  assert.deepEqual(await consumeForGame(UNLIMITED, randomUUID(), 20), {
    ok: false,
    reason: "insufficient_balance",
  });
  assert.deepEqual(ledgerWrites(), [], "a failed lookup must not write either");
});

test("a broken lookup does not lock an exempt player out of ordinary credits", async () => {
  // The other half of failing closed: falling through means falling through to
  // the NORMAL rules, not to refusal. A developer who also holds real credits
  // can still spend them while the grant table is unreachable.
  unlimitedLookupFails = true;
  balances.set(UNLIMITED, 3);
  const r = await consumeForGame(UNLIMITED, randomUUID(), 20);
  assert.deepEqual(r, { ok: true, reason: "consumed" });
  assert.deepEqual(ledgerWrites(), [
    { player_id: UNLIMITED, kind: "consumption", amount: -1 },
  ]);
});

// ---------------------------------------------------------------------------
// The exemption's boundary — what it must NOT bypass.
// ---------------------------------------------------------------------------

test("the exemption lives ONLY in entitlement, and touches nothing else", () => {
  // Unlimited PLAY must never become unlimited SPEND. A field-testing loop that
  // bypassed the daily model-call ceiling could exhaust the provider budget and
  // take production down for ordinary players.
  //
  // Asserted structurally: no module outside lib/entitlements.ts may consult
  // the grant, so rate limiting and the call ceiling cannot have been made
  // conditional on it.
  const permitted = new Set([
    "lib/entitlements.ts",
    "app/api/player/entitlement/route.ts",
    "test/unlimitedPlay.test.ts",
  ]);
  const offenders: string[] = [];
  for (const file of [
    "lib/callBudget.ts",
    "lib/rateLimit.ts",
    "app/api/game/create/route.ts",
    "app/api/game/[id]/turn/route.ts",
    "app/api/game/[id]/ask/route.ts",
    "app/api/game/[id]/clue/route.ts",
    "app/api/game/[id]/resolve/route.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    if (/hasUnlimitedPlay|unlimited_play/.test(src) && !permitted.has(file)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], "the exemption leaked outside the entitlement gate");
});

test("the entitlement gate is still the only entitlement checkpoint", () => {
  // Restates the V2.4 invariant against the new code: no turn, answer, clue,
  // correction or resolution route may consult entitlement, so neither
  // exhaustion nor an exemption can affect a game already under way.
  for (const file of [
    "app/api/game/[id]/turn/route.ts",
    "app/api/game/[id]/ask/route.ts",
    "app/api/game/[id]/clue/route.ts",
    "app/api/game/[id]/correct/route.ts",
    "app/api/game/[id]/resolve/route.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.equal(
      /from "@\/lib\/entitlements"/.test(src),
      false,
      `${file} must not consult entitlement`
    );
  }
});

// ---------------------------------------------------------------------------
// Static guards on migration 0007.
// ---------------------------------------------------------------------------

const MIGRATION = readFileSync("migrations/0007_unlimited_play.sql", "utf8");
const MIGRATION_SQL = MIGRATION.replace(/--[^\n]*/g, "");

test("0007: at most one ACTIVE grant per player, with history preserved", () => {
  // Partial on revoked_at IS NULL. A plain UNIQUE(player_id) would have forced
  // revocation to be an update-in-place and destroyed the grant history.
  assert.match(
    MIGRATION_SQL,
    /CREATE UNIQUE INDEX[\s\S]*unlimited_play_one_active_per_player[\s\S]*\(\s*player_id\s*\)\s*WHERE\s+revoked_at\s+IS NULL/i
  );
});

test("0007: revocation is a timestamp, never a delete", () => {
  assert.match(MIGRATION_SQL, /revoked_at\s+timestamptz/i);
  assert.equal(/\bON DELETE\b/i.test(MIGRATION_SQL), false);
});

test("0007: no expiry, no amount, no quota — this is not a balance", () => {
  for (const forbidden of ["expires_at", "amount", "credits", "quota", "balance"]) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`, "i").test(MIGRATION_SQL),
      false,
      `unlimited play must not carry a '${forbidden}' column`
    );
  }
});

test("0007: the ledger is not touched in any way", () => {
  assert.equal(/entitlement_ledger/i.test(MIGRATION_SQL), false);
  assert.equal(/\bALTER TABLE\b/i.test(MIGRATION_SQL), false);
  assert.equal(/\bDROP TABLE\b/i.test(MIGRATION_SQL), false);
});
