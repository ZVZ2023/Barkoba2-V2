import { NextRequest, NextResponse } from "next/server";
import { getGame, saveGame } from "@/lib/gameStore";
import { resolveActingPlayerId } from "@/lib/actingPlayer";
import { consumeJoinCode, resolveJoinCode } from "@/lib/joinCode";
import { isHumanVsHuman } from "@/lib/seats";

// ---------------------------------------------------------------------------
// V2.3 — the second player takes the Racer seat.
//
// The whole join mechanism: resolve a code to a game, refuse if the seat is
// taken, write the seat. No matchmaking, no lobby, no discovery.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const playerId = await resolveActingPlayerId(req.headers);
  if (!playerId) {
    return NextResponse.json(
      { error: "identity_unavailable", message: "Most nem érhető el a játékosazonosító." },
      { status: 409 }
    );
  }

  let body: { code?: string };
  try {
    body = (await req.json()) as { code?: string };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const code = (body.code || "").trim();
  if (!code) {
    return NextResponse.json(
      { error: "missing_code", message: "Hiányzik a meghívókód." },
      { status: 400 }
    );
  }

  const gameId = await resolveJoinCode(code);
  if (!gameId) {
    return NextResponse.json(
      { error: "invalid_code", message: "Ez a meghívó nem érvényes, vagy lejárt." },
      { status: 404 }
    );
  }

  const game = await getGame(gameId);
  if (!game) {
    return NextResponse.json(
      { error: "not_found", message: "Ez a játék már nem elérhető." },
      { status: 404 }
    );
  }

  if (!isHumanVsHuman(game)) {
    return NextResponse.json(
      { error: "not_joinable", message: "Ehhez a játékhoz nem lehet csatlakozni." },
      { status: 409 }
    );
  }

  // Rejoining your own game through the link is not an error — a Composer who
  // opens their own invitation should land in their game, not be told off.
  if (game.composer_player_id === playerId) {
    return NextResponse.json({ game_id: game.game_id, seat: "composer" });
  }
  if (game.racer_player_id === playerId) {
    return NextResponse.json({ game_id: game.game_id, seat: "racer" });
  }

  // THE "no third player" GUARANTEE. The authoritative check is the seat
  // already being occupied, not the code having been consumed — a code can be
  // screenshotted, a filled seat cannot be emptied.
  if (game.racer_player_id) {
    return NextResponse.json(
      { error: "game_full", message: "Ebben a játékban már két játékos van." },
      { status: 409 }
    );
  }

  game.racer_player_id = playerId;
  await saveGame(game);

  // Best-effort: stop a stale link reaching a "full" screen. Never blocks.
  await consumeJoinCode(code).catch(() => undefined);

  return NextResponse.json({ game_id: game.game_id, seat: "racer" });
}
