import { NextResponse } from "next/server";
import { getPlayerAccountByEmail } from "@/lib/playerAccounts";
import { looksLikeEmail } from "@/lib/emailVerification";
import { createAccountRecoveryToken, sendAccountRecoveryEmail } from "@/lib/accountRecovery";
import {
  checkRecoveryEmailRateLimit,
  checkRecoveryEmailTargetRateLimit,
  extractClientIp,
} from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * V2.7.x — "I lost access" by email, independent of and additional to the
 * existing recovery-code login (POST /api/account/login). A player types an
 * email address; if it belongs to a VERIFIED account, a single-use recovery
 * link is sent. Nothing about the recovery-code mechanism changes.
 *
 * NO EMAIL ENUMERATION, BY CONSTRUCTION, AND NO RATE-LIMIT ORACLE EITHER.
 * Every outcome — no account, an unverified account, a verified account,
 * the per-IP bucket exceeded, the per-target-email bucket exceeded —
 * returns the exact same status code and JSON body. Earlier drafts of this
 * route surfaced a distinct 429 for IP rate-limiting; that was reconsidered:
 * this endpoint's whole contract is "the response says nothing", and a
 * second observable branch is a second thing to keep provably inert, for no
 * real benefit (throttling still WORKS silently — the caller simply does
 * not learn that it fired).
 *
 * TWO INDEPENDENT BUCKETS, BOTH SILENT ON OVERFLOW. checkRecoveryEmailRateLimit
 * (per caller IP) protects Barkóba/Resend from one noisy source;
 * checkRecoveryEmailTargetRateLimit (per hashed, normalized target email)
 * protects one player's inbox from an attacker who simply rotates IPs.
 * Neither is skipped because the other already ran.
 *
 * Timing is not actively equalised between branches (a real DB lookup plus
 * a real Resend call is inherently slower than an early return) — best
 * effort, matching the task's own "where reasonably avoidable" qualifier
 * rather than a constant-time countermeasure for a single-field form.
 */
export async function POST(req: Request) {
  const GENERIC = () =>
    NextResponse.json(
      {
        message:
          "Ha ehhez az e-mail címhez tartozik megerősített Barkóba fiók, elküldtük a visszaállítási linket.",
      },
      { headers: PRIVATE_NO_STORE }
    );

  const ip = extractClientIp(req.headers);
  const ipLimit = await checkRecoveryEmailRateLimit(ip);
  if (!ipLimit.allowed) return GENERIC();

  let body: { email?: unknown } = {};
  try {
    body = (await req.json()) as { email?: unknown };
  } catch {
    body = {};
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!looksLikeEmail(email)) return GENERIC();

  const targetLimit = await checkRecoveryEmailTargetRateLimit(email);
  if (!targetLimit.allowed) return GENERIC();

  try {
    const account = await getPlayerAccountByEmail(email);
    if (account && account.email_verified_at !== null && account.email) {
      const token = await createAccountRecoveryToken(account.player_id);
      try {
        await sendAccountRecoveryEmail(account.email, token);
      } catch (err) {
        // Same non-fatal shape as every other best-effort mail step in this
        // codebase: the request itself must not fail or vary its response
        // because a secondary side effect (the send) did.
        // eslint-disable-next-line no-console
        console.error("[barkoba] sendAccountRecoveryEmail failed:", err);
      }
    }
  } catch (err) {
    // A lookup failure must not turn into a distinguishable response either
    // — logged, not surfaced.
    // eslint-disable-next-line no-console
    console.error("[barkoba] account recovery request failed:", err);
  }

  return GENERIC();
}
