import { NextResponse } from "next/server";
import {
  ACCOUNT_SESSION_COOKIE,
  accountSessionCookieOptions,
  createAccountSession,
} from "@/lib/accountSession";
import { getPlayerAccount } from "@/lib/playerAccounts";
import { consumeAccountRecoveryToken, peekAccountRecoveryToken } from "@/lib/accountRecovery";
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
 * V2.7.x — the receiving end of the emailed account-recovery link.
 *
 * SAME SCANNER-SAFE SPLIT AS app/api/account/verify-email/route.ts, for the
 * same reason: GET must never be the action a security scanner or link-
 * prefetcher can trigger on a human's behalf. GET here is even more
 * sensitive than verify-email's ever was — this one issues a LOGIN session,
 * not merely a status flag — so the split is not optional here.
 *
 * GET — read-only. peekAccountRecoveryToken() only reads Redis; it deletes
 * nothing. Safe to call any number of times.
 *
 * POST — the only path that may consume the token and issue a session. Fires
 * exclusively from an explicit button click in
 * app/recover-account/RecoverAccountClient.tsx.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.json({ status: "invalid" }, { status: 400 });
  }
  try {
    const playerId = await peekAccountRecoveryToken(token);
    return NextResponse.json({ status: playerId ? "pending" : "invalid" }, { status: playerId ? 200 : 404 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] account recovery status check failed:", err);
    return NextResponse.json({ status: "invalid" }, { status: 503 });
  }
}

/**
 * MUTATING. Consumes the token exactly once (consumeAccountRecoveryToken
 * deletes on read — see that function's own comment for why a second call
 * for the same raw token always returns null) and, only on success, issues a
 * session for the EXISTING account via the SAME sequence
 * POST /api/account/login already uses: createAccountSession() +
 * ACCOUNT_SESSION_COOKIE, rotating bk_player only if this browser still
 * carries the account's OWN pre-session device cookie (never merging an
 * unrelated guest), and refreshing the display-name cookie. Nothing here
 * touches recovery_key, the ledger, entitlements, or verification status —
 * this restores a session onto an unchanged account, nothing else.
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
    const playerId = await consumeAccountRecoveryToken(token);
    if (!playerId) {
      return NextResponse.json(
        { recovered: false, error: "invalid_token", message: "Ez a link érvénytelen vagy már felhasznált." },
        { status: 404 }
      );
    }

    // Defensive re-check: a token is only ever ISSUED for a verified
    // account, but the token's own 30-minute lifetime is long enough that
    // re-confirming costs nothing and matches this codebase's general
    // posture of not trusting stale state across a mutation boundary.
    const account = await getPlayerAccount(playerId);
    if (!account || account.email_verified_at === null) {
      return NextResponse.json(
        { recovered: false, error: "invalid_token", message: "Ez a link érvénytelen vagy már felhasznált." },
        { status: 404 }
      );
    }

    const sessionToken = await createAccountSession(playerId);
    const secure = new URL(req.url).protocol === "https:";
    const res = NextResponse.json({ recovered: true, display_name: account.display_name });
    res.cookies.set(ACCOUNT_SESSION_COOKIE, sessionToken, accountSessionCookieOptions(secure));

    // Preserve an unrelated local guest without merging it. Only rotate when
    // this browser still carries the account's old pre-session device
    // cookie — identical logic to POST /api/account/login.
    if (playerIdFromHeaders(req.headers) === playerId) {
      const freshGuest = await issuePlayerCookie();
      res.cookies.set(PLAYER_COOKIE, freshGuest.value, playerCookieOptions(secure));
    }
    res.cookies.set(
      PLAYER_NAME_COOKIE,
      await issuePlayerNameCookie(playerId, account.display_name ?? ""),
      playerCookieOptions(secure)
    );
    return res;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] account recovery confirm failed:", err);
    return NextResponse.json(
      { recovered: false, error: "recovery_failed", message: "A visszaállítás most nem sikerült." },
      { status: 503 }
    );
  }
}
