import { NextResponse, type NextRequest } from "next/server";
import {
  PLAYER_COOKIE,
  PLAYER_HEADER,
  identityConfigured,
  issuePlayerCookie,
  playerCookieOptions,
  verifyPlayerCookie,
} from "@/lib/playerIdentity";
import { siteUrlStatus } from "@/lib/env";

/**
 * V2.7.0.19 PRODUCTION FIX — canonical-host redirect for player-facing pages.
 *
 * ROOT CAUSE THIS CLOSES: a real Stripe purchase returned the browser to
 * `barkoba2-v2.vercel.app/play?purchase=return` instead of `barkobak.com` —
 * traced to a hardcoded (and stale) redirect target inside a THIRD-PARTY,
 * externally-hosted static page (DICS's own purchase-complete.html, outside
 * both this repo and the adapter's), not to anything in this codebase.
 * ACCOUNT_SESSION_COOKIE is deliberately host-only (see lib/accountSession.ts
 * — no Domain attribute), so a browser landing on that OTHER host cannot see
 * the session it holds for `barkobak.com` at all: it resolves as a fresh
 * guest, can play an unrelated anonymous game there, and the result screen
 * correctly (for THAT identity) offers registration — which is exactly what
 * was reported as "an already-registered player saw the newcomer CTA".
 *
 * The actual stale link cannot be fixed from this repository — it is not
 * Barkóba's code, and this session has no access to the repository that
 * publishes it. What CAN be fixed here, structurally, so this exact failure
 * mode cannot recur through this or any FUTURE stale external link: any
 * request for a player-facing page that arrives on one of this project's
 * OWN known-stable non-canonical Vercel hostnames is redirected, at the
 * edge, to the canonical host BEFORE any page content or identity check
 * ever runs. This is not "copy cookies across hosts" — that is not possible
 * and is not attempted; it is "never let a real player's browser sit on the
 * wrong host in the first place".
 *
 * DELIBERATELY NARROW: only the project's own STABLE aliases (the bare
 * `*.vercel.app` production alias and its `-zvz-x`/`-git-main-zvz-x`
 * siblings — see `vercel inspect`), never a wildcard `.vercel.app` match.
 * A per-deployment preview URL (a random hash in the hostname) must keep
 * working unredirected — that is how a specific build gets inspected/tested,
 * including throughout this session's own production diagnosis.
 *
 * NEVER applied to /api/*: redirecting a server-to-server POST (the DICS
 * adapter's own grant call, or any future webhook) risks the method or body
 * being silently dropped by a caller that does not replay it identically —
 * BARKOBA_BASE_URL is already configured correctly, so no legitimate
 * server-to-server call should ever hit a legacy host to begin with.
 */
const LEGACY_HOSTS = new Set([
  "barkoba2-v2.vercel.app",
  "barkoba2-v2-zvz-x.vercel.app",
  "barkoba2-v2-git-main-zvz-x.vercel.app",
]);

function canonicalHostRedirect(req: NextRequest): NextResponse | null {
  if (req.nextUrl.pathname.startsWith("/api/")) return null;
  if (!LEGACY_HOSTS.has(req.nextUrl.hostname)) return null;

  const { url: canonical } = siteUrlStatus();
  if (!canonical) return null;
  const canonicalHost = new URL(canonical).hostname;
  if (canonicalHost === req.nextUrl.hostname) return null;

  const target = new URL(req.nextUrl.pathname + req.nextUrl.search, canonical);
  return NextResponse.redirect(target);
}

/**
 * V2.1.1 — mint an anonymous Player identity on first contact.
 *
 * Runs on the Edge runtime, so it does no storage work at all: it verifies the
 * cookie, and issues a new signed one when there isn't a valid one. There is no
 * durable Player record to write.
 *
 * The matcher deliberately excludes the four content pages, which are
 * statically rendered today — running middleware over them would make them
 * per-request for no benefit. The front door and /compose are already dynamic,
 * so including them costs nothing. /play and /purchase were added in
 * V2.7.0.19 specifically so the canonical-host redirect above can run before
 * either page's own content is ever served — both now also receive the
 * ordinary guest-identity stamping below as a natural, harmless consequence.
 */
export const config = {
  matcher: [
    "/",
    "/compose",
    "/play",
    "/play/ai",
    // V2.3: both Human↔Human entry points need an identity on the request —
    // /join binds the Racer seat, /play/human records the Composer.
    "/play/human",
    "/join/:path*",
    "/game/:path*",
    // V2.7.0.19 — the purchase-return landing path; see canonicalHostRedirect.
    "/purchase",
    "/api/game/:path*",
    // 2.1.2.0: the name route needs the acting player on the request.
    "/api/player/:path*",
    // Module 1 account registration/login/logout/session routes need the same
    // stripped, server-issued guest header during registration and cutover.
    "/api/account/:path*",
    // V2.4: /intent needs the acting player. /grant does not — it resolves the
    // player from an opaque reference — but it is matched too so the inbound
    // x-bk-player strip applies uniformly across the whole namespace, and a
    // future route here cannot inherit an untrusted header by omission.
    "/api/entitlement/:path*",
  ],
};

export async function middleware(req: NextRequest) {
  const redirect = canonicalHostRedirect(req);
  if (redirect) return redirect;

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
