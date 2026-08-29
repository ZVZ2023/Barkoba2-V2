import { NextResponse } from "next/server";
import {
  getPlayerAccountByVerificationTokenHash,
  markEmailVerified,
  type PlayerAccount,
} from "@/lib/playerAccounts";
import { verificationTokenHash } from "@/lib/emailVerification";

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

    await markEmailVerified(account.player_id);

    return NextResponse.json({ verified: true, already_verified: false, email: account.email });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] email verification failed:", err);
    return NextResponse.json(
      { verified: false, error: "verification_failed", message: "A megerősítés most nem sikerült." },
      { status: 503 }
    );
  }
}
