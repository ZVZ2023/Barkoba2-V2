import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  generatePurchaseRef,
  normalizePurchaseRef,
  PURCHASE_REF_TTL_SECONDS,
} from "../lib/purchaseRef";

// ---------------------------------------------------------------------------
// V2.4 — the commercial journey: visibility, claim-before-purchase, and the
// adapter contract.
//
// The ledger behaviours themselves are proven in test/entitlements.test.ts and
// are not repeated. What is proven here is the SHAPE of the new surface: who
// can call what, what crosses the adapter boundary, and that the sequencing
// guarantee is enforced by the server rather than by the screen.
// ---------------------------------------------------------------------------

const BALANCE_ROUTE = readFileSync("app/api/player/entitlement/route.ts", "utf8");
const INTENT_ROUTE = readFileSync("app/api/entitlement/intent/route.ts", "utf8");
const GRANT_ROUTE = readFileSync("app/api/entitlement/grant/route.ts", "utf8");

/**
 * Code with comments removed.
 *
 * These files explain their own boundaries in prose — "no pricing crosses
 * here", "this never computes a cost" — so a bare substring search finds the
 * rationale and reports it as the very thing it forbids.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

// --- 1. balance is the caller's own, and nobody else's ----------------------

test("1. the balance route is session-scoped and cannot name another player", () => {
  // The id comes only from the trusted header middleware sets after stripping
  // any client copy. There is no parameter to ask about someone else.
  assert.match(BALANCE_ROUTE, /playerIdFromHeaders\(req\.headers\)/);
  assert.doesNotMatch(BALANCE_ROUTE, /searchParams|params\.|body\./);
  // Reuses the existing computation rather than adding a second one.
  assert.match(BALANCE_ROUTE, /getStatus\(playerId\)/);
  assert.doesNotMatch(BALANCE_ROUTE, /SUM\(amount\)|entitlement_ledger/);
});

test("1b. an unreadable balance is not reported as zero", () => {
  assert.match(BALANCE_ROUTE, /entitlement_unavailable/);
  assert.match(BALANCE_ROUTE, /status: 503/);
});

// --- 2. cost visibility, client marks but never decides ---------------------

test("2. per-tier costs come from the existing cost function", () => {
  assert.match(BALANCE_ROUTE, /playCreditCostForBudget\(b\)/);
  assert.match(BALANCE_ROUTE, /QUESTION_BUDGETS/);
});

test("2b. the picker MARKS unaffordable tiers, it does not block them", () => {
  const picker = readFileSync("app/components/BudgetPicker.tsx", "utf8");
  assert.match(picker, /unaffordable/);
  assert.match(picker, /opacity-45/);
  // disabled is driven by `disabled` (busy), never by affordability.
  assert.doesNotMatch(picker, /disabled=\{[^}]*unaffordable/);
});

test("2c. no balance or price is computed on the client", () => {
  const ui = codeOnly(readFileSync("app/components/Entitlement.tsx", "utf8"));
  assert.match(ui, /\/api\/player\/entitlement/);
  assert.doesNotMatch(ui, /playCreditCostForBudget|entitlement_ledger|SUM\(/);
});

// --- 3. claim before purchase, enforced by the server ----------------------

test("3. intent REFUSES an unclaimed player — the rule is server-side", () => {
  assert.match(INTENT_ROUTE, /getDurablePlayer\(playerId\)/);
  assert.match(INTENT_ROUTE, /claim_required/);
  assert.match(INTENT_ROUTE, /status: 409/);
  // The reference is minted only after the durable check.
  const check = INTENT_ROUTE.indexOf("getDurablePlayer");
  const mint = INTENT_ROUTE.indexOf("createPurchaseRef");
  assert.ok(check > 0 && mint > check, "claim must be verified before minting");
});

test("3b. the gateway routes to the EXISTING claim flow, unmodified", () => {
  const ui = readFileSync("app/components/Entitlement.tsx", "utf8");
  assert.match(ui, /import ClaimPrompt from "\.\/ClaimPrompt"/);
  assert.match(ui, /\/api\/player\/claim/);
  // No purpose-built claim variant.
  assert.doesNotMatch(ui, /claimPlayer|generateRecoveryCode|recovery_key/);
});

test("3c. no recovery code is surfaced anywhere in the purchase journey", () => {
  // Option C: the player claimed first, so there is nothing to show here — and
  // Barkóba never holds a raw credential for this flow.
  const ui = readFileSync("app/components/Entitlement.tsx", "utf8");
  assert.doesNotMatch(ui, /recovery_code/);
  assert.doesNotMatch(INTENT_ROUTE, /recovery_code|recoveryCode/);
  // The grant route may only LOG that it happened, never return it.
  assert.doesNotMatch(GRANT_ROUTE, /recovery_code: |recoveryCode,|recovery_code"/);
});

// --- 4. the purchase reference ---------------------------------------------

test("4. the reference reuses the joinCode pattern, not a new mechanism", () => {
  const ref = readFileSync("lib/purchaseRef.ts", "utf8");
  const join = readFileSync("lib/joinCode.ts", "utf8");
  for (const shared of ["getKV", "ALPHABET", "normalize", "consume"]) {
    assert.ok(ref.includes(shared) && join.includes(shared), `both should use ${shared}`);
  }
  // Redis only — no new table, no new schema.
  assert.doesNotMatch(ref, /accounts\.|entitlement_ledger|CREATE TABLE/);
});

test("4b. references are opaque, long, and valid for a DICS shopping day", () => {
  const a = generatePurchaseRef();
  const b = generatePurchaseRef();
  assert.equal(a.length, 16);
  assert.notEqual(a, b);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]+$/, "Crockford Base32: no I, L, O or U");
  assert.equal(PURCHASE_REF_TTL_SECONDS, 24 * 60 * 60);
  assert.equal(normalizePurchaseRef(" abc-def "), "ABCDEF");
});

test("4c. the reference is scoped to the calling session and consumed on use", () => {
  assert.match(INTENT_ROUTE, /createPurchaseRef\(playerId\)/);
  assert.match(GRANT_ROUTE, /resolvePurchaseRef\(purchaseRef\)/);
  // Marked spent BY A NAMED ORDER rather than deleted, so a redelivered
  // callback is recognisable instead of merely surviving. Behaviour is proven
  // in test/entitlementRetry.test.ts; this only pins the call shape.
  assert.match(GRANT_ROUTE, /consumePurchaseRef\(purchaseRef, externalOrderId\)/);
  assert.doesNotMatch(GRANT_ROUTE, /consumePurchaseRef\(purchaseRef\)/);
});

// --- 5. the grant endpoint is server-to-server only ------------------------

test("5. grant requires the shared secret; a session cookie is not enough", () => {
  assert.match(GRANT_ROUTE, /entitlementGrantSecret\(\)/);
  assert.match(GRANT_ROUTE, /authorization/i);
  assert.match(GRANT_ROUTE, /constantTimeEqual/);
  assert.match(GRANT_ROUTE, /status: 401/);
  // A browser could only ever present a cookie — which this route never reads.
  assert.doesNotMatch(GRANT_ROUTE, /playerIdFromHeaders|cookies\(\)/);
});

test("5b. an unset secret closes the endpoint rather than opening it", () => {
  const guard = GRANT_ROUTE.slice(0, GRANT_ROUTE.indexOf("const header"));
  assert.match(guard, /if \(!configured\)/);
  assert.match(guard, /return unauthorized\(\)/);
});

test("5c. the secret is server-only and never reaches client code", () => {
  const env = readFileSync("lib/env.ts", "utf8");
  assert.match(env, /ENTITLEMENT_GRANT_SECRET/);
  for (const f of [
    "app/components/Entitlement.tsx",
    "app/components/BudgetPicker.tsx",
    "app/ComposerEntry.tsx",
    "app/RacerSetup.tsx",
    "app/play/human/HumanSetup.tsx",
  ]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /ENTITLEMENT_GRANT_SECRET/, f);
  }
});

// --- 6. idempotency via the existing constraint ---------------------------

test("6. external_order_id becomes grant_key — no migration, no new mechanism", () => {
  assert.match(GRANT_ROUTE, /grantKey: externalOrderId/);
  // The uniqueness that makes a replay a no-op already exists.
  const m = readFileSync("migrations/0004_accounts_entitlements.sql", "utf8");
  assert.match(m, /entitlement_grant_key_once/);
  assert.match(m, /\(player_id, grant_key\)\s*\n?\s*WHERE grant_key IS NOT NULL/);
  // A replay reports duplicate rather than failing, so the adapter stops retrying.
  assert.match(GRANT_ROUTE, /duplicate: !result\.granted/);
});

test("6b. grantPurchase is called, not reimplemented", () => {
  assert.match(GRANT_ROUTE, /grantPurchase\(playerId, credits/);
  assert.doesNotMatch(GRANT_ROUTE, /INSERT INTO|claimPlayer|getDurablePlayer/);
});

// --- 8. the silent-claim branch must not fire on this path ----------------

test("8. a silent claim during purchase is reported as a sequencing defect", () => {
  assert.match(GRANT_ROUTE, /result\.recoveryCode/);
  assert.match(GRANT_ROUTE, /SEQUENCING DEFECT/);
  // Structurally it cannot fire: intent refuses unclaimed players, so no
  // purchase_ref can exist for one.
  assert.match(INTENT_ROUTE, /claim_required/);
});

// --- adapter boundary -----------------------------------------------------

test("the contract carries no pricing decision and no identity", () => {
  const code = codeOnly(GRANT_ROUTE);
  assert.match(code, /purchase_ref/);
  assert.match(code, /external_order_id/);
  assert.match(code, /credits/);
  assert.match(code, /purchase_facts/);
  // Attested money may be stored, but never used to derive the grant.
  assert.doesNotMatch(code, /credits\s*=.*purchase_facts|creditsForPackage\([^)]*purchase_facts/i);
  // player_id never crosses the boundary — only the opaque reference does.
  assert.doesNotMatch(code, /body\.player_id|player_id\?\?/);
});

test("V2.6: the adapter names a PACKAGE and cannot supply an amount", () => {
  // REVERSES THE V2.4 ASSERTION THIS REPLACES, deliberately. V2.4 required
  // `credits` to be a positive integer supplied by the adapter, on the reasoning
  // that price-to-credits was the adapter's decision. That was defensible while
  // no adapter existed; with a real storefront and a real payment provider on
  // the other end it means a compromised or misconfigured stand can mint any
  // quantity and have Barkóba record it as a legitimate purchase.
  //
  // The split moved: the stand still owns the cash price, Barkóba now owns what
  // a package is WORTH.
  assert.match(GRANT_ROUTE, /creditsForPackage\(packageId\)/);
  assert.match(GRANT_ROUTE, /unknown_package/);
  // Rejected, not ignored — a caller still sending it holds a wrong model of
  // who prices a sale, and this is the cheapest place to correct that.
  assert.match(GRANT_ROUTE, /credits_not_accepted/);
  assert.doesNotMatch(GRANT_ROUTE, /const credits = body\.credits/);
});

// --- 9. nothing frozen or previously proven was disturbed ----------------

test("9. no frozen gameplay surface or isolation change", () => {
  // The entitlement allowlist and quarantine are unchanged.
  const iso = readFileSync("scripts/check-isolation.mjs", "utf8");
  const permitted = iso.slice(
    iso.indexOf("const PERMITTED_SECRET_IMPORTERS"),
    iso.indexOf("const QUARANTINED")
  );
  assert.doesNotMatch(permitted, /entitlement|purchaseRef/);

  // The cost curve and complimentary grant are untouched.
  const budget = readFileSync("lib/questionBudget.ts", "utf8");
  assert.match(budget, /20: 1,\s*\n\s*35: 2,\s*\n\s*50: 3,\s*\n\s*100: 5,/);
  assert.match(readFileSync("lib/env.ts", "utf8"), /ENTITLEMENT_COMPLIMENTARY_GRANT", 10/);

  // Purchase-reference storage remains Redis-only; provenance is ledger-owned.
  assert.doesNotMatch(readFileSync("lib/purchaseRef.ts", "utf8"), /migration|ALTER TABLE/);
});

test("9b. middleware strips the trusted header across the new namespace", () => {
  const mw = readFileSync("middleware.ts", "utf8");
  assert.match(mw, /"\/api\/entitlement\/:path\*"/);
});
