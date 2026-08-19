import { NextResponse } from "next/server";
import {
  ACCOUNT_SESSION_COOKIE,
  accountSessionCookieOptions,
  createAccountSession,
} from "@/lib/accountSession";
import { getPlayerAccountByRecoveryKey, migrateLegacyPlayer } from "@/lib/playerAccounts";
import {
  PLAYER_COOKIE,
  PLAYER_NAME_COOKIE,
  issuePlayerCookie,
  issuePlayerNameCookie,
  playerCookieOptions,
  playerIdFromHeaders,
} from "@/lib/playerIdentity";
import { recoverPlayer } from "@/lib/playerStore";
import { looksLikeRecoveryCode, recoveryKey } from "@/lib/recoveryCode";
import { checkRecoveryRateLimit, extractClientIp } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const limit = await checkRecoveryRateLimit(extractClientIp(req.headers));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Túl sok próbálkozás. Próbáld újra később." },
      { status: 429 }
    );
  }

  let body: { code?: string } = {};
  try {
    body = (await req.json()) as { code?: string };
  } catch {
    body = {};
  }

  const raw = body.code ?? "";
  const wrong = NextResponse.json(
    { error: "not_authenticated", message: "Ez a kód nem érvényes." },
    { status: 404 }
  );
  if (!looksLikeRecoveryCode(raw)) return wrong;

  try {
    const hash = await recoveryKey(raw);
    // Always perform both lookups. Apart from returning the same body/status,
    // this keeps the common valid/invalid paths from exposing whether a code
    // exists in Neon through one obvious storage-timing branch.
    let [account, legacy] = await Promise.all([
      getPlayerAccountByRecoveryKey(hash),
      recoverPlayer(raw),
    ]);
    if (!account) {
      if (!legacy) return wrong;
      account = await migrateLegacyPlayer(legacy);
    }

    const token = await createAccountSession(account.player_id);
    const secure = new URL(req.url).protocol === "https:";
    const res = NextResponse.json({ authenticated: true, display_name: account.display_name });
    res.cookies.set(ACCOUNT_SESSION_COOKIE, token, accountSessionCookieOptions(secure));

    // Preserve an unrelated local guest without merging it. Only rotate when
    // this browser still carries the account's old pre-session device cookie.
    if (playerIdFromHeaders(req.headers) === account.player_id) {
      const freshGuest = await issuePlayerCookie();
      res.cookies.set(PLAYER_COOKIE, freshGuest.value, playerCookieOptions(secure));
    }
    res.cookies.set(
      PLAYER_NAME_COOKIE,
      await issuePlayerNameCookie(account.player_id, account.display_name ?? ""),
      playerCookieOptions(secure)
    );
    return res;
  } catch (err) {
    // Storage failures are not reported as invalid credentials: that would
    // invite a player to discard a perfectly valid recovery code.
    // eslint-disable-next-line no-console
    console.error("[barkoba] account login failed:", err);
    return NextResponse.json(
      { error: "login_unavailable", message: "A bejelentkezés most nem érhető el." },
      { status: 503 }
    );
  }
}
