import { getKV } from "./kv";
import { env } from "./env";
import { verificationTokenHash } from "./emailVerification";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
}

/**
 * Fixed-window limiter: N games per rolling-hour bucket per IP. Bucket key
 * includes the current hour so it self-resets — no cleanup job needed.
 *
 * Set RATE_LIMIT_DISABLED=true in local/dev environments to bypass entirely.
 * RATE_LIMIT_GAMES_PER_HOUR controls the limit in every other environment.
 */
export async function checkGameCreationRateLimit(
  ip: string
): Promise<RateLimitResult> {
  const limit = env.rateLimitGamesPerHour();

  if (env.rateLimitDisabled()) {
    return { allowed: true, limit, remaining: limit };
  }

  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const key = `ratelimit:create:${ip}:${hourBucket}`;

  const count = await getKV().incrWithExpiry(key, 60 * 60);

  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
  };
}

/** Best-effort client IP extraction behind Vercel's proxy. */
export function extractClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return headers.get("x-real-ip") || "unknown";
}


/**
 * Recovery attempts — V2.1.3.0.
 *
 * Honest framing: against 120 bits of entropy this is not what stops an
 * attacker; the entropy is. It exists to stop enumeration noise, log spam and
 * trivial denial of service. Tighter than game creation because nobody
 * legitimately types a recovery code ten times in an hour.
 */
export async function checkRecoveryRateLimit(ip: string): Promise<RateLimitResult> {
  const limit = 10;
  if (env.rateLimitDisabled()) return { allowed: true, limit, remaining: limit };

  const hourBucket = new Date().toISOString().slice(0, 13);
  const count = await getKV().incrWithExpiry(`ratelimit:recover:${ip}:${hourBucket}`, 60 * 60);

  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count) };
}

/**
 * V2.7.x — requesting an EMAIL-based recovery link, a distinct abuse shape
 * from checkRecoveryRateLimit's code-guessing concern above: this protects
 * against inbox-spamming a target address, not against enumerating a secret.
 * Own bucket, so the two attempts never share (or exhaust) each other's
 * budget. Same honest framing: this stops noise and spam, not a determined
 * attacker who already has the address.
 */
export async function checkRecoveryEmailRateLimit(ip: string): Promise<RateLimitResult> {
  const limit = 5;
  if (env.rateLimitDisabled()) return { allowed: true, limit, remaining: limit };

  const hourBucket = new Date().toISOString().slice(0, 13);
  const count = await getKV().incrWithExpiry(
    `ratelimit:recover-email:${ip}:${hourBucket}`,
    60 * 60
  );

  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count) };
}

/**
 * V2.7.x — a SECOND, independent bucket for the same recovery-request
 * endpoint, keyed on the TARGET email rather than the caller's IP.
 * checkRecoveryEmailRateLimit above protects Barkóba/Resend from one noisy
 * source; this protects one PLAYER's inbox from an attacker who simply
 * rotates IPs and keeps requesting recovery links for the same address.
 * Neither bucket alone covers what the other does.
 *
 * NORMALIZE THEN HASH, NEVER STORE THE RAW ADDRESS. Normalization matches
 * account lookup exactly (getPlayerAccountByEmail's own
 * `LOWER(email) = LOWER(...)`) — trim + lowercase — so the same address
 * always maps to the same bucket regardless of how it was typed.
 * verificationTokenHash (lib/emailVerification.ts) is reused as-is: it is
 * already a fully generic SHA-256-hex function with no token-specific
 * behaviour, the same reasoning lib/accountRecovery.ts already applies to
 * reusing it for token hashing. The Redis KEY that results is therefore
 * never the address itself, recoverable only by someone who already knows
 * the address well enough to reproduce the same hash.
 */
export async function checkRecoveryEmailTargetRateLimit(email: string): Promise<RateLimitResult> {
  const limit = 4;
  if (env.rateLimitDisabled()) return { allowed: true, limit, remaining: limit };

  const normalized = email.trim().toLowerCase();
  const hash = await verificationTokenHash(normalized);
  const hourBucket = new Date().toISOString().slice(0, 13);
  const count = await getKV().incrWithExpiry(
    `ratelimit:recover-email-target:${hash}:${hourBucket}`,
    60 * 60
  );

  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count) };
}

/**
 * V2.7.x — POST /api/account/email's per-IP bucket. A distinct endpoint from
 * the recovery-request pair above (a different abuse shape: this one is
 * reachable only with an authenticated session, changing an EXISTING
 * account's own address, not requesting a link for an arbitrary target) —
 * kept in its own bucket rather than sharing checkRecoveryEmailRateLimit's,
 * so the two endpoints' traffic can never exhaust each other's budget.
 */
export async function checkEmailChangeRateLimit(ip: string): Promise<RateLimitResult> {
  const limit = 10;
  if (env.rateLimitDisabled()) return { allowed: true, limit, remaining: limit };

  const hourBucket = new Date().toISOString().slice(0, 13);
  const count = await getKV().incrWithExpiry(
    `ratelimit:email-change:${ip}:${hourBucket}`,
    60 * 60
  );

  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count) };
}

/**
 * V2.7.x — POST /api/account/email's per-TARGET-email bucket, same shape and
 * same reasoning as checkRecoveryEmailTargetRateLimit above: an attacker
 * with (or repeatedly creating) an authenticated session could otherwise
 * rotate IPs and keep attempting to move a specific victim address onto
 * their own account, one probe at a time. Normalize-then-hash, own bucket —
 * never shares a key with the recovery-request pair, so neither endpoint's
 * traffic can be used to infer anything about the other's.
 */
export async function checkEmailChangeTargetRateLimit(email: string): Promise<RateLimitResult> {
  const limit = 10;
  if (env.rateLimitDisabled()) return { allowed: true, limit, remaining: limit };

  const normalized = email.trim().toLowerCase();
  const hash = await verificationTokenHash(normalized);
  const hourBucket = new Date().toISOString().slice(0, 13);
  const count = await getKV().incrWithExpiry(
    `ratelimit:email-change-target:${hash}:${hourBucket}`,
    60 * 60
  );

  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count) };
}
