import { NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { EmailAlreadyRegisteredError, setAccountEmail } from "@/lib/playerAccounts";
import {
  EMAIL_VERIFICATION_TTL_SECONDS,
  generateVerificationToken,
  looksLikeEmail,
  sendVerificationEmail,
  verificationTokenHash,
} from "@/lib/emailVerification";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Authenticated email add/change — reachable any time from the profile
 * screen, unlike the one-shot email field on registration itself. Reuses
 * the same token/hash/send machinery as registration
 * (lib/emailVerification.ts): a changed address goes back to unverified and
 * gets its own fresh verification link, exactly like a first-time one would.
 */
export async function POST(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account") {
    return NextResponse.json(
      {
        error: "account_required",
        message: "Az e-mail cím módosításához be kell jelentkezned.",
      },
      { status: 401, headers: PRIVATE_NO_STORE }
    );
  }

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
      { status: 400, headers: PRIVATE_NO_STORE }
    );
  }

  const verificationToken = generateVerificationToken();
  const hash = await verificationTokenHash(verificationToken);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString();

  let saved: boolean;
  try {
    saved = await setAccountEmail(context.playerId, email, hash, expiresAt);
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      return NextResponse.json(
        {
          error: "email_already_registered",
          message: "Ez az e-mail cím már regisztrálva van egy másik fiókhoz.",
        },
        { status: 409, headers: PRIVATE_NO_STORE }
      );
    }
    // eslint-disable-next-line no-console
    console.error("[barkoba] account email update failed:", err);
    return NextResponse.json(
      { error: "update_failed", message: "Az e-mail cím mentése most nem sikerült." },
      { status: 503, headers: PRIVATE_NO_STORE }
    );
  }
  if (!saved) {
    return NextResponse.json(
      { error: "update_failed", message: "Az e-mail cím mentése most nem sikerült." },
      { status: 503, headers: PRIVATE_NO_STORE }
    );
  }

  // Same non-fatal shape as registration: the address is already saved by
  // this point, so a stubbed-or-not mail step failing must not be reported
  // as this request's failure.
  let emailVerificationSent = false;
  try {
    const sent = await sendVerificationEmail(email, verificationToken);
    emailVerificationSent = sent.sent;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[barkoba] sendVerificationEmail failed (email update still succeeded):",
      err
    );
  }

  return NextResponse.json(
    { email, email_verification_sent: emailVerificationSent },
    { headers: PRIVATE_NO_STORE }
  );
}
