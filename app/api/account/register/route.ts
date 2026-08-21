import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import {
  ACCOUNT_SESSION_COOKIE,
  accountSessionCookieOptions,
  createAccountSession,
} from "@/lib/accountSession";
import { EmailAlreadyRegisteredError, registerPlayerAccount } from "@/lib/playerAccounts";
import {
  PLAYER_COOKIE,
  PLAYER_NAME_COOKIE,
  issuePlayerCookie,
  playerCookieOptions,
  readPlayerName,
} from "@/lib/playerIdentity";
import { generateRecoveryCode, recoveryKey } from "@/lib/recoveryCode";
import {
  generateVerificationToken,
  looksLikeEmail,
  sendVerificationEmail,
  verificationTokenHash,
  EMAIL_VERIFICATION_TTL_SECONDS,
} from "@/lib/emailVerification";

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

  let body: { email?: string } = {};
  try {
    body = (await req.json()) as { email?: string };
  } catch {
    body = {};
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!looksLikeEmail(email)) {
    return NextResponse.json(
      { error: "invalid_email", message: "Adj meg egy érvényes e-mail címet." },
      { status: 400 }
    );
  }

  const playerId = context.playerId;
  let recoveryCode: string | undefined;

  try {
    const jar = cookies();
    const nameState = await readPlayerName(playerId, jar.get(PLAYER_NAME_COOKIE)?.value);
    recoveryCode = generateRecoveryCode();
    const verificationToken = generateVerificationToken();
    const verificationExpiresAt = new Date(
      Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000
    ).toISOString();

    await registerPlayerAccount({
      playerId,
      recoveryKey: await recoveryKey(recoveryCode),
      displayName: nameState.name,
      email,
      emailVerificationTokenHash: await verificationTokenHash(verificationToken),
      emailVerificationExpiresAt: verificationExpiresAt,
    });

    // Never lets a stubbed-or-not mail step block account creation, which has
    // already committed by this point. The same reasoning as consumePurchaseRef
    // in lib/purchaseRef.ts: the primary effect succeeded; a secondary one
    // failing is logged, not surfaced as the request's failure.
    let emailVerificationSent = false;
    try {
      const sent = await sendVerificationEmail(email, verificationToken);
      emailVerificationSent = sent.sent;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[barkoba] sendVerificationEmail failed (registration still succeeded):", err);
    }

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
          email_verification_sent: emailVerificationSent,
          ...(recoveryCode ? { recovery_code: recoveryCode } : {}),
          message: "A fiók elkészült. Mentsd el a kódot, majd próbálj bejelentkezni.",
        },
        { status: 503 }
      );
    }

    const res = NextResponse.json({
      registered: true,
      authenticated: true,
      email_verification_sent: emailVerificationSent,
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
    if (err instanceof EmailAlreadyRegisteredError) {
      return NextResponse.json(
        {
          error: "email_already_registered",
          message: "Ez az e-mail cím már regisztrálva van egy másik fiókhoz.",
        },
        { status: 409 }
      );
    }
    // eslint-disable-next-line no-console
    console.error("[barkoba] account registration failed:", err);
    return NextResponse.json(
      { error: "registration_failed", message: "A regisztráció most nem sikerült." },
      { status: 503 }
    );
  }
}
