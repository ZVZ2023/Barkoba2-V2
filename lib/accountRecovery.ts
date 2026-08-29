import { Resend } from "resend";
import { getKV } from "./kv";
import { env } from "./env";
import { generateVerificationToken, verificationTokenHash } from "./emailVerification";

// ---------------------------------------------------------------------------
// V2.7.x — email-based account recovery. An independent, additive fallback
// to the existing recovery-code login: a player who verified their email
// once can always get back into that SAME account, even if they never
// generated/saved a recovery code and have no session left anywhere.
//
// PURPOSE-SEPARATED FROM THE VERIFICATION TOKEN, STRUCTURALLY, NOT BY
// CONVENTION. Email verification tokens live in a Postgres column
// (accounts.players.email_verification_token) with a 24h TTL, and are
// deliberately NEVER cleared after use (migration 0010's own header
// explains why) — the opposite lifecycle a recovery credential needs, which
// must invalidate itself the instant it is used. Rather than force one
// column to serve two lifecycles, or add a migration for a second one, this
// reuses the pattern this codebase already has for exactly this shape of
// problem — an opaque, short-lived, single-use credential — from
// lib/purchaseRef.ts and lib/joinCode.ts: Redis, not Postgres, with a TTL
// that IS the expiry check. A recovery token and a verification token are
// stored in structurally different systems; one can never be presented as
// the other by construction, not merely by not being looked up that way.
//
// RAW TOKEN GENERATION AND HASHING ARE REUSED, NOT REIMPLEMENTED.
// generateVerificationToken()/verificationTokenHash() (lib/emailVerification.ts)
// are already fully generic — 32 random bytes hex-encoded, SHA-256 hex — with
// no verification-specific behaviour baked into either function; only WHERE
// the result is stored and looked up carries any purpose. Calling them again
// here is reuse, not a naming accident.
//
// STORES ONLY THE HASH. The Redis VALUE is { player_id }, keyed by the
// token's hash, exactly the "store only its hash server-side" shape used
// everywhere else a raw secret would otherwise be at rest.
// ---------------------------------------------------------------------------

/**
 * Thirty minutes — short deliberately. This grants a LOGIN session, not
 * merely a confirmation; unlike EMAIL_VERIFICATION_TTL_SECONDS (24h, sized
 * for "found the email a day later"), a lost-access recovery link sitting in
 * an inbox for a day is a materially worse credential to have floating
 * around than a same-day one.
 */
export const ACCOUNT_RECOVERY_TOKEN_TTL_SECONDS = 30 * 60;

interface AccountRecoveryRecord {
  player_id: string;
}

function recoveryKeyFor(hash: string): string {
  return `account_recovery:${hash}`;
}

/** Mints a fresh raw token and stores only its hash, mapped to playerId. */
export async function createAccountRecoveryToken(playerId: string): Promise<string> {
  const raw = generateVerificationToken();
  const hash = await verificationTokenHash(raw);
  await getKV().set<AccountRecoveryRecord>(
    recoveryKeyFor(hash),
    { player_id: playerId },
    ACCOUNT_RECOVERY_TOKEN_TTL_SECONDS
  );
  return raw;
}

/**
 * READ-ONLY. Reports which player_id a token currently resolves to, without
 * consuming it. Used by the recovery landing page's GET status check —
 * safe to call any number of times, including from a link-scanner.
 */
export async function peekAccountRecoveryToken(raw: string): Promise<string | null> {
  if (!raw) return null;
  const hash = await verificationTokenHash(raw);
  const hit = await getKV().get<AccountRecoveryRecord>(recoveryKeyFor(hash));
  return hit?.player_id ?? null;
}

/**
 * MUTATING. Atomically resolves the token AND deletes it — genuinely one
 * Redis operation (getKV().getdel(), the real GETDEL command), not a get()
 * followed by a separate del(). That distinction is the whole point: two
 * concurrent POSTs presenting the SAME raw token are two independent HTTP
 * round trips to Upstash, and a get-then-del would let both read a hit
 * before either one's delete landed — both would be told the token is
 * valid, and both would go on to issue a session. GETDEL is a single
 * command; only one of the two calls can ever receive a non-null result,
 * by construction. This is the only function in this module that may be
 * reached from a POST.
 *
 * Delete-on-read rather than mark-on-use (unlike purchaseRef.ts's
 * consumePurchaseRef, which marks so a REDELIVERED WEBHOOK can be recognised
 * as a retry of the same order): there is no third-party retry to recognise
 * here, only a human's own click, so there is nothing a "already consumed by
 * THIS attempt" distinction would buy that a plain "gone" does not already
 * answer identically and more simply.
 */
export async function consumeAccountRecoveryToken(raw: string): Promise<string | null> {
  if (!raw) return null;
  const hash = await verificationTokenHash(raw);
  const hit = await getKV().getdel<AccountRecoveryRecord>(recoveryKeyFor(hash));
  return hit?.player_id ?? null;
}

export interface SendAccountRecoveryEmailResult {
  sent: boolean;
  recoveryUrl: string;
}

/**
 * Sends the recovery email via Resend — same client, same env vars, same
 * fail-closed posture as sendVerificationEmail(), a DIFFERENT function with
 * its own subject/body rather than a shared one: the two messages must never
 * be interchangeable copy, and forking a two-line function is cheaper than
 * a parameter that silently makes one email able to impersonate the other.
 */
export async function sendAccountRecoveryEmail(
  email: string,
  token: string
): Promise<SendAccountRecoveryEmailResult> {
  const path = `/recover-account?token=${token}`;
  const origin = env.siteUrl();
  const recoveryUrl = origin ? `${origin}${path}` : path;

  const apiKey = env.resendApiKey();
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.error(
      "[barkoba] sendAccountRecoveryEmail: RESEND_API_KEY is not set; no email was sent."
    );
    return { sent: false, recoveryUrl };
  }
  if (!origin) {
    // eslint-disable-next-line no-console
    console.error(
      "[barkoba] sendAccountRecoveryEmail: no SITE_URL and no Vercel deployment URL available; refusing to send an unresolvable link."
    );
    return { sent: false, recoveryUrl };
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: env.resendFromEmail(),
    to: [email],
    subject: "Visszaállítási link a Barkóba fiókodhoz",
    html:
      `<p>Ezt a linket kérted, hogy visszaállítsd a hozzáférésed a Barkóba fiókodhoz.</p>` +
      `<p>A link 30 percig érvényes, és csak egyszer használható.</p>` +
      `<p><a href="${recoveryUrl}">${recoveryUrl}</a></p>` +
      `<p>Ha nem te kérted, nyugodtan hagyd figyelmen kívül ezt az e-mailt — semmi nem történik.</p>`,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] sendAccountRecoveryEmail: Resend refused the send:", error);
    return { sent: false, recoveryUrl };
  }

  return { sent: true, recoveryUrl };
}
