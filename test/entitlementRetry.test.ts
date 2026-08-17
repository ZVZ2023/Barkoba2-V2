import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { claimPlayer } from "../lib/playerStore";
import {
  createPurchaseRef,
  consumePurchaseRef,
  resolvePurchaseRef,
  PURCHASE_REF_TTL_SECONDS,
  PURCHASE_REF_CONSUMED_TTL_SECONDS,
} from "../lib/purchaseRef";
import { POST } from "../app/api/entitlement/grant/route";

// ---------------------------------------------------------------------------
// V2.4 — deterministic grant retry.
//
// The verification pass found that an identical retry of a SUCCESSFUL grant
// could return 404 "unknown reference" or 200 "duplicate" depending on whether
// a best-effort Redis delete had happened to succeed. The ledger was never at
// risk — grant_key made a double grant impossible throughout — but the ADAPTER
// CONTRACT was undecidable, and an adapter that reads 404 as failure would
// refund a customer who is holding the credits.
//
// These tests drive the real route handler, over the real reference store, over
// a modelled ledger. Nothing about the decision is asserted by reading source:
// the whole point is what the endpoint ANSWERS.
// ---------------------------------------------------------------------------

interface Row {
  player_id: string;
  kind: string;
  amount: number;
  grant_key: string | null;
  purchase_facts: Record<string, unknown> | null;
}

let ledger: Row[] = [];

const SECRET = "test_grant_secret_value";
const AUTH = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };

const SAVED = {
  enabled: process.env.ENTITLEMENTS_ENABLED,
  db: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
  secret: process.env.ENTITLEMENT_GRANT_SECRET,
};

/**
 * Ledger stand-in — only the two behaviours this pass depends on: balance is
 * SUM(amount), and (player_id, grant_key) is unique where grant_key is set.
 * That partial unique index is what makes a replay a no-op, so it is modelled
 * rather than assumed.
 */
function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const sql = strings.join(" ");
  const v = values as unknown[];

  if (/SELECT COALESCE\(SUM\(amount\), 0\) AS balance/.test(sql)) {
    const player = String(v[0]);
    const total = ledger.filter((r) => r.player_id === player).reduce((n, r) => n + r.amount, 0);
    return Promise.resolve([{ balance: total }]);
  }

  if (/INSERT INTO accounts\.entitlement_ledger/.test(sql)) {
    const player = String(v[0]);
    const amount = Number(v[1]);
    const grantKey = (v[2] as string | null) ?? null;
    if (grantKey && ledger.some((r) => r.player_id === player && r.grant_key === grantKey)) {
      return Promise.resolve([]); // ON CONFLICT DO NOTHING
    }
    const serializedFacts = (v[5] as string | null) ?? null;
    ledger.push({
      player_id: player,
      kind: "purchase",
      amount,
      grant_key: grantKey,
      purchase_facts: serializedFacts
        ? (JSON.parse(serializedFacts) as Record<string, unknown>)
        : null,
    });
    return Promise.resolve([{ entry_id: ledger.length }]);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (q: Promise<Record<string, unknown>[]>[]) => Promise.all(q);

beforeEach(() => {
  ledger = [];
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  process.env.ENTITLEMENTS_ENABLED = "true";
  process.env.ENTITLEMENT_GRANT_SECRET = SECRET;
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  for (const [k, val] of [
    ["ENTITLEMENTS_ENABLED", SAVED.enabled],
    ["DATABASE_URL", SAVED.db],
    ["CORPUS_ENABLED", SAVED.corpus],
    ["ENTITLEMENT_GRANT_SECRET", SAVED.secret],
  ] as const) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
});

type GrantRequest = Parameters<typeof POST>[0];

interface GrantOutcome {
  status: number;
  body: Record<string, unknown>;
}

async function callGrant(body: unknown, headers: Record<string, string> = AUTH): Promise<GrantOutcome> {
  const req = new Request("https://barkoba.test/api/entitlement/grant", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as unknown as GrantRequest;
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A claimed player, as Option C guarantees before any reference is minted. */
async function claimedPlayer(id: string): Promise<string> {
  await claimPlayer(id, null, "TEST-RECOVERY-CODE");
  return id;
}

const purchaseRows = () => ledger.filter((r) => r.kind === "purchase");

const purchaseFacts = () => ({
  provider: "stripe",
  source: "dics",
  purchase_facts_schema_version: "dic-purchase/1",
  product: "Digital Ice Cream",
  flavour: "Vanilla",
  stripe_price_id: "price_123",
  quantity: 1,
  currency: "eur",
  amount_total: 500,
  purchased_at: "2026-08-17T12:00:00.000Z",
  livemode: false,
});

// --- 1. a fresh reference grants -------------------------------------------

test("1. a fresh valid reference grants exactly once", async () => {
  const player = await claimedPlayer("a".repeat(32));
  const ref = await createPurchaseRef(player);

  const res = await callGrant({
    purchase_ref: ref,
    external_order_id: "order_1",
    package_id: "test_scoop_5",
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.granted, true);
  assert.equal(res.body.duplicate, false);
  assert.equal(res.body.external_order_id, "order_1");
  assert.equal(purchaseRows().length, 1);
  assert.equal(purchaseRows()[0]?.amount, 5, "the catalogue decides, not the caller");
});

test("1b. valid purchase facts are stored without affecting credits", async () => {
  const player = await claimedPlayer("n".repeat(32));
  const ref = await createPurchaseRef(player);
  const facts = purchaseFacts();

  const res = await callGrant({
    purchase_ref: ref,
    external_order_id: "order_1b",
    package_id: "test_scoop_5",
    purchase_facts: facts,
  });

  assert.equal(res.status, 200);
  assert.equal(purchaseRows()[0]?.amount, 5, "provenance cannot alter catalogue credits");
  assert.deepEqual(purchaseRows()[0]?.purchase_facts, facts);
});

test("1c. malformed or oversized purchase facts are refused before insertion", async () => {
  for (const [suffix, facts] of [
    ["shape", { ...purchaseFacts(), email: "pii@example.test" }],
    ["size", { ...purchaseFacts(), product: "x".repeat(5000) }],
  ] as const) {
    const player = await claimedPlayer((suffix === "shape" ? "o" : "q").repeat(32));
    const ref = await createPurchaseRef(player);
    const res = await callGrant({
      purchase_ref: ref,
      external_order_id: `order_1c_${suffix}`,
      package_id: "test_scoop_5",
      purchase_facts: facts,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_purchase_facts");
  }
  assert.equal(purchaseRows().length, 0);
});

// --- 2. the identical retry is harmless AND deterministic -------------------

test("2. an identical retry returns duplicate, grants nothing, and never 404s", async () => {
  const player = await claimedPlayer("b".repeat(32));
  const ref = await createPurchaseRef(player);
  const call = { purchase_ref: ref, external_order_id: "order_2", package_id: "test_scoop_5" };

  const first = await callGrant(call);
  assert.equal(first.status, 200);
  assert.equal(first.body.granted, true);

  // Three further deliveries of the same callback — a retry storm.
  const retries = [await callGrant(call), await callGrant(call), await callGrant(call)];

  for (const r of retries) {
    assert.equal(r.status, 200, "a retry must never be reported as failure");
    assert.equal(r.body.granted, false);
    assert.equal(r.body.duplicate, true, "already processed");
    assert.equal(r.body.external_order_id, "order_2");
  }

  // Byte-identical across every retry: the adapter can branch on it safely.
  const shapes = new Set(retries.map((r) => `${r.status} ${JSON.stringify(r.body)}`));
  assert.equal(shapes.size, 1, "the retry answer must not vary");

  assert.equal(purchaseRows().length, 1, "one purchase row, four deliveries");
  assert.equal(purchaseRows()[0]?.amount, 5, "zero additional credits");
});

test("2b. the retry answer does NOT depend on the reference having been marked", async () => {
  // This is the actual defect class. Previously the response hinged on whether
  // a best-effort Redis write succeeded. Here the mark is deliberately skipped
  // — simulating that write failing — and the answer must be unchanged, because
  // it now comes from the ledger's grant_key rather than from Redis.
  const player = await claimedPlayer("c".repeat(32));
  const ref = await createPurchaseRef(player);
  const call = { purchase_ref: ref, external_order_id: "order_2b", package_id: "test_scoop_5" };

  await callGrant(call);

  // Roll the reference back to fresh, as a failed mark would have left it.
  await createPurchaseRefAs(ref, player);
  const afterFailedMark = await callGrant(call);

  assert.equal(afterFailedMark.status, 200);
  assert.equal(afterFailedMark.body.granted, false);
  assert.equal(afterFailedMark.body.duplicate, true);
  assert.equal(purchaseRows().length, 1, "still exactly one purchase row");
});

test("2c. DEFECT CLASS: deleting the reference is what made the retry a 404", async () => {
  // Documents the behaviour this pass removed. If this ever stops reproducing,
  // the tests above have stopped being able to tell the fix from the defect.
  const { getKV } = await import("../lib/kv");
  const player = await claimedPlayer("p".repeat(32));
  const ref = await createPurchaseRef(player);
  const call = { purchase_ref: ref, external_order_id: "order_2c", package_id: "test_scoop_5" };

  const first = await callGrant(call);
  assert.equal(first.body.granted, true);

  // The old consume: del(). Everything else about the endpoint is unchanged.
  await getKV().del(`purchase_ref:${ref}`);

  const retry = await callGrant(call);
  assert.equal(retry.status, 404, "this is the defect — a successful grant reported as unknown");
  assert.equal(purchaseRows().length, 1, "safety always held; only the CONTRACT was wrong");
});

/** Re-plant a specific reference as unspent, standing in for a failed mark. */
async function createPurchaseRefAs(ref: string, playerId: string): Promise<void> {
  const { getKV } = await import("../lib/kv");
  await getKV().set(`purchase_ref:${ref}`, { player_id: playerId }, PURCHASE_REF_TTL_SECONDS);
}

// --- 3. a spent reference cannot be turned on another order -----------------

test("3. a spent reference presented with a DIFFERENT order is refused", async () => {
  const player = await claimedPlayer("d".repeat(32));
  const ref = await createPurchaseRef(player);

  await callGrant({ purchase_ref: ref, external_order_id: "order_3a", package_id: "test_scoop_5" });
  assert.equal(purchaseRows().length, 1);

  const stolen = await callGrant({
    purchase_ref: ref,
    external_order_id: "order_3b",
    package_id: "test_scoop_5",
  });

  assert.equal(stolen.status, 404);
  assert.equal(purchaseRows().length, 1, "no second grant");
  assert.equal(purchaseRows()[0]?.amount, 5, "and not a credit more");
});

// --- 4. unknown and expired are refused identically -------------------------

test("4. unknown, malformed and expired references are refused", async () => {
  await claimedPlayer("e".repeat(32));

  const unknown = await callGrant({
    purchase_ref: "ZZZZZZZZZZZZZZZZ",
    external_order_id: "order_4a",
    package_id: "test_scoop_5",
  });
  const malformed = await callGrant({
    purchase_ref: "TOOSHORT",
    external_order_id: "order_4b",
    package_id: "test_scoop_5",
  });

  assert.equal(unknown.status, 404);
  assert.equal(malformed.status, 404);
  assert.equal(ledger.length, 0, "a refused reference grants nothing");
});

test("4b. expiry is a real TTL, and an expired reference stops resolving", async () => {
  const { getKV } = await import("../lib/kv");
  const player = await claimedPlayer("f".repeat(32));
  const ref = await createPurchaseRef(player);

  assert.notEqual(await resolvePurchaseRef(ref), null);
  // Write it back already past its lifetime rather than waiting 24 hours.
  await getKV().set(`purchase_ref:${ref}`, { player_id: player }, -1);
  assert.equal(await resolvePurchaseRef(ref), null);

  const expired = await callGrant({
    purchase_ref: ref,
    external_order_id: "order_4c",
    package_id: "test_scoop_5",
  });
  assert.equal(expired.status, 404);
  assert.equal(ledger.length, 0);
});

// --- the symmetry requirement -----------------------------------------------

test("the two refusals are indistinguishable — no live-reference oracle", async () => {
  const player = await claimedPlayer("g".repeat(32));
  const spent = await createPurchaseRef(player);
  await callGrant({ purchase_ref: spent, external_order_id: "order_sym", package_id: "test_scoop_5" });

  const consumedByAnother = await callGrant({
    purchase_ref: spent,
    external_order_id: "a_different_order",
    package_id: "test_scoop_5",
  });
  const neverExisted = await callGrant({
    purchase_ref: "ABCDEFGHJKMNPQRS",
    external_order_id: "a_different_order",
    package_id: "test_scoop_5",
  });

  assert.equal(consumedByAnother.status, neverExisted.status);
  assert.deepEqual(consumedByAnother.body, neverExisted.body);
  assert.deepEqual(neverExisted.body, {
    error: "invalid_purchase_ref",
    message: "Unknown, expired or already-used reference.",
  });

  // One refusal helper, so the two cases cannot drift apart later.
  const src = readFileSync("app/api/entitlement/grant/route.ts", "utf8");
  const occurrences = src.match(/invalid_purchase_ref/g) ?? [];
  assert.equal(occurrences.length, 1, "the refusal body must be written exactly once");
});

// --- 5. no retry pattern produces a second purchase row ---------------------

test("5. across every retry pattern, exactly one purchase row exists", async () => {
  const player = await claimedPlayer("h".repeat(32));
  const ref = await createPurchaseRef(player);
  const order = "order_5";

  // Interleave the identical retry, a hostile reuse, and a nonsense reference.
  // V2.6: these used to vary `credits` to prove the amount could not be
  // inflated on a second delivery. That variation is no longer expressible —
  // the caller cannot state an amount at all — which is strictly stronger.
  const calls = [
    { purchase_ref: ref, external_order_id: order, package_id: "test_scoop_5" },
    { purchase_ref: ref, external_order_id: order, package_id: "test_scoop_5" },
    { purchase_ref: ref, external_order_id: "other_order", package_id: "test_scoop_5" },
    { purchase_ref: ref, external_order_id: order, package_id: "test_scoop_5" },
    { purchase_ref: "ZZZZZZZZZZZZZZZZ", external_order_id: order, package_id: "test_scoop_5" },
    { purchase_ref: ref, external_order_id: order, package_id: "test_scoop_5" },
  ];
  for (const c of calls) await callGrant(c);

  assert.equal(purchaseRows().length, 1, "one row after six deliveries");
  assert.equal(purchaseRows()[0]?.amount, 5, "the amount the CATALOGUE named");
  assert.equal(purchaseRows()[0]?.grant_key, order);
});

test("5b. concurrent duplicate deliveries still leave one purchase row", async () => {
  const player = await claimedPlayer("j".repeat(32));
  const ref = await createPurchaseRef(player);
  const call = { purchase_ref: ref, external_order_id: "order_5b", package_id: "test_scoop_5" };

  const results = await Promise.all([
    callGrant(call),
    callGrant(call),
    callGrant(call),
    callGrant(call),
  ]);

  assert.equal(purchaseRows().length, 1, "grant_key holds even when Redis has not caught up");
  assert.equal(results.filter((r) => r.body.granted === true).length, 1);
  assert.equal(results.filter((r) => r.status === 200).length, 4, "none reported as failure");
});

// --- retention ---------------------------------------------------------------

test("a spent reference gets a fresh 24-hour retention clock from spend", async () => {
  // Fresh and consumed windows are each 24 hours, but the consumed clock starts
  // at use. A purchase near the end of its shopping day therefore remains
  // deterministically retryable for another full day.
  assert.equal(PURCHASE_REF_TTL_SECONDS, 24 * 60 * 60);
  assert.equal(PURCHASE_REF_CONSUMED_TTL_SECONDS, 24 * 60 * 60);

  const player = await claimedPlayer("k".repeat(32));
  const ref = await createPurchaseRef(player);
  await consumePurchaseRef(ref, "order_ttl");

  const state = await resolvePurchaseRef(ref);
  assert.deepEqual(state, { playerId: player, consumedBy: "order_ttl" });
});

test("marking is idempotent and cannot rewrite whose reference it is", async () => {
  const player = await claimedPlayer("m".repeat(32));
  const ref = await createPurchaseRef(player);

  await consumePurchaseRef(ref, "order_x");
  await consumePurchaseRef(ref, "order_x");
  assert.deepEqual(await resolvePurchaseRef(ref), { playerId: player, consumedBy: "order_x" });

  // Marking something that does not exist must not create it.
  await consumePurchaseRef("ZZZZZZZZZZZZZZZZ", "order_y");
  assert.equal(await resolvePurchaseRef("ZZZZZZZZZZZZZZZZ"), null);
});

// --- nothing previously guaranteed was weakened -----------------------------

test("the retry fix did not open the endpoint to a browser", async () => {
  const player = await claimedPlayer("n".repeat(32));
  const ref = await createPurchaseRef(player);

  const noSecret = await callGrant(
    { purchase_ref: ref, external_order_id: "order_auth", package_id: "test_scoop_5" },
    { "content-type": "application/json" }
  );
  const wrongSecret = await callGrant(
    { purchase_ref: ref, external_order_id: "order_auth", package_id: "test_scoop_5" },
    { authorization: "Bearer not_the_secret", "content-type": "application/json" }
  );

  assert.equal(noSecret.status, 401);
  assert.equal(wrongSecret.status, 401);
  assert.deepEqual(noSecret.body, { error: "unauthorized" });
  assert.equal(ledger.length, 0);

  // A rejected caller learns nothing about the reference it presented.
  assert.deepEqual(wrongSecret.body, noSecret.body);
});

test("the reference still carries no money, no price and no player id", () => {
  // The file explains at length WHY it holds no money and what the ledger does
  // instead, so a bare substring search finds the rationale and reports it as
  // the very thing it forbids. Assert on code, not on prose.
  const code = readFileSync("lib/purchaseRef.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  // consumed_by holds an ORDER id, which is the adapter's own opaque handle.
  assert.doesNotMatch(code, /price|currency|amount_cents|credits/i);
  // Still Redis-only: the fix added no durable store.
  assert.doesNotMatch(code, /accounts\.|entitlement_ledger|CREATE TABLE/);
  // And the stored record is still exactly two fields.
  assert.match(code, /player_id: hit\.player_id, consumed_by: externalOrderId/);
});
