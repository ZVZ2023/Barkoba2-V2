import { NextResponse, type NextRequest } from "next/server";
import {
  PLAYER_COOKIE,
  PLAYER_HEADER,
  identityConfigured,
  issuePlayerCookie,
  playerCookieOptions,
  verifyPlayerCookie,
} from "@/lib/playerIdentity";

/**
 * V2.1.1 — mint an anonymous Player identity on first contact.
 *
 * Runs on the Edge runtime, so it does no storage work at all: it verifies the
 * cookie, and issues a new signed one when there isn't a valid one. There is no
 * durable Player record to write.
 *
 * The matcher deliberately excludes the four content pages and /play, which are
 * statically rendered today — running middleware over them would make them
 * per-request for no benefit. The front door and /compose are already dynamic,
 * so including them costs nothing.
 */
export const config = {
  matcher: [
    "/",
    "/compose",
    "/play/ai",
    // V2.3: both Human↔Human entry points need an identity on the request —
    // /join binds the Racer seat, /play/human records the Composer.
    "/play/human",
    "/join/:path*",
    "/game/:path*",
    "/api/game/:path*",
    // 2.1.2.0: the name route needs the acting player on the request.
    "/api/player/:path*",
  ],
};

export async function middleware(req: NextRequest) {
  // Strip any client-supplied copy of the trusted header FIRST and
  // unconditionally. Everything downstream treats this header as vouched for by
  // middleware, so it must be impossible to send one in.
  const headers = new Headers(req.headers);
  headers.delete(PLAYER_HEADER);

  if (!identityConfigured()) {
    return NextResponse.next({ request: { headers } });
  }

  const existing = await verifyPlayerCookie(req.cookies.get(PLAYER_COOKIE)?.value);
  if (existing) {
    headers.set(PLAYER_HEADER, existing);
    return NextResponse.next({ request: { headers } });
  }

  // No cookie, or one we did not sign. Either way the visitor is new to us.
  // Forward the id inward as well as outward, so a handler reached on this very
  // first request already knows who is acting.
  const { playerId, value } = await issuePlayerCookie();
  headers.set(PLAYER_HEADER, playerId);

  const res = NextResponse.next({ request: { headers } });
  res.cookies.set(PLAYER_COOKIE, value, playerCookieOptions(req.nextUrl.protocol === "https:"));
  return res;
}
