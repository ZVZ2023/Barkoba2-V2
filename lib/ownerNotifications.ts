import { Resend } from "resend";
import { env } from "./env";
import { looksLikeEmail } from "./emailVerification";

// ---------------------------------------------------------------------------
// V2.9.2 — owner monitoring: best-effort email alerts to the site owner on
// (1) a new signup still awaiting email verification, and (2) that same
// signup's verification succeeding. Two separate messages, like
// lib/emailVerification.ts and lib/accountRecovery.ts's own "never
// interchangeable copy" precedent — but here BOTH go to the same fixed
// recipient (the owner), so the actual Resend call is shared in one small
// helper rather than duplicated per message the way those two modules
// duplicate their own provider calls for two DIFFERENT recipients.
//
// REUSES THE EXISTING RESEND INTEGRATION. Same RESEND_API_KEY, same
// RESEND_FROM_EMAIL, same provider — no new service, no new cost.
//
// FAILS CLOSED, EXACTLY LIKE sendVerificationEmail: an unconfigured
// OWNER_NOTIFICATION_EMAIL or RESEND_API_KEY means "did not happen",
// reported honestly (sent:false), never thrown from here. Every call site
// (app/api/account/register/route.ts, app/api/account/verify-email/
// route.ts) ALSO wraps its own call in a try/catch that only logs — the
// same "primary effect already committed, a secondary one failing is
// logged, not surfaced" pattern used for sendVerificationEmail itself. This
// module's own internal fail-closed checks are the first line of defense;
// the caller's try/catch is the second, for defense in depth.
//
// PLAYER-SUPPLIED TEXT IS ESCAPED. display_name and email are free text a
// player typed — see lib/playerIdentity.ts's own "free text from a
// stranger" framing for display_name. Unlike sendVerificationEmail (which
// only ever embeds a URL this server built), these emails embed player-
// supplied strings directly into HTML, so they are HTML-escaped before use.
// ---------------------------------------------------------------------------

export interface OwnerNotificationResult {
  sent: boolean;
}

export interface SignupNotificationDetails {
  playerName: string;
  email: string;
  signupTime: Date;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Same fallback shape as sendVerificationEmail's own verificationUrl: relative if origin is unknown, still a valid (if unclickable-from-email) path. */
function adminOverviewUrl(): string {
  const origin = env.siteUrl();
  const path = "/admin/overview";
  return origin ? `${origin}${path}` : path;
}

async function sendToOwner(subject: string, html: string): Promise<OwnerNotificationResult> {
  const to = env.ownerNotificationEmail();
  if (!to || !looksLikeEmail(to)) {
    // eslint-disable-next-line no-console
    console.error(
      "[barkoba] owner notification skipped: OWNER_NOTIFICATION_EMAIL is not set (or not a valid address)."
    );
    return { sent: false };
  }
  const apiKey = env.resendApiKey();
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] owner notification skipped: RESEND_API_KEY is not set.");
    return { sent: false };
  }

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from: env.resendFromEmail(),
    to: [to],
    subject,
    html,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] owner notification: Resend refused the send:", error);
    return { sent: false };
  }
  void data;
  return { sent: true };
}

function detailsHtml(details: SignupNotificationDetails): string {
  return (
    `<ul>` +
    `<li><strong>Időpont:</strong> ${escapeHtml(details.signupTime.toISOString())}</li>` +
    `<li><strong>Név:</strong> ${escapeHtml(details.playerName)}</li>` +
    `<li><strong>E-mail:</strong> ${escapeHtml(details.email)}</li>` +
    `</ul>`
  );
}

/**
 * Sent right after a NEW account row commits (app/api/account/register/
 * route.ts), before that account's verification email is even known to
 * have sent. Fires at most once per real new account: a retried
 * registration attempt for the same player_id never reaches this call a
 * second time, because registerPlayerAccount's own unique constraints
 * (player_id / recovery_key / LOWER(email)) make a duplicate attempt throw
 * before this point is ever reached again (see that route's own catch
 * block) — there is no separate "already notified" flag to maintain.
 */
export async function notifyOwnerOfNewSignup(
  details: SignupNotificationDetails
): Promise<OwnerNotificationResult> {
  return sendToOwner(
    "Új regisztráció — megerősítésre vár — Barkóba",
    `<p>Új játékos regisztrált a Barkóbán, és a megerősítő e-mailre vár.</p>` +
      detailsHtml(details) +
      `<p><a href="${adminOverviewUrl()}">Admin áttekintés megnyitása</a></p>`
  );
}

/**
 * Sent from app/api/account/verify-email/route.ts's POST handler, ONLY on
 * the branch reached when `account.email_verified_at` was still null
 * immediately before this call (i.e. `already_verified === false` in that
 * route's own response shape) — never on the reusable-token "already
 * verified" branch, which is reachable an unbounded number of times from
 * any device by design (see that route's own header comment) and would
 * otherwise re-notify on every repeat login. This mirrors
 * ensureInitialComplimentary(..., { trustVerified: true })'s own "only the
 * fresh-verification branch" placement in the exact same function.
 */
export async function notifyOwnerOfVerifiedSignup(
  details: SignupNotificationDetails
): Promise<OwnerNotificationResult> {
  return sendToOwner(
    "Regisztráció megerősítve — Barkóba",
    `<p>Egy játékos megerősítette az e-mail címét a Barkóbán.</p>` +
      detailsHtml(details) +
      `<p><a href="${adminOverviewUrl()}">Admin áttekintés megnyitása</a></p>`
  );
}
