import { NextRequest, NextResponse } from "next/server";
import { playerIdFromHeaders } from "@/lib/playerIdentity";
import { getContestById, resolveContestSeat } from "@/lib/corpus/gameContests";

// ---------------------------------------------------------------------------
// V2.6 — retrieve one contest and its preserved evidence package.
//
// AUTHORIZATION IS RE-EVALUATED HERE, AGAINST THE GAME — not against the
// contest's own player_id. Two reasons, and the second is the important one:
//
//   1. Both participants may read a contest filed on their shared game, which
//      is the same symmetry the completed game already has.
//
//   2. player_id ON THE CONTEST IS NULLABLE BY DESIGN. Erasure clears it. If
//      retrieval authorized on "does contest.player_id match you", an erased
//      contest would become readable by nobody — or, if the check were written
//      the other way round, by everybody. Authorizing against the game's
//      durable seat columns keeps the rule stable across erasure, and it is the
//      same rule creation uses.
//
// The existence of a contest is therefore never a route to a game's evidence
// for someone who could not already see that game.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/**
 * One response for "no such contest" and for "not yours".
 *
 * Deliberate. A distinguishable 404 would let anyone holding a contest id
 * confirm that it exists, which is the first half of an enumeration attack
 * against a table whose rows contain game transcripts.
 */
function denied() {
  return NextResponse.json(
    { error: "not_a_participant", message: "Ehhez a vitatáshoz nincs hozzáférésed." },
    { status: 403 }
  );
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const playerId = playerIdFromHeaders(req.headers);
  if (!playerId) return denied();

  const loaded = await getContestById(params.id);
  if (!loaded) return denied();

  const seat = resolveContestSeat(loaded.subject, playerId);
  if (!seat) return denied();

  return NextResponse.json({ seat, contest: loaded.contest });
}
