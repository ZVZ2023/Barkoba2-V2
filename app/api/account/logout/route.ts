import { NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import {
  ACCOUNT_SESSION_COOKIE,
  accountSessionCookieOptions,
  accountSessionTokenFromHeaders,
  revokeAccountSession,
} from "@/lib/accountSession";
import {
  PLAYER_COOKIE,
  issuePlayerCookie,
  playerCookieOptions,
  playerIdFromHeaders,
} from "@/lib/playerIdentity";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  const token = accountSessionTokenFromHeaders(req.headers);
  try {
    await revokeAccountSession(token);
  } catch (err) {
    // Fail closed: do not claim logout succeeded while the bearer session is
    // still valid server-side.
    // eslint-disable-next-line no-console
    console.error("[barkoba] account logout failed:", err);
    return NextResponse.json(
      { error: "logout_unavailable", message: "A kijelentkezés most nem sikerült." },
      { status: 503 }
    );
  }

  const secure = new URL(req.url).protocol === "https:";
  const expired = { ...accountSessionCookieOptions(secure), maxAge: 0 };
  const res = NextResponse.json({ authenticated: false });
  res.cookies.set(ACCOUNT_SESSION_COOKIE, "", expired);

  // Defensive compatibility for a browser carrying the old account id as its
  // guest cookie. A normal post-registration browser already has a distinct
  // guest id and keeps it, so no unrelated guest is merged or discarded.
  if (
    context.kind === "account" &&
    playerIdFromHeaders(req.headers) === context.playerId
  ) {
    const freshGuest = await issuePlayerCookie();
    res.cookies.set(PLAYER_COOKIE, freshGuest.value, playerCookieOptions(secure));
  }
  return res;
}
