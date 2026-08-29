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
import {
  checkEmailChangeRateLimit,
  checkEmailChangeTargetRateLimit,
  extractClientIp,
} from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

/** Same body/status for BOTH rate-limit buckets — which one fired must never be observable. */
function rateLimited() {
  return NextResponse.json(
    { error: "rate_limited", message: "Túl sok próbálkozás. Próbáld újra később." },
    { status: 429, headers: PRIVATE_NO_STORE }
  );
}

/**
 * Authenticated email add/change — reachable any time from the profile
 * screen, unlike the one-shot email field on registration itself, and now
 * also from the pending-verification screen's own "Rossz e-mail-cím?"
 * correction affordance (ClaimPrompt.tsx). Reuses the same token/hash/send
 * machinery as registration (lib/emailVerification.ts): a changed address
 * goes back to unverified and gets its own fresh verification link, exactly
 * like a first-time one would.
 *
 * V2.7.x — TWO CHANGES, both reviewed and required before this became a
 * mainstream newcomer action rather than a buried Profil setting:
 *
 * 1. NO ACCOUNT-EXISTENCE WORDING ON COLLISION. The caller here already
 *    holds a valid account session — an authenticated visitor could
 *    otherwise use this endpoint as an oracle, probing arbitrary addresses
 *    against their own session to learn whether each one is registered to
 *    SOME other account. The status code may still distinguish success from
 *    refusal (accepted: the caller needs to know their correction did not
 *    take effect and try something else), but the MESSAGE never says
 *    "already registered" or names another account.
 *
 * 2. RATE-LIMITED, where before it had no limiter at all. Two independent
 *    buckets — checkEmailChangeRateLimit (per caller IP) and
 *    checkEmailChangeTargetRateLimit (per hashed, normalized TARGET email,
 *    protecting one address from being probed via IP rotation) — mirroring
 *    the already-reviewed recovery-request pair
 *    (checkRecoveryEmailRateLimit / checkRecoveryEmailTargetRateLimit) but
 *    in their own buckets, own endpoint, own budget. Both share ONE
 *    response shape (rateLimited(), above) so which bucket fired is never
 *    observable either.
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

  const ip = extractClientIp(req.headers);
  const ipLimit = await checkEmailChangeRateLimit(ip);
  if (!ipLimit.allowed) return rateLimited();

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

  const targetLimit = await checkEmailChangeTargetRateLimit(email);
  if (!targetLimit.allowed) return rateLimited();

  const verificationToken = generateVerificationToken();
  const hash = await verificationTokenHash(verificationToken);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString();

  let saved: boolean;
  try {
    saved = await setAccountEmail(context.playerId, email, hash, expiresAt);
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      // GENERIC, DELIBERATELY. Was "email_already_registered" / "Ez az
      // e-mail cím már regisztrálva van egy másik fiókhoz." — named exactly
      // which fact made it fail. Reviewed and changed: an authenticated
      // caller must not be able to use this endpoint to learn that ANY
      // given address belongs to someone else. No mutation happened either
      // way — setAccountEmail's own conflict check runs before its UPDATE.
      return NextResponse.json(
        {
          error: "email_unavailable",
          message: "Ezt az e-mail-címet nem tudjuk használni. Próbálj egy másikat.",
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
