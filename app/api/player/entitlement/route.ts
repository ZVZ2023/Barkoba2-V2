import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import {
  entitlementStatus,
  getStatus,
  hasUnlimitedPlay,
  resolvePlayState,
} from "@/lib/entitlements";
import { getPlayerAccount } from "@/lib/playerAccounts";
import { playCreditCostForBudget, QUESTION_BUDGETS } from "@/lib/questionBudget";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// V2.4 — the player's own entitlement, and what a game costs.
//
// REQUEST-AUTHORITY-SCOPED, ALWAYS. A guest id comes from middleware's trusted
// header; a registered player id comes only from the server-side session
// resolver. There is no parameter to name a different player, so this endpoint
// is structurally incapable of returning someone else's balance.
//
// No new computation lives here: getStatus() and playCreditCostForBudget()
// already exist and are the sole authorities. This is exposure, not logic.
//
// V2.7.x — WHICH complimentary pool is "the introductory one" now depends on
// identity, not a single flat constant. A guest's introductory grant is the
// pre-registration anonymous_first_game allowance; an account's is the
// post-verification initial_complimentary allowance, and only once its email
// is actually verified. Feeding resolvePlayState() the wrong pair of
// (amount, already-granted) for the caller's actual situation is exactly what
// made an already-played, not-yet-registered guest see "Az első VERSENYED
// vár rád" — a message about a grant that was not theirs to claim any more.
// resolvePlayState() itself is untouched; only which numbers reach it changed.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const context = await resolveActingPlayer(req.headers);
  const playerId = context.kind === "account" || context.kind === "guest" ? context.playerId : null;
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
    // Without this the two developer identities would read "VERSENY 0 —
    // elfogyott" while their games start perfectly, which looks like a defect
    // and would be re-reported as one. The balance is still returned, honestly:
    // an exempt player may also hold ordinary credits, and this endpoint's job
    // is to report what is true, not to hide it.
    const [status, unlimited, account] = await Promise.all([
      getStatus(playerId),
      hasUnlimitedPlay(playerId),
      // Only an account identity can be verified/unverified; a guest has no
      // accounts.players row at all, so this stays skippable for the common
      // case and costs nothing extra there.
      context.kind === "account" ? getPlayerAccount(playerId) : Promise.resolve(null),
    ]);

    // The introductory pool THIS caller could actually still claim, and
    // whether they already have. An unverified account's pool is currently
    // worth 0 — not ineligible forever, just not available yet — which
    // resolvePlayState's existing complimentaryGrant > 0 check already
    // handles without needing to know why.
    const { complimentaryGrant, initialComplimentaryGranted } =
      context.kind === "account"
        ? {
            complimentaryGrant: account?.email_verified_at != null ? runtime.complimentaryGrant : 0,
            initialComplimentaryGranted: status.initial_complimentary_granted,
          }
        : {
            complimentaryGrant: env.entitlementAnonymousGrant(),
            initialComplimentaryGranted: status.anonymous_complimentary_granted,
          };

    return NextResponse.json({
      enforced: true,
      unlimited,
      play_state: resolvePlayState({
        unlimited,
        balance: status.balance,
        complimentaryGrant,
        initialComplimentaryGranted,
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
      { error: "entitlement_unavailable", message: "Most nem tudjuk lekérdezni a VERSENY-egyenlegedet." },
      { status: 503 }
    );
  }
}
