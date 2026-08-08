import { notFound } from "next/navigation";
import { getGame } from "@/lib/gameStore";
import { env } from "@/lib/env";
import GameClient from "./GameClient";

// Server component. Reads public game state directly from gameStore — there is
// no GET /api/game/[id] route, because adding one would mean another place
// where a record gets serialized toward a client. One fewer surface, one fewer
// file. Mutations go through POST /api/game/[id]/turn, which returns the
// updated record, so the client never needs to re-fetch.

export const dynamic = "force-dynamic";

export default async function GamePage({ params }: { params: { id: string } }) {
  const game = await getGame(params.id);

  if (!game) {
    notFound();
  }

  return (
    <GameClient
      initialGame={game}
      freeAmbiguousAllowance={env.maxFreeAmbiguousAnswers()}
    />
  );
}
