import { NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { getPlayerAccount } from "@/lib/playerAccounts";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The logged-in player's own profile, for the account-screen read: display
 * name, current email and whether it's verified, and the current photo URL.
 * Never the recovery_key or the verification token/hash — this is a display
 * endpoint, not an export of the whole row.
 *
 * V2.9.2 — also returns the caller's own raw player_id. Before this, no
 * shipped surface let a logged-in player see their own player_id at all —
 * app/api/account/diagnostic/route.ts deliberately returns only a truncated
 * SHA-256 fingerprint, not the raw id (see that file's own header). That
 * was a genuine gap: ADMIN_PLAYER_IDS (lib/admin.ts) grants admin access by
 * exact raw player_id, and the operator had no self-service way to learn
 * their own account's id in order to be added to that allowlist. Returning
 * it here is safe: it is the player's OWN id, already sitting unencrypted
 * in their own browser's bk_player cookie and already treated throughout
 * this codebase as "a random number that reveals nothing on its own" (see
 * app/privacy/page.tsx's own cookie disclosure) — not a secret, not a
 * credential, and this is a read of one's own account, not another
 * player's. This does NOT loosen admin authorization in any way: it only
 * lets someone discover the value they would need to be added to
 * ADMIN_PLAYER_IDS by whoever controls that deployment's configuration —
 * isAdminPlayer() itself, and every route that calls it, is unchanged.
 */
export async function GET(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account") {
    return NextResponse.json(
      { error: "account_required" },
      { status: 401, headers: PRIVATE_NO_STORE }
    );
  }

  const account = await getPlayerAccount(context.playerId);
  if (!account) {
    return NextResponse.json(
      { error: "account_not_found" },
      { status: 404, headers: PRIVATE_NO_STORE }
    );
  }

  return NextResponse.json(
    {
      player_id: context.playerId,
      display_name: account.display_name,
      email: account.email,
      email_verified: account.email_verified_at !== null,
      photo_url: account.photo_url,
    },
    { headers: PRIVATE_NO_STORE }
  );
}
