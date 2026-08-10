import { NextResponse } from "next/server";
import {
  MAX_PLAYER_NAME_LENGTH,
  PLAYER_NAME_COOKIE,
  issuePlayerNameCookie,
  playerCookieOptions,
  playerIdFromHeaders,
  sanitizePlayerName,
} from "@/lib/playerIdentity";

export const dynamic = "force-dynamic";

/**
 * "What should we call you?" - V2.1.2.0.
 *
 * Sets the display-name cookie for the acting anonymous Player. An empty or
 * omitted name records a SKIP: the cookie is still written, because its
 * presence is what stops us asking again. That is the whole reason skipping is
 * a first-class answer rather than a dismissal.
 *
 * This is not registration. There is no account, no credential, no durable
 * record, and nothing here can be recovered on another device.
 */
export async function POST(req: Request) {
  const playerId = playerIdFromHeaders(req.headers);

  if (!playerId) {
    // Identity is unconfigured or unavailable. Nothing to attach a name to, and
    // an unsigned name cookie would be exactly the forgeable artefact the
    // identity design exists to avoid. Fail quietly: the game is unaffected.
    return NextResponse.json(
      { error: "identity_unavailable", message: "Most nem tudjuk megjegyezni a nevet." },
      { status: 409 }
    );
  }

  let body: { name?: string } = {};
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    body = {};
  }

  const name = sanitizePlayerName(body.name ?? "");
  const res = NextResponse.json({ name: name || null, max: MAX_PLAYER_NAME_LENGTH });
  res.cookies.set(
    PLAYER_NAME_COOKIE,
    await issuePlayerNameCookie(playerId, name),
    playerCookieOptions(new URL(req.url).protocol === "https:")
  );
  return res;
}
