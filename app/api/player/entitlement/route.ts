import { NextRequest, NextResponse } from "next/server";
import { playerIdFromHeaders } from "@/lib/playerIdentity";
import { getStatus, isEntitlementEnabled } from "@/lib/entitlements";
import { playCreditCostForBudget, QUESTION_BUDGETS } from "@/lib/questionBudget";

// ---------------------------------------------------------------------------
// V2.4 — the player's own entitlement, and what a game costs.
//
// SESSION-SCOPED, ALWAYS. The player id comes from the trusted header that
// middleware sets after stripping any client-supplied copy. There is no
// parameter to name a different player, so this endpoint is structurally
// incapable of returning someone else's balance.
//
// No new computation lives here: getStatus() and playCreditCostForBudget()
// already exist and are the sole authorities. This is exposure, not logic.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const playerId = playerIdFromHeaders(req.headers);

  // The prices are the same for everyone and are not secret — the player is
  // about to be charged them. Sent even when entitlement is off, so the picker
  // can show what a tier would cost.
  const costs = Object.fromEntries(
    QUESTION_BUDGETS.map((b) => [b, playCreditCostForBudget(b)])
  );

  if (!isEntitlementEnabled()) {
    // Not enforcing: there is no balance to speak of, and the client must not
    // render an affordability warning against a gate that is not running.
    return NextResponse.json({ enforced: false, balance: null, costs });
  }

  if (!playerId) {
    return NextResponse.json(
      { error: "identity_unavailable", message: "Most nem érhető el a játékosazonosító." },
      { status: 409 }
    );
  }

  try {
    const status = await getStatus(playerId);
    return NextResponse.json({
      enforced: true,
      balance: status.balance,
      complimentary_granted: status.complimentary_granted,
      purchased: status.purchased,
      consumed: status.consumed,
      costs,
    });
  } catch (err) {
    // A balance we cannot read is not a balance of zero. Say so rather than
    // rendering a number that would be wrong.
    // eslint-disable-next-line no-console
    console.error("[barkoba] entitlement status read failed:", err);
    return NextResponse.json(
      { error: "entitlement_unavailable", message: "Most nem tudjuk lekérdezni a keretedet." },
      { status: 503 }
    );
  }
}
