import { getKV } from "./kv";
import { env } from "./env";

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
