import { NextResponse } from "next/server";
import {
  PLAYER_COOKIE,
  PLAYER_NAME_COOKIE,
  issuePlayerCookie,
  issuePlayerNameCookie,
  playerCookieOptions,
} from "@/lib/playerIdentity";
import { recoverPlayer } from "@/lib/playerStore";
import { looksLikeRecoveryCode } from "@/lib/recoveryCode";
import { checkRecoveryRateLimit, extractClientIp } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * "I have played before" — V2.1.3.0.
 *
 * Restores the SAME player_id and durable display name onto this browser. No
 * new Player is minted on success; the local cookies are simply re-issued for
 * the Player that already exists.
 */
export async function POST(req: Request) {
  const limit = await checkRecoveryRateLimit(extractClientIp(req.headers));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Túl sok próbálkozás. Próbáld újra később." },
      { status: 429 }
    );
  }

  let body: { code?: string } = {};
  try {
    body = (await req.json()) as { code?: string };
  } catch {
    body = {};
  }

  const raw = body.code ?? "";

  // One message for every failure. Distinguishing "malformed" from "unknown"
  // from "deleted" would tell an attacker which codes are real.
  const wrong = NextResponse.json(
    { error: "not_recovered", message: "Ez a kód nem érvényes." },
    { status: 404 }
  );

  if (!looksLikeRecoveryCode(raw)) return wrong;

  const record = await recoverPlayer(raw);
  if (!record) return wrong;

  const secure = new URL(req.url).protocol === "https:";
  const opts = playerCookieOptions(secure);
  const res = NextResponse.json({ recovered: true, display_name: record.display_name });

  const identity = await issuePlayerCookie(record.player_id);
  res.cookies.set(PLAYER_COOKIE, identity.value, opts);

  // The durable record is authoritative for a claimed Player; the cookie is
  // cache. Writing it here is what makes the name travel to the new device.
  res.cookies.set(
    PLAYER_NAME_COOKIE,
    await issuePlayerNameCookie(record.player_id, record.display_name ?? ""),
    opts
  );
  return res;
}
