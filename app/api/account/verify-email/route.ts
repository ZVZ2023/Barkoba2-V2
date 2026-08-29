import { NextResponse } from "next/server";
import {
  getPlayerAccountByVerificationTokenHash,
  markEmailVerifiedAndRotateRecoveryKey,
  type PlayerAccount,
} from "@/lib/playerAccounts";
import { verificationTokenHash } from "@/lib/emailVerification";
import { generateRecoveryCode, recoveryKey } from "@/lib/recoveryCode";

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
 * The previous version verified and rotated the recovery key on the FIRST
 * GET — which meant page LOAD was the mutating action. That is a known real-
 * world failure mode: email security scanners and link-prefetch systems
 * fetch a link's URL automatically, and would become the first "caller"
 * before any human ever saw the page, consuming the one-time raw recovery
 * code before the player could.
 *
 * GET is now a pure status check — zero database writes, safe to call any
 * number of times (page load, a repeat status poll, a scanner). It answers
 * only "what would clicking the button do right now", never does it. POST
 * is the ONLY path that can verify an email or rotate a recovery key, and it
 * fires exclusively from an explicit button click in
 * app/verify-email/VerifyEmailClient.tsx — never from an effect, a mount, a
 * preload, or navigation.
 *
 * Both share the same atomic guard, markEmailVerifiedAndRotateRecoveryKey's
 * `AND email_verified_at IS NULL` — POST is what CALLS it; GET never does.
 */

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
 * MUTATING. The ONLY path that may verify an email or rotate a recovery
 * key — fires exclusively from an explicit "Fiókom megerősítése" click, per
 * VerifyEmailClient.tsx.
 *
 * Re-validates everything from scratch (does not trust a prior GET) since a
 * POST can in principle arrive without one ever having happened. A fresh
 * verification (email_verified_at was NULL) rotates in and returns a NEW
 * recovery code — the newcomer's exactly-one opportunity to capture one,
 * since ClaimPrompt no longer shows the one generated at registration. A
 * repeat/racing POST (already verified, by an earlier request OR by
 * whichever concurrent request wins the atomic race in
 * markEmailVerifiedAndRotateRecoveryKey) is reported as already_verified,
 * WITHOUT a code — showing a second, different code would silently
 * invalidate the one the player may have already saved.
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
      return NextResponse.json({ verified: true, already_verified: true, email: account.email });
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

    const newCode = generateRecoveryCode();
    const marked = await markEmailVerifiedAndRotateRecoveryKey(
      account.player_id,
      await recoveryKey(newCode)
    );

    if (!marked) {
      // Lost the race to a concurrent POST for the SAME token. The account is
      // verified now, by whichever request won — this is the "already
      // verified" case, not a failure, and no second code is shown.
      return NextResponse.json({ verified: true, already_verified: true, email: account.email });
    }

    return NextResponse.json({
      verified: true,
      already_verified: false,
      email: account.email,
      recovery_code: newCode,
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
