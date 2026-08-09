import { notFound } from "next/navigation";
import { getGame } from "@/lib/gameStore";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import GameClient from "./GameClient";
import RacerClient from "./RacerClient";

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

  const versionLabel = formatVersionLabel(getAppVersion());

  // One route, two turn shapes. Which client renders is decided by who occupies
  // the Racer seat — the field the record has carried since 0.3.0.1.
  if (game.racer_kind === "human") {
    return <RacerClient initialGame={game} versionLabel={versionLabel} />;
  }

  return <GameClient initialGame={game} versionLabel={versionLabel} />;
}
