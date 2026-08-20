import { NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import {
  ACCOUNT_SESSION_COOKIE,
  accountSessionCookieOptions,
  accountSessionTokenFromHeaders,
  revokeAccountSession,
} from "@/lib/accountSession";
import { PLAYER_COOKIE, PLAYER_NAME_COOKIE, playerCookieOptions } from "@/lib/playerIdentity";

export const dynamic = "force-dynamic";

/**
 * TASK 6H — explicit escape hatch for a browser whose bk_player already
 * belongs to a registered account it cannot log into (recovery code lost).
 *
 * Clears only this browser's identity/session cookies. Never touches
 * accounts.players, the ledger, or unlimited_play — the old account stays
 * exactly as it was and remains reachable by its recovery code from any
 * browser. Refuses to act unless the caller is in the specific stuck state
 * (registered player_id, no authenticated session), so this cannot be used
 * to silently end an active session or merge/replace anything.
 */
export async function POST(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "registered") {
    return NextResponse.json(
      {
        error: "not_applicable",
        message: "Ehhez a böngészőhöz nincs elérhetetlen regisztrált azonosító.",
      },
      { status: 409 }
    );
  }

  // Defensive only: this browser is not authenticated in the "registered"
  // state, but revoke and clear any account-session cookie it might carry.
  await revokeAccountSession(accountSessionTokenFromHeaders(req.headers));

  const secure = new URL(req.url).protocol === "https:";
  const expiredPlayer = { ...playerCookieOptions(secure), maxAge: 0 };
  const expiredSession = { ...accountSessionCookieOptions(secure), maxAge: 0 };

  const res = NextResponse.json({
    reset: true,
    message: "A régi fiók nem törlődik. Ez a böngésző új játékosként indul tovább.",
  });
  res.cookies.set(PLAYER_COOKIE, "", expiredPlayer);
  res.cookies.set(PLAYER_NAME_COOKIE, "", expiredPlayer);
  res.cookies.set(ACCOUNT_SESSION_COOKIE, "", expiredSession);
  return res;
}
