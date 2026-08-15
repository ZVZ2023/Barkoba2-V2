import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { grantPurchase } from "@/lib/entitlements";
import { consumePurchaseRef, resolvePurchaseRef } from "@/lib/purchaseRef";

// ---------------------------------------------------------------------------
// V2.4 — the grant endpoint. Step three of the adapter contract, and the ONLY
// way Play Credits enter the ledger from outside the process.
//
// SERVER TO SERVER ONLY. It requires ENTITLEMENT_GRANT_SECRET, which no
// client-facing code path holds and no browser can obtain. A session cookie is
// deliberately NOT sufficient: if it were, a player could self-grant, which is
// the one thing an entitlement system must never permit.
//
// THE WHOLE CONTRACT, and nothing more:
//
//   purchase_ref       who   — opaque, short-lived, minted by Barkóba
//   external_order_id  which — the adapter's order, and the idempotency key
//   credits            how many
//   the shared secret  proof the caller is the adapter
//
// Barkóba learns nothing about money. The adapter learns nothing about identity
// beyond a token that expires. Swapping the commercial provider means pointing
// a different adapter at these same three fields — which is what keeps Digital
// Ice Cream replaceable rather than load-bearing.
//
// PRICE -> CREDITS IS THE ADAPTER'S DECISION. `credits` arrives as an integer
// and is not second-guessed here; Barkóba holds no pricing logic in this pass.
//
// ---------------------------------------------------------------------------
// RETRY IS A FIRST-CLASS CASE, NOT AN ERROR
//
// A callback that is delivered twice is normal operation, not misuse: the
// adapter cannot tell a lost response from a failed call, so it retries. The
// endpoint must therefore answer the identical call the same way every time.
//
//   fresh reference                 -> grant, 200 granted
//   same reference, SAME order      -> 200 duplicate, nothing granted
//   same reference, ANOTHER order   -> 404, nothing granted
//   unknown or expired reference    -> 404, nothing granted
//
// The last two are answered with a byte-identical body on purpose. Splitting
// them would turn this endpoint into an oracle for which references are live —
// a caller could probe order ids against a reference and learn from the
// response shape which one spent it.
//
// Note what does NOT vary: none of the four outcomes depends on whether a Redis
// write succeeded. The first version made the response contingent on a
// best-effort delete, so an identical retry returned 404 or 200 depending on an
// unrelated infrastructure outcome. Marking-on-use replaces that with a
// decision made from state the caller supplied.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

interface GrantBody {
  purchase_ref?: string;
  external_order_id?: string;
  credits?: number;
}

/** Length-independent comparison, matching lib/playerIdentity.ts. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized() {
  // Deliberately uninformative: a caller without the secret learns only that it
  // was rejected, never whether the reference or the order id was valid.
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * The single refusal for every reference that cannot authorise this grant.
 *
 * ONE function on purpose. "Unknown", "expired" and "already spent by a
 * different order" are three different facts and must produce one indivisible
 * response — if they diverge, even in status code or message wording, the
 * caller can enumerate which references exist and what spent them.
 */
function invalidPurchaseRef() {
  return NextResponse.json(
    { error: "invalid_purchase_ref", message: "Unknown, expired or already-used reference." },
    { status: 404 }
  );
}

export async function POST(req: NextRequest) {
  const configured = env.entitlementGrantSecret();
  if (!configured) {
    // No secret set means the endpoint is not in service. It must never fall
    // open — an unconfigured grant endpoint that accepts anything would be
    // strictly worse than one that does not exist.
    // eslint-disable-next-line no-console
    console.error("[barkoba] /api/entitlement/grant called but ENTITLEMENT_GRANT_SECRET is unset");
    return unauthorized();
  }

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented || !constantTimeEqual(presented, configured)) return unauthorized();

  let body: GrantBody;
  try {
    body = (await req.json()) as GrantBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const purchaseRef = (body.purchase_ref || "").trim();
  const externalOrderId = (body.external_order_id || "").trim();
  const credits = body.credits;

  if (!purchaseRef || !externalOrderId) {
    return NextResponse.json(
      { error: "missing_fields", message: "purchase_ref and external_order_id are required." },
      { status: 400 }
    );
  }
  if (typeof credits !== "number" || !Number.isInteger(credits) || credits <= 0) {
    return NextResponse.json(
      { error: "invalid_credits", message: "credits must be a positive integer." },
      { status: 400 }
    );
  }

  const ref = await resolvePurchaseRef(purchaseRef);
  if (!ref) return invalidPurchaseRef();

  // Spent by someone else's order. Refused with the same body as an unknown
  // reference, and — this is the part that matters — refused BEFORE any grant
  // is attempted, so a reference can never fund two orders.
  if (ref.consumedBy !== null && ref.consumedBy !== externalOrderId) {
    // eslint-disable-next-line no-console
    console.warn(
      `[barkoba] purchase_ref reuse refused: reference already spent by a different order (${externalOrderId})`
    );
    return invalidPurchaseRef();
  }

  // Past this point the reference is either fresh or being presented again by
  // the order that already spent it. BOTH continue into the grant: a retry is
  // not short-circuited here, because the authoritative "already recorded"
  // answer comes from the ledger's unique grant_key rather than from this key.
  // Redis says which retry this is; the ledger says whether it counted.
  const playerId = ref.playerId;

  let result;
  try {
    // external_order_id becomes grant_key, so the ledger's existing
    // UNIQUE (player_id, grant_key) WHERE grant_key IS NOT NULL makes a
    // replayed callback a no-op at the database level. No migration, and the
    // guarantee survives any application-level mistake.
    result = await grantPurchase(playerId, credits, {
      grantKey: externalOrderId,
      note: "digital ice cream purchase",
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] purchase grant failed for order ${externalOrderId}:`, err);
    return NextResponse.json(
      { error: "grant_failed", message: "Could not record the grant. Safe to retry." },
      { status: 503 }
    );
  }

  // Under Option C the player was already claimed before the reference existed,
  // so this branch should be unreachable on this path. If it fires, the
  // sequencing guarantee has been broken somewhere and that is worth a loud
  // line rather than a silent success.
  if (result.recoveryCode) {
    // eslint-disable-next-line no-console
    console.error(
      "[barkoba] SEQUENCING DEFECT: purchase grant silently claimed a player. " +
        "Under claim-before-purchase this should be impossible — a purchase_ref " +
        "was minted for an unclaimed player."
    );
  }

  // Mark the reference spent by THIS order and restart its retention clock, so
  // a later delivery of the same callback is recognisable rather than merely
  // survivable.
  //
  // Non-fatal on failure, and deliberately so: the grant already happened, and
  // reporting an error for work that succeeded is the exact failure this pass
  // exists to remove. A failed mark leaves the reference fresh until its own
  // 30-minute TTL expires — a retry of THIS order still answers duplicate via
  // grant_key, so the contract holds; only the narrower "cannot be turned on a
  // different order" property degrades, which is why it is logged loudly.
  try {
    await consumePurchaseRef(purchaseRef, externalOrderId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[barkoba] granted order ${externalOrderId} but could not mark its purchase_ref spent:`,
      err
    );
  }

  return NextResponse.json({
    granted: result.granted,
    // false on a replay: the order was already recorded, which is success from
    // the adapter's point of view and must not trigger a retry storm.
    duplicate: !result.granted,
    external_order_id: externalOrderId,
  });
}
