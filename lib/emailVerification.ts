import { Resend } from "resend";
import { env } from "./env";

// ---------------------------------------------------------------------------
// V2.6.x — email verification for registration.
//
// Same shape as lib/recoveryCode.ts: a high-entropy raw token is generated,
// the RAW value is what travels (in the verification link, and now in the
// email itself); only its SHA-256 hash is ever stored, in
// accounts.players.email_verification_token (migration 0010). A database
// compromise must not itself be enough to verify, or spoof-verify, an
// address.
//
// sendVerificationEmail() calls Resend. It fails CLOSED, never open: an
// unconfigured RESEND_API_KEY or an unresolvable site origin logs loudly and
// returns sent:false — it never throws in a way that would abort the
// registration this is a secondary effect of, and it never pretends to have
// sent something it did not.
// ---------------------------------------------------------------------------

/** Twenty-four hours to click a link, matching this codebase's other TTLs. */
export const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

const TOKEN_BYTES = 32;

/** The raw, single-use verification token. Never stored — see verificationTokenHash. */
export function generateVerificationToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the raw token, hex. The storage/lookup key — see generateVerificationToken. */
export async function verificationTokenHash(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Matches migration 0010's CHECK constraint exactly, so app and DB never disagree. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Cheap sanity check, not RFC 5322. */
export function looksLikeEmail(raw: string): boolean {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 254 && EMAIL_SHAPE.test(raw);
}

export interface SendVerificationEmailResult {
  sent: boolean;
  /** The absolute link that was (or, on failure, would have been) sent. */
  verificationUrl: string;
  /** Resend's message id. Present only when sent is true. */
  providerMessageId?: string;
}

/**
 * Sends the verification email via Resend.
 *
 * The signature is (email, rawToken) in, a result out — unchanged from the
 * stub this replaced, so nothing that calls it needed to change.
 */
export async function sendVerificationEmail(
  email: string,
  token: string
): Promise<SendVerificationEmailResult> {
  const path = `/api/account/verify-email?token=${token}`;
  const origin = env.siteUrl();
  const verificationUrl = origin ? `${origin}${path}` : path;

  const apiKey = env.resendApiKey();
  if (!apiKey) {
    // Same fail-closed shape as every other optional integration in this
    // codebase (XAI_API_KEY, ENTITLEMENT_GRANT_SECRET): unconfigured means
    // "did not happen", reported honestly, never "happened anyway".
    // eslint-disable-next-line no-console
    console.error(
      "[barkoba] sendVerificationEmail: RESEND_API_KEY is not set; no email was sent."
    );
    return { sent: false, verificationUrl };
  }
  if (!origin) {
    // A link with no origin is not a link a player received by email could
    // ever follow. Refusing to send it is more honest than sending a
    // relative path that would render as literally unclickable text.
    // eslint-disable-next-line no-console
    console.error(
      "[barkoba] sendVerificationEmail: no SITE_URL and no Vercel deployment URL available; refusing to send an unresolvable link."
    );
    return { sent: false, verificationUrl };
  }

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from: env.resendFromEmail(),
    to: [email],
    subject: "Erősítsd meg az e-mail címed — Barkóba",
    html:
      `<p>Üdv a Barkóbában!</p>` +
      `<p>Erősítsd meg az e-mail címed az alábbi linkre kattintva. A link 24 óráig érvényes.</p>` +
      `<p><a href="${verificationUrl}">${verificationUrl}</a></p>`,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] sendVerificationEmail: Resend refused the send:", error);
    return { sent: false, verificationUrl };
  }

  return { sent: true, verificationUrl, providerMessageId: data?.id };
}
