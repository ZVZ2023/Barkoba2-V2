import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import {
  ACCOUNT_SESSION_COOKIE,
  accountSessionCookieOptions,
  createAccountSession,
} from "@/lib/accountSession";
import { registerPlayerAccount } from "@/lib/playerAccounts";
import {
  PLAYER_COOKIE,
  PLAYER_NAME_COOKIE,
  issuePlayerCookie,
  playerCookieOptions,
  readPlayerName,
} from "@/lib/playerIdentity";
import { generateRecoveryCode, recoveryKey } from "@/lib/recoveryCode";

export const dynamic = "force-dynamic";

function unavailable() {
  return NextResponse.json(
    { error: "identity_unavailable", message: "Most nem érhető el a játékosazonosító." },
    { status: 409 }
  );
}

export async function GET(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  return NextResponse.json({
    authenticated: context.kind === "account",
    registered: context.kind === "account" || context.kind === "registered",
  });
}

export async function POST(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  if (context.kind === "account") {
    return NextResponse.json({ registered: true, authenticated: true });
  }
  if (context.kind === "registered") {
    return NextResponse.json(
      {
        error: "login_required",
        registered: true,
        authenticated: false,
        message: "Ez a játékos már regisztrált. Jelentkezz be a kódoddal.",
      },
      { status: 409 }
    );
  }
  if (context.kind !== "guest") return unavailable();

  const playerId = context.playerId;
  let recoveryCode: string | undefined;

  try {
    const jar = cookies();
    const nameState = await readPlayerName(playerId, jar.get(PLAYER_NAME_COOKIE)?.value);
    recoveryCode = generateRecoveryCode();
    await registerPlayerAccount({
      playerId,
      recoveryKey: await recoveryKey(recoveryCode),
      displayName: nameState.name,
    });

    const secure = new URL(req.url).protocol === "https:";
    let sessionToken: string;
    try {
      sessionToken = await createAccountSession(playerId);
    } catch (err) {
      // The account and recovery credential already exist. Return the only raw
      // copy even if session creation failed so registration cannot orphan it.
      // eslint-disable-next-line no-console
      console.error("[barkoba] account registered but session creation failed:", err);
      return NextResponse.json(
        {
          error: "session_unavailable",
          registered: true,
          authenticated: false,
          ...(recoveryCode ? { recovery_code: recoveryCode } : {}),
          message: "A fiók elkészült. Mentsd el a kódot, majd próbálj bejelentkezni.",
        },
        { status: 503 }
      );
    }

    const res = NextResponse.json({
      registered: true,
      authenticated: true,
      ...(recoveryCode ? { recovery_code: recoveryCode } : {}),
    });
    res.cookies.set(
      ACCOUNT_SESSION_COOKIE,
      sessionToken,
      accountSessionCookieOptions(secure)
    );

    // bk_player remains a guest-continuity cookie, never the account session.
    // Rotate it away from the newly registered id so logout cannot fall back
    // into device authority for that account.
    const freshGuest = await issuePlayerCookie();
    res.cookies.set(PLAYER_COOKIE, freshGuest.value, playerCookieOptions(secure));
    return res;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] account registration failed:", err);
    return NextResponse.json(
      { error: "registration_failed", message: "A regisztráció most nem sikerült." },
      { status: 503 }
    );
  }
}
