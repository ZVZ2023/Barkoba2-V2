import { NextResponse } from "next/server";
import {
  getPlayerAccountByVerificationTokenHash,
  markEmailVerified,
} from "@/lib/playerAccounts";
import { verificationTokenHash } from "@/lib/emailVerification";

export const dynamic = "force-dynamic";

/**
 * V2.6.x — the receiving end of the verification link.
 *
 * Deliberately takes the token from the URL only, not from a session: the
 * player who clicks this link may be on a different device or browser than
 * the one that registered, and the link itself is the credential.
 *
 * "Invalid" (never existed, or already superseded) and "expired" (existed,
 * past its TTL) are answered differently on purpose — unlike the purchase-ref
 * endpoint, there is no money at stake here and telling a player their link
 * specifically expired, so they know to ask for a new one, is materially
 * better UX than one generic refusal.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.json(
      { verified: false, error: "missing_token", message: "Hiányzik a megerősítő kód." },
      { status: 400 }
    );
  }

  try {
    const hash = await verificationTokenHash(token);
    const account = await getPlayerAccountByVerificationTokenHash(hash);
    if (!account) {
      return NextResponse.json(
        { verified: false, error: "invalid_token", message: "Ez a megerősítő link érvénytelen." },
        { status: 404 }
      );
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

    const marked = await markEmailVerified(account.player_id);
    if (!marked) {
      return NextResponse.json(
        { verified: false, error: "verification_failed", message: "A megerősítés most nem sikerült." },
        { status: 503 }
      );
    }

    return NextResponse.json({ verified: true, email: account.email });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] email verification failed:", err);
    return NextResponse.json(
      { verified: false, error: "verification_failed", message: "A megerősítés most nem sikerült." },
      { status: 503 }
    );
  }
}
