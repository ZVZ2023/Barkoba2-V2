import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PLAY_CREDIT_PACKAGES,
  creditsForPackage,
  knownPackageIds,
} from "../lib/playCreditPackages";

// ---------------------------------------------------------------------------
// V2.6 — the Play Credit package catalogue and the grant contract change.
//
// WHAT THIS PROTECTS: until V2.6 the grant endpoint took `credits` as an
// integer and honoured it. With a real storefront and a real payment provider
// on the other end, that means a compromised or misconfigured stand can mint
// any quantity it likes and have Barkóba record it as a legitimate purchase.
//
// The tests below pin both the frozen DICS reward table and its negative
// boundary. The payment adapter classifies a paid purchase; Barkóba alone
// decides what that economic class is worth.
// ---------------------------------------------------------------------------

test("the frozen DICS scoop table maps 1/2/3 scoops to 5/15/30 RACES", () => {
  assert.equal(creditsForPackage("dics_scoop", 1), 5);
  assert.equal(creditsForPackage("dics_scoop", 2), 15);
  assert.equal(creditsForPackage("dics_scoop", 3), 30);
  assert.deepEqual(knownPackageIds(), ["dics_custom", "dics_scoop"]);
});

test("custom base and completed €10 economic steps map to 100 + 50 each", () => {
  assert.equal(creditsForPackage("dics_custom", 1), 100);
  assert.equal(creditsForPackage("dics_custom", 2), 150);
  assert.equal(creditsForPackage("dics_custom", 5), 300);
});

test("an unknown package grants nothing", () => {
  for (const id of ["test_scoop_5", "scoop", "DICS_SCOOP", "", "   "]) {
    assert.equal(creditsForPackage(id, 1), null, `must refuse: ${JSON.stringify(id)}`);
  }
});

test("quantity is required, integral and bounded by each economic class", () => {
  for (const quantity of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(creditsForPackage("dics_scoop", quantity), null);
    assert.equal(creditsForPackage("dics_custom", quantity), null);
  }
  assert.equal(creditsForPackage("dics_scoop", 4), null, "DICS scoop purchases stop at three");
});

test("package ids are case- and whitespace-exact", () => {
  // No normalisation on purpose. A near-miss is a misconfiguration on the
  // stand's side and should fail loudly at the first call, not be silently
  // corrected into a grant nobody intended.
  assert.equal(creditsForPackage("Dics_Scoop", 1), null);
  assert.equal(creditsForPackage(" dics_scoop", 1), null);
  assert.equal(creditsForPackage("dics_scoop ", 1), null);
});

test("PROTOTYPE POLLUTION: inherited properties are not packages", () => {
  // `PLAY_CREDIT_PACKAGES[id]` walks the prototype chain, so a request body of
  // {"package_id":"constructor"} would resolve to a function — truthy, and
  // therefore treated as a package by a truthiness check. This id arrives from
  // an HTTP body across a trust boundary. Same exposure getAdapter() had.
  for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.equal(creditsForPackage(id, 1), null, `must refuse inherited: ${id}`);
  }
});

test("a non-string package id grants nothing", () => {
  for (const bad of [null, undefined, 5, {}, [], true, { dics_scoop: "scoop" }]) {
    assert.equal(creditsForPackage(bad, 1), null, `must refuse: ${JSON.stringify(bad)}`);
  }
});

test("the catalogue is frozen — it cannot be extended at runtime", () => {
  assert.ok(Object.isFrozen(PLAY_CREDIT_PACKAGES));
  assert.throws(
    () => {
      "use strict";
      (PLAY_CREDIT_PACKAGES as Record<string, string>).free_1000 = "custom";
    },
    /read only|not extensible|Cannot add/i
  );
  assert.equal(creditsForPackage("free_1000", 1), null);
});

test("every catalogue entry names only a supported economic class", () => {
  assert.deepEqual(new Set(Object.values(PLAY_CREDIT_PACKAGES)), new Set(["scoop", "custom"]));
});

// ---------------------------------------------------------------------------
// The mapping's home, asserted structurally.
// ---------------------------------------------------------------------------

/**
 * Executable source only — both comment styles removed.
 *
 * These checks must read what the code DOES, not what it says about itself.
 * Every one of them documents the mistake it prevents, and naming that mistake
 * in a comment would otherwise trip the check enforcing it. This has now
 * caught me three times (migration 0006's forbidden states, 0007's, and here);
 * stripping is the fix, not softening the assertion.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("the mapping lives in CODE, never in the environment", () => {
  // Same rule lib/questionBudget.ts applies to PLAY_CREDIT_COST, for the same
  // reason: a price in an env var is a price someone can change without a code
  // review. If this ever reads process.env, the guarantee is gone.
  const src = readFileSync("lib/playCreditPackages.ts", "utf8");
  assert.equal(/process\.env/.test(src), false, "packages must not be env-configurable");
  assert.equal(/\bfrom ["']\.\/env["']/.test(src), false);
});

test("the catalogue carries no cash price", () => {
  // Barkóba decides what a package is WORTH in Play Credits. The stand decides
  // what it COSTS a human. Conflating them is how Barkóba ends up holding
  // pricing logic it deliberately does not have.
  const src = code("lib/playCreditPackages.ts");
  for (const token of ["HUF", "EUR", "USD", "price", "amount_total", "currency"]) {
    assert.equal(
      new RegExp(`\\b${token}\\b`, "i").test(src),
      false,
      `no cash concept belongs here: ${token}`
    );
  }
});

// ---------------------------------------------------------------------------
// The grant route's contract, asserted against its source.
//
// The route cannot be invoked without a Next request context, so these are
// static guards — the same technique test/entitlementJourney.test.ts already
// uses for this endpoint.
// ---------------------------------------------------------------------------

const GRANT_SRC = readFileSync("app/api/entitlement/grant/route.ts", "utf8");

test("the route resolves credits from package plus validated economic quantity", () => {
  assert.match(GRANT_SRC, /creditsForPackage\(packageId, quantity\)/);
  // The only `credits` binding must be the resolved one. If a caller-supplied
  // value is ever read into it again, this fails.
  assert.equal(
    /const credits = body\.credits/.test(GRANT_SRC),
    false,
    "credits must not be read from the request body"
  );
});

test("legacy `credits` is REJECTED, not accepted-and-ignored", () => {
  // Ignoring would let a stand keep sending a quantity, keep believing it was
  // honoured, and discover otherwise only by reconciling balances.
  assert.match(GRANT_SRC, /body\.credits !== undefined/);
  assert.match(GRANT_SRC, /credits_not_accepted/);
});

test("grant-level quantity is required and validated before catalogue resolution", () => {
  assert.match(GRANT_SRC, /invalid_quantity/);
  assert.match(GRANT_SRC, /Number\.isSafeInteger\(body\.quantity\)/);
  const validation = GRANT_SRC.indexOf("invalid_quantity");
  const resolution = GRANT_SRC.indexOf("creditsForPackage(packageId, quantity)");
  assert.ok(validation > 0 && resolution > validation);
});

test("an unknown package is refused before any grant is attempted", () => {
  const refusal = GRANT_SRC.indexOf("unknown_package");
  const grant = GRANT_SRC.indexOf("grantPurchase(");
  assert.ok(refusal > 0 && grant > 0);
  assert.ok(refusal < grant, "the package check must precede the grant call");
});

test("an unknown package id is not echoed back to the caller", () => {
  // Reflecting caller input into an error body is a habit worth not having on
  // an endpoint that moves value.
  const block = GRANT_SRC.slice(
    GRANT_SRC.indexOf("unknown_package") - 400,
    GRANT_SRC.indexOf("unknown_package") + 300
  );
  assert.equal(
    /message:\s*`[^`]*\$\{packageId\}/.test(block),
    false,
    "the rejected id must not be reflected"
  );
});

test("idempotency is unchanged — external_order_id is still the grant key", () => {
  assert.match(GRANT_SRC, /grantKey:\s*externalOrderId/);
});

test("the ledger note names the package and economic quantity, not the stand", () => {
  // "digital ice cream purchase" hardcoded the commercial mechanism's name
  // into permanent evidence, which would make a second stand
  // indistinguishable in provenance.
  assert.match(GRANT_SRC, /note:\s*`package:\$\{packageId\};quantity:\$\{quantity\}`/);
  assert.equal(
    /digital ice cream purchase/i.test(code("app/api/entitlement/grant/route.ts")),
    false,
    "the stand's name must not be written into the ledger"
  );
});

test("the shared-secret gate is untouched", () => {
  // This change must not have loosened authorisation while rearranging the
  // body contract.
  assert.match(GRANT_SRC, /entitlementGrantSecret\(\)/);
  assert.match(GRANT_SRC, /constantTimeEqual\(presented, configured\)/);
  assert.match(GRANT_SRC, /if \(!configured\)/);
});

// ---------------------------------------------------------------------------
// The return leg.
// ---------------------------------------------------------------------------

const RETURN_SRC = readFileSync("app/components/PurchaseReturn.tsx", "utf8");

test("the return leg grants nothing — it is display only", () => {
  // Credit moves on the Stripe → payment-side adapter → grant path and nowhere else. A
  // browser redirect must never be able to authorise value.
  assert.equal(/entitlement\/grant/.test(RETURN_SRC), false);
  assert.equal(/method:\s*["']POST["']/i.test(RETURN_SRC), false);
  assert.match(RETURN_SRC, /fetch\("\/api\/player\/entitlement"/);
});

test("exactly ONE delayed re-check, and no polling loop", () => {
  const timers = RETURN_SRC.match(/setTimeout\(/g) ?? [];
  assert.equal(timers.length, 1, "one delayed check, not a loop");
  assert.equal(/setInterval/.test(RETURN_SRC), false, "no polling interval");
});

test("an unresolved return NEVER reports payment failure", () => {
  // This component cannot see the payment. A webhook delayed by thirty seconds
  // is not a failed payment, and saying so would be worse than saying nothing.
  const pending = RETURN_SRC.slice(RETURN_SRC.indexOf("// PENDING"));
  for (const word of ["sikertelen", "hiba", "failed", "error"]) {
    assert.equal(
      new RegExp(word, "i").test(pending.replace(/\/\/[^\n]*/g, "")),
      false,
      `the pending state must not say "${word}"`
    );
  }
  assert.match(pending, /nem kell újra\s*\n?\s*fizetned/);
});

test("the query parameter is stripped so a refresh cannot replay the return", () => {
  assert.match(RETURN_SRC, /searchParams\.delete\("purchase"\)/);
  assert.match(RETURN_SRC, /history\.replaceState/);
  // replaceState, not pushState: no extra history entry, so no back-button trap.
  assert.equal(/history\.pushState/.test(RETURN_SRC), false);
});

test("the panel renders nothing for an ordinary visitor", () => {
  // /play is on the normal path for every player. A return component that
  // fetched entitlement on every visit would put a Neon query on a page that
  // does not need one.
  assert.match(RETURN_SRC, /if \(!returning\) return null;/);
  const slot = RETURN_SRC.slice(RETURN_SRC.indexOf("export function PurchaseReturnSlot"));
  assert.equal(
    /fetch\(/.test(slot.slice(0, slot.indexOf("export default"))),
    false,
    "the slot must not fetch before it knows this is a return"
  );
});
