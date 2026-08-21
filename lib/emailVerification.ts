// ---------------------------------------------------------------------------
// V2.6.x — email verification for registration.
//
// Same shape as lib/recoveryCode.ts: a high-entropy raw token is generated,
// the RAW value is what travels (in the verification link, and — once wired
// — in the email itself); only its SHA-256 hash is ever stored, in
// accounts.players.email_verification_token (migration 0010). A database
// compromise must not itself be enough to verify, or spoof-verify, an
// address.
//
// sendVerificationEmail() IS A STUB. It logs what it would have sent and
// returns immediately. No network call happens in this file, and no
// RESEND_API_KEY is read here.
//   // TODO: wire to Resend once RESEND_API_KEY exists
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
  /** Present only in this stub, so tests and manual checks can see the link without a real inbox. */
  debugVerificationPath: string;
}

/**
 * STUB. Logs what would be sent and returns; no provider is called.
 *
 * The signature is deliberately final: (email, rawToken) in, a result out.
 * Wiring Resend means replacing this function's body only — nothing that
 * calls it needs to change.
 *
 * // TODO: wire to Resend once RESEND_API_KEY exists
 */
export async function sendVerificationEmail(
  email: string,
  token: string
): Promise<SendVerificationEmailResult> {
  const debugVerificationPath = `/api/account/verify-email?token=${token}`;
  // eslint-disable-next-line no-console
  console.log(
    `[barkoba] STUB sendVerificationEmail: would send to ${email} — link: ${debugVerificationPath}`
  );
  return { sent: true, debugVerificationPath };
}
