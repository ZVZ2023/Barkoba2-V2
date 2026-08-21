import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayerId } from "@/lib/actingPlayer";
import { listPlayerHistory } from "@/lib/corpus/gameCorpus";

// ---------------------------------------------------------------------------
// V2.6.x — a player's own game history.
//
// REQUEST-AUTHORITY-SCOPED, ALWAYS, exactly like /api/player/entitlement:
// player_id comes only from the trusted middleware header or an active
// account session, never from a request parameter, so this endpoint is
// structurally incapable of returning someone else's games.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const playerId = await resolveActingPlayerId(req.headers);
  if (!playerId) {
    return NextResponse.json(
      { error: "identity_unavailable", message: "Most nem érhető el a játékosazonosító." },
      { status: 409 }
    );
  }

  const games = await listPlayerHistory(playerId);
  if (games === null) {
    return NextResponse.json(
      { error: "history_unavailable", message: "A játéktörténet most nem érhető el." },
      { status: 503 }
    );
  }

  return NextResponse.json({ games });
}
