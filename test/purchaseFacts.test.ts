import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PURCHASE_FACTS_MAX_BYTES,
  PURCHASE_FACTS_SCHEMA_VERSION,
  validatePurchaseFacts,
} from "../lib/purchaseFacts";

const valid = () => ({
  provider: "stripe",
  source: "dics",
  purchase_facts_schema_version: "dic-purchase/1",
  product: "Digital Ice Cream",
  flavour: "Vanilla",
  stripe_price_id: "price_123",
  quantity: 2,
  currency: "eur",
  amount_total: 1000,
  purchased_at: "2026-08-17T12:00:00.000Z",
  livemode: false,
});

test("valid DICS purchase facts are accepted verbatim", () => {
  const facts = valid();
  assert.equal(PURCHASE_FACTS_SCHEMA_VERSION, "dic-purchase/1");
  assert.equal(validatePurchaseFacts(facts), facts);
});

test("the envelope is exact, typed, and provider-scoped", () => {
  for (const bad of [
    null,
    [],
    { ...valid(), provider: "other" },
    { ...valid(), source: "other" },
    { ...valid(), purchase_facts_schema_version: "dic-purchase/2" },
    { ...valid(), quantity: 0 },
    { ...valid(), amount_total: -1 },
    { ...valid(), currency: "EURO" },
    { ...valid(), purchased_at: "not-a-date" },
    { ...valid(), email: "pii@example.test" },
  ]) {
    assert.equal(validatePurchaseFacts(bad), null);
  }
});

test("purchase facts are size capped", () => {
  assert.equal(PURCHASE_FACTS_MAX_BYTES, 4096);
  assert.equal(validatePurchaseFacts({ ...valid(), product: "x".repeat(5000) }), null);
});

test("migration 0008 confines immutable provenance to purchase rows", () => {
  const migration = readFileSync("migrations/0008_purchase_provenance.sql", "utf8");
  assert.match(migration, /ADD COLUMN purchase_facts jsonb/);
  assert.match(migration, /purchase_facts IS NULL OR kind = 'purchase'/);
  assert.match(migration, /jsonb_typeof\(purchase_facts\) = 'object'/);
  assert.match(migration, /octet_length\(purchase_facts::text\) <= 8192/);

  const foundation = readFileSync("migrations/0004_accounts_entitlements.sql", "utf8");
  assert.match(foundation, /reject_ledger_mutation/);
  assert.match(foundation, /BEFORE UPDATE OR DELETE ON accounts\.entitlement_ledger/);
});

test("purchase facts are inserted once with the purchase ledger row", () => {
  const entitlements = readFileSync("lib/entitlements.ts", "utf8");
  const purchase = entitlements.slice(
    entitlements.indexOf("export async function grantPurchase"),
    entitlements.indexOf("export async function expireCredits")
  );
  assert.match(purchase, /purchase_facts/);
  assert.match(purchase, /JSON\.stringify\(options\.purchaseFacts\)/);
  assert.doesNotMatch(purchase, /UPDATE|DELETE FROM/);
});

test("STRUCTURAL: provenance is never read by catalogue or credit calculation", () => {
  const catalogue = readFileSync("lib/playCreditPackages.ts", "utf8");
  const grantRoute = readFileSync("app/api/entitlement/grant/route.ts", "utf8");
  const entitlements = readFileSync("lib/entitlements.ts", "utf8");

  assert.doesNotMatch(catalogue, /purchaseFacts|purchase_facts/);
  assert.match(grantRoute, /const credits = creditsForPackage\(packageId, quantity\)/);
  assert.doesNotMatch(grantRoute, /creditsForPackage\([^)]*(purchaseFacts|purchase_facts)/);
  assert.doesNotMatch(catalogue, /amount_total|currency|stripe_price_id/);

  const beforeInsert = entitlements.slice(
    entitlements.indexOf("export async function grantPurchase"),
    entitlements.indexOf("const sql = requireSql()", entitlements.indexOf("export async function grantPurchase"))
  );
  assert.doesNotMatch(beforeInsert, /purchaseFacts|purchase_facts/);
});
