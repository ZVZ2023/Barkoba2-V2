// ---------------------------------------------------------------------------
// V2.6 — PLAY CREDIT PACKAGES. The commercial catalogue, server-side.
//
// WHAT THIS EXISTS TO PREVENT.
//
// Until now /api/entitlement/grant took `credits` as an integer and did not
// second-guess it: price-to-credits was declared to be the adapter's decision.
// That was defensible while no adapter existed. It stops being defensible the
// moment a real storefront and a real payment provider are on the other end,
// because it means a compromised, buggy or merely misconfigured stand can mint
// any quantity of Play Credits it likes, and Barkóba would record the result
// as a legitimate purchase.
//
// So the caller now names a PACKAGE and Barkóba decides what it is worth.
//
// THE MAPPING LIVES IN CODE, NOT IN THE ENVIRONMENT, and that is deliberate —
// it is the same rule lib/questionBudget.ts already applies to
// PLAY_CREDIT_COST, for the same reason stated there: keeping it out of the
// environment means no deployment setting, and therefore no caller, can state
// what something is worth. A price in an env var is a price someone can change
// without a code review.
//
// WHAT A PACKAGE IS NOT: a cash price. There is no money in this file and
// there never should be. The stand decides what a package costs a human; this
// decides what it is worth in Play Credits. Those are different questions with
// different owners, and conflating them is how Barkóba would end up holding
// pricing logic it deliberately does not have.
// ---------------------------------------------------------------------------

/**
 * The canonical catalogue. Adding an entry is a commercial decision and a code
 * review; there is no other way to introduce one.
 *
 * These are ECONOMIC CLASSES, not storefront products. Every ordinary flavour
 * maps to dics_scoop; flavour stays in the attested provenance envelope only.
 * dics_custom receives an economic step count from the signature-verifying
 * payment adapter. Cash amounts never cross into this calculation.
 */
export const PLAY_CREDIT_PACKAGES = Object.freeze({
  dics_scoop: "scoop",
  dics_custom: "custom",
});

export type PlayCreditPackageId = keyof typeof PLAY_CREDIT_PACKAGES;

/**
 * How many Play Credits a package is worth, or null if it is not one of ours.
 *
 * OWN-PROPERTY CHECK, NOT A TRUTHINESS CHECK. `PLAY_CREDIT_PACKAGES[id]` walks
 * the prototype chain, so a request body of `{"package_id":"constructor"}`
 * would resolve to a function — truthy, and therefore treated as a package.
 * This id arrives from an HTTP body across a trust boundary, so the cheap
 * guard is the correct one. Same reasoning as getAdapter() in
 * lib/providers/index.ts, which had the identical exposure.
 */
export function creditsForPackage(packageId: unknown, quantity: unknown): number | null {
  if (typeof packageId !== "string" || packageId.length === 0) return null;
  if (!Object.prototype.hasOwnProperty.call(PLAY_CREDIT_PACKAGES, packageId)) return null;
  if (!Number.isSafeInteger(quantity) || Number(quantity) <= 0) return null;

  const q = Number(quantity);
  let credits: number;
  if (packageId === "dics_scoop") {
    // DICS permits exactly 1–3 scoops. The reward is deliberately non-linear.
    credits = ({ 1: 5, 2: 15, 3: 30 } as Record<number, number>)[q] ?? 0;
  } else if (packageId === "dics_custom") {
    // q=1 is the €25 base class. Each further economic step represents one
    // completed additional €10, classified by the payment-side adapter.
    credits = 100 + 50 * (q - 1);
  } else {
    return null;
  }

  return Number.isSafeInteger(credits) && credits > 0 ? credits : null;
}

/** Every package id Barkóba will honour. Sorted, so diagnostics are stable. */
export function knownPackageIds(): string[] {
  return Object.keys(PLAY_CREDIT_PACKAGES).sort();
}
