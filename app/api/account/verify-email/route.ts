import { NextResponse } from "next/server";
import {
  getPlayerAccountByVerificationTokenHash,
  markEmailVerified,
  type PlayerAccount,
} from "@/lib/playerAccounts";
import { verificationTokenHash } from "@/lib/emailVerification";
import { ensureInitialComplimentary } from "@/lib/entitlements";
import {
  ACCOUNT_SESSION_COOKIE,
  accountSessionCookieOptions,
  createAccountSession,
} from "@/lib/accountSession";
import {
  PLAYER_COOKIE,
  PLAYER_NAME_COOKIE,
  issuePlayerCookie,
  issuePlayerNameCookie,
  playerCookieOptions,
  playerIdFromHeaders,
} from "@/lib/playerIdentity";

export const dynamic = "force-dynamic";

/**
 * V2.6.x — the receiving end of the verification link.
 *
 * Deliberately takes the token from the URL/body only, not from a session:
 * the player who clicks this link may be on a different device or browser
 * than the one that registered, and the link itself is the credential.
 *
 * "Invalid" (never existed, or already superseded) and "expired" (existed,
 * past its TTL) are answered differently on purpose — unlike the purchase-ref
 * endpoint, there is no money at stake here and telling a player their link
 * specifically expired, so they know to ask for a new one, is materially
 * better UX than one generic refusal.
 *
 * V2.7.x — SPLIT INTO A READ-ONLY GET AND A MUTATING POST, deliberately.
 * A previous version verified on the FIRST GET — which meant page LOAD was
 * the mutating action. That is a known real-world failure mode: email
 * security scanners and link-prefetch systems fetch a link's URL
 * automatically, and would become the first "caller" before any human ever
 * saw the page. GET remains a pure status check — zero database writes, safe
 * to call any number of times. POST is the only path that verifies an email,
 * and it fires exclusively from an explicit button click in
 * app/verify-email/VerifyEmailClient.tsx — never from an effect, a mount, a
 * preload, or navigation. This split is unrelated to, and predates, the
 * paragraph below; it stays exactly as it was.
 *
 * V2.7.x M2 — NO RECOVERY CODE IS GENERATED OR SHOWN HERE ANY MORE. An
 * earlier version rotated in a fresh recovery code on first verification and
 * displayed it as a "save this now" step, on the reasoning that ClaimPrompt
 * no longer showed the one generated at registration. Production testing
 * confirmed this reintroduced exactly the friction ClaimPrompt's own fix was
 * for: a required stop between "verified" and "playing". Verification now
 * calls the plain, already-idempotent markEmailVerified() and nothing else —
 * no rotation, no code, no interruption. Recovery capability is NOT gone: it
 * lives, unchanged, on the authenticated Profil surface (ClaimPrompt's
 * "protected" branch → "Új helyreállító kód generálása", POST
 * /api/account/rotate-recovery-code) as an opt-in action a player can take
 * any time, on their own initiative — exactly where a backup credential
 * belongs, not a mandatory step in the newcomer path.
 *
 * V2.7.0.3 HUMAN-TEST FIX — THE +5 GRANT IS NOW EAGER, NOT ONLY LAZY.
 * ensureInitialComplimentary() has always existed to run at game-creation
 * (app/api/game/create/route.ts) — a deliberately lazy design, so no ledger
 * row exists until a grant is actually about to be spent. That is fine for
 * an ALREADY-established player topping up, but for a newcomer it meant a
 * real, if narrow, window between "verification succeeded" (this response)
 * and "the +5 actually exists in the ledger" (only at the next game-create
 * call) — and the success screen's own "Megkaptad az 5 további VERSENYT"
 * is written in the past tense, promising something the ledger did not yet
 * contain. Calling ensureInitialComplimentary() HERE, synchronously, before
 * this response returns, closes that window: the grant is real by the time
 * the player can possibly navigate anywhere. The game-create call site is
 * UNCHANGED and still calls it too — grantComplimentary's grant_key
 * idempotency (accounts.entitlement_ledger's UNIQUE (player_id, grant_key))
 * makes a second call from there a guaranteed no-op, not a second grant, so
 * this is a genuine belt-and-braces fallback, not a duplicated risk.
 *
 * V2.7.0.4 PRODUCTION-TEST FIX — POST NOW ESTABLISHES THE ACCOUNT SESSION,
 * NOT JUST THE LEDGER. Every version until now assumed the browser doing
 * the verifying was the SAME one that registered — which already holds
 * ACCOUNT_SESSION_COOKIE from registration, so authentication "just
 * worked" without this route ever touching a cookie. Cross-browser/cross-
 * device verification (open the email on a different browser or a
 * different device than registration — the exact case a device-bound
 * guest cookie can never survive) broke that assumption: the verifying
 * browser had no session, verification correctly updated the account, and
 * the player landed back on an unauthenticated homepage despite having
 * just done everything right. The token IS the credential here (same
 * reasoning the file's original header already states) — successful
 * verification is exactly as strong a proof of account ownership as a
 * recovery code, so POST now issues a session the SAME way
 * app/api/account/recovery-confirm/route.ts and app/api/account/login/route.ts
 * already do: createAccountSession() + ACCOUNT_SESSION_COOKIE, rotating
 * bk_player ONLY if it currently already names this SAME player_id (never
 * merging an unrelated guest's identity/history/credits into the verified
 * account), refreshing bk_player_name. Issued on BOTH the fresh-
 * verification and the already-verified paths — a repeat click, from any
 * browser, is a safe way to (re-)authenticate, never a way to grant twice
 * or create a second identity.
 */

/**
 * Reused by both success branches below (fresh and already-verified) — the
 * exact session-issuance sequence recovery-confirm and login already use.
 * Not a new auth mechanism: the same three cookies, the same conditional
 * bk_player rotation, called from a third place instead of duplicated.
 */
async function respondAuthenticated(
  req: Request,
  playerId: string,
  displayName: string | null,
  body: Record<string, unknown>
): Promise<NextResponse> {
  const sessionToken = await createAccountSession(playerId);
  const secure = new URL(req.url).protocol === "https:";
  const res = NextResponse.json(body);
  res.cookies.set(ACCOUNT_SESSION_COOKIE, sessionToken, accountSessionCookieOptions(secure));

  // Preserve an unrelated local guest without merging it. Only rotate when
  // this browser still carries the account's OWN pre-session device
  // cookie — identical logic to POST /api/account/login and
  // POST /api/account/recovery-confirm.
  if (playerIdFromHeaders(req.headers) === playerId) {
    const freshGuest = await issuePlayerCookie();
    res.cookies.set(PLAYER_COOKIE, freshGuest.value, playerCookieOptions(secure));
  }
  res.cookies.set(
    PLAYER_NAME_COOKIE,
    await issuePlayerNameCookie(playerId, displayName ?? ""),
    playerCookieOptions(secure)
  );
  return res;
}

type ResolveResult =
  | { ok: true; account: PlayerAccount }
  | { ok: false; status: number; error: string; message: string };

/** Shared, read-only token lookup. Never writes. */
async function resolveByToken(token: string): Promise<ResolveResult> {
  if (!token) {
    return { ok: false, status: 400, error: "missing_token", message: "Hiányzik a megerősítő kód." };
  }
  const hash = await verificationTokenHash(token);
  const account = await getPlayerAccountByVerificationTokenHash(hash);
  if (!account) {
    return {
      ok: false,
      status: 404,
      error: "invalid_token",
      message: "Ez a megerősítő link érvénytelen.",
    };
  }
  return { ok: true, account };
}

/**
 * READ-ONLY. Reports what the token currently means, without touching the
 * database: "pending" (valid, not yet verified — the page shows the button),
 * "already_verified" (nothing left to do), or the existing invalid/expired
 * failure shapes. Only ever SELECTs, via getPlayerAccountByVerificationTokenHash.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";

  try {
    const resolved = await resolveByToken(token);
    if (!resolved.ok) {
      return NextResponse.json(
        { status: "invalid", message: resolved.message },
        { status: resolved.status }
      );
    }
    const { account } = resolved;

    // Checked BEFORE expiry, same reasoning as the POST path below: once
    // verified, the token's TTL no longer matters for STATUS purposes either
    // — a status check against a link that verified a week ago must read as
    // "already verified", never "expired".
    if (account.email_verified_at !== null) {
      return NextResponse.json({ status: "already_verified", email: account.email });
    }

    if (
      account.email_verification_expires_at &&
      Date.parse(account.email_verification_expires_at) <= Date.now()
    ) {
      return NextResponse.json(
        { status: "expired", message: "Ez a megerősítő link lejárt." },
        { status: 410 }
      );
    }

    return NextResponse.json({ status: "pending", email: account.email });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] email verification status check failed:", err);
    return NextResponse.json(
      { status: "invalid", message: "A megerősítés most nem sikerült." },
      { status: 503 }
    );
  }
}

/**
 * MUTATING. The only path that verifies an email — fires exclusively from an
 * explicit "Fiókom megerősítése" click, per VerifyEmailClient.tsx.
 *
 * Re-validates everything from scratch (does not trust a prior GET) since a
 * POST can in principle arrive without one ever having happened.
 * markEmailVerified() is idempotent by construction (COALESCE preserves the
 * first timestamp), so a repeat/racing POST is a harmless no-op — it simply
 * reports already_verified:true, same as a genuine repeat visit.
 */
export async function POST(req: Request) {
  let body: { token?: unknown } = {};
  try {
    body = (await req.json()) as { token?: unknown };
  } catch {
    body = {};
  }
  const token = typeof body.token === "string" ? body.token : "";

  try {
    const resolved = await resolveByToken(token);
    if (!resolved.ok) {
      return NextResponse.json(
        { verified: false, error: resolved.error, message: resolved.message },
        { status: resolved.status }
      );
    }
    const { account } = resolved;

    if (account.email_verified_at !== null) {
      // Already verified by an earlier request — still authenticates THIS
      // browser. A repeat click, from any device, is a safe way to log in;
      // it must never re-grant or create a second identity, and it does
      // not: no ledger call happens on this branch at all.
      return respondAuthenticated(req, account.player_id, account.display_name, {
        verified: true,
        already_verified: true,
        email: account.email,
      });
    }

    if (
      account.email_verification_expires_at &&
      Date.parse(account.email_verification_expires_at) <= Date.now()
    ) {
      return NextResponse.json(
        { verified: false, error: "expired_token", message: "Ez a megerősítő link lejárt." },
        { status: 410 }
      );
    }

    await markEmailVerified(account.player_id);
    // NEVER THROWS (see ensureInitialComplimentary's own contract) — a
    // failure here is logged there and falls back to the existing lazy
    // grant at next game-creation; it must not turn a real verification
    // into a reported failure.
    await ensureInitialComplimentary(account.player_id);

    return respondAuthenticated(req, account.player_id, account.display_name, {
      verified: true,
      already_verified: false,
      email: account.email,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] email verification failed:", err);
    return NextResponse.json(
      { verified: false, error: "verification_failed", message: "A megerősítés most nem sikerült." },
      { status: 503 }
    );
  }
}
