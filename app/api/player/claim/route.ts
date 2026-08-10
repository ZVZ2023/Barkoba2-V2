import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  PLAYER_COOKIE,
  PLAYER_NAME_COOKIE,
  playerCookieOptions,
  playerIdFromHeaders,
  readPlayerName,
} from "@/lib/playerIdentity";
import { claimPlayer, deleteDurablePlayer, getDurablePlayer } from "@/lib/playerStore";
import { generateRecoveryCode } from "@/lib/recoveryCode";

export const dynamic = "force-dynamic";

/**
 * "Protect this player" — V2.1.3.0.
 *
 * Claiming attaches a recovery code to the EXISTING anonymous Player. No new
 * identity is minted, which is the difference between claiming and registering.
 *
 * GET     current protected state
 * POST    protect, returning the raw code exactly once
 * DELETE  remove the durable identity and become anonymous again
 */

function noPlayer() {
  return NextResponse.json(
    { error: "identity_unavailable", message: "Most nem érhető el a játékosazonosító." },
    { status: 409 }
  );
}

export async function GET(req: Request) {
  const playerId = playerIdFromHeaders(req.headers);
  if (!playerId) return noPlayer();
  const record = await getDurablePlayer(playerId);
  return NextResponse.json({ protected: !!record, display_name: record?.display_name ?? null });
}

export async function POST(req: Request) {
  const playerId = playerIdFromHeaders(req.headers);
  if (!playerId) return noPlayer();

  if (await getDurablePlayer(playerId)) {
    // V2.1 refuses rotation. Issuing a second code would silently invalidate
    // one the player may have written down.
    return NextResponse.json(
      { error: "already_claimed", message: "Ez a játékos már védve van." },
      { status: 409 }
    );
  }

  const jar = cookies();
  const nameState = await readPlayerName(playerId, jar.get(PLAYER_NAME_COOKIE)?.value);

  // The code exists in memory for the length of this request and nowhere else.
  // Only its SHA-256 is stored, so this response is the single opportunity the
  // player will ever have to save it.
  const code = generateRecoveryCode();
  const record = await claimPlayer(playerId, nameState.name, code);
  if (!record) return NextResponse.json({ error: "already_claimed" }, { status: 409 });

  return NextResponse.json({ recovery_code: code, display_name: record.display_name });
}

export async function DELETE(req: Request) {
  const playerId = playerIdFromHeaders(req.headers);
  if (!playerId) return noPlayer();

  const deleted = await deleteDurablePlayer(playerId);

  // Clearing the cookies is part of deletion, not a side effect: the player
  // asked to be forgotten, so the local identity goes too and they return as
  // an anonymous newcomer.
  const res = NextResponse.json({ deleted });
  const expired = { ...playerCookieOptions(new URL(req.url).protocol === "https:"), maxAge: 0 };
  res.cookies.set(PLAYER_COOKIE, "", expired);
  res.cookies.set(PLAYER_NAME_COOKIE, "", expired);
  return res;
}
