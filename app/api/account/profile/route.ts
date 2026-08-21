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
      display_name: account.display_name,
      email: account.email,
      email_verified: account.email_verified_at !== null,
      photo_url: account.photo_url,
    },
    { headers: PRIVATE_NO_STORE }
  );
}
