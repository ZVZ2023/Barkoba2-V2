import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getGame } from "@/lib/gameStore";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import { playerIdFromHeaders } from "@/lib/playerIdentity";
import { isHumanVsHuman, resolveSeat } from "@/lib/seats";
import { buildGameView } from "@/lib/gameView";
import GameClient from "./GameClient";
import RacerClient from "./RacerClient";
import HumanClient from "./HumanClient";

// Server component. Reads public game state directly from gameStore — there is
// no GET /api/game/[id] route for the single-human modes, because adding one
// would mean another place where a record gets serialized toward a client.
// Mutations go through POST /api/game/[id]/turn, which returns the updated
// record, so those clients never need to re-fetch.
//
// V2.3 adds the one exception: a Human↔Human player waiting on an opponent has
// no mutation to make, so that mode polls GET /api/game/[id]/view — a
// projection narrowed by seat rather than a whole record. This page hands that
// mode its FIRST view directly, so the screen is correct before the first poll.
//
// PERMITTED SECRET CALL SITE. getSecretForComposer refuses unless the viewer is
// the recorded Composer; the check lives in the getter, not here.

export const dynamic = "force-dynamic";

export default async function GamePage({ params }: { params: { id: string } }) {
  const game = await getGame(params.id);

  if (!game) {
    notFound();
  }

  const versionLabel = formatVersionLabel(getAppVersion());

  // -------------------------------------------------------------------------
  // V2.3 — Human↔Human. Role is a property of the REQUEST here, not of the
  // game: both seats are "human", so racer_kind can no longer decide which
  // client to render. resolveSeat answers "who is asking" instead.
  // -------------------------------------------------------------------------
  if (isHumanVsHuman(game)) {
    const playerId = playerIdFromHeaders(headers());
    const seat = resolveSeat(game, playerId);

    // A stranger holding the URL is not shown the game. Not even the transcript:
    // questions asked so far are themselves information about the target.
    if (!seat) {
      notFound();
    }

    // Both seats are handed the SHARED, target-free projection. The Composer's
    // own secret arrives from GET /api/game/[id]/view, which the client fetches
    // immediately on mount.
    //
    // WHY NOT READ IT HERE: this page would then become a second module able to
    // reach secretStore. The approved V2.3 scope widened
    // PERMITTED_SECRET_IMPORTERS by exactly ONE entry, and one deliberately
    // widened seam is auditable where two that each look reasonable are how an
    // invariant erodes. scripts/check-isolation.mjs caught the earlier version
    // of this file doing exactly that — the guard working as intended.
    return <HumanClient initialView={buildGameView(game, seat)} versionLabel={versionLabel} />;
  }

  // One route, two turn shapes. Which client renders is decided by who occupies
  // the Racer seat — the field the record has carried since 0.3.0.1.
  if (game.racer_kind === "human") {
    return <RacerClient initialGame={game} versionLabel={versionLabel} />;
  }

  return <GameClient initialGame={game} versionLabel={versionLabel} />;
}
