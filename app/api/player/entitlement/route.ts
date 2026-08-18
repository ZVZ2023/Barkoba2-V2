import { NextRequest, NextResponse } from "next/server";
import { playerIdFromHeaders } from "@/lib/playerIdentity";
import {
  entitlementStatus,
  getStatus,
  hasUnlimitedPlay,
  resolvePlayState,
} from "@/lib/entitlements";
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
  const runtime = entitlementStatus();

  // The prices are the same for everyone and are not secret — the player is
  // about to be charged them. Sent even when entitlement is off, so the picker
  // can show what a tier would cost.
  const costs = Object.fromEntries(
    QUESTION_BUDGETS.map((b) => [b, playCreditCostForBudget(b)])
  );

  if (!runtime.enforced) {
    // Not enforcing: there is no balance to speak of, and the client must not
    // render an affordability warning against a gate that is not running.
    // `unlimited` is false rather than true here on purpose — nobody is exempt
    // from a gate that is not running, and claiming otherwise would make the
    // badge assert a privilege the record does not contain.
    return NextResponse.json({
      enforced: false,
      unlimited: false,
      play_state: null,
      balance: null,
      costs,
    });
  }

  if (!playerId) {
    return NextResponse.json(
      { error: "identity_unavailable", message: "Most nem érhető el a játékosazonosító." },
      { status: 409 }
    );
  }

  try {
    // V2.6 — reported so the badge can say "unlimited" instead of the balance.
    //
    // Without this the two developer identities would read "RACES 0 —
    // elfogyott" while their games start perfectly, which looks like a defect
    // and would be re-reported as one. The balance is still returned, honestly:
    // an exempt player may also hold ordinary credits, and this endpoint's job
    // is to report what is true, not to hide it.
    const [status, unlimited] = await Promise.all([
      getStatus(playerId),
      hasUnlimitedPlay(playerId),
    ]);
    return NextResponse.json({
      enforced: true,
      unlimited,
      play_state: resolvePlayState({
        unlimited,
        balance: status.balance,
        complimentaryGrant: runtime.complimentaryGrant,
        initialComplimentaryGranted: status.initial_complimentary_granted,
      }),
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
      { error: "entitlement_unavailable", message: "Most nem tudjuk lekérdezni a RACES-egyenlegedet." },
      { status: 503 }
    );
  }
}
