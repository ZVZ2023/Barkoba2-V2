import { NextRequest, NextResponse } from "next/server";
import { playerIdFromHeaders } from "@/lib/playerIdentity";
import { getContestById } from "@/lib/corpus/gameContests";

// ---------------------------------------------------------------------------
// V2.6 — retrieve one contest and its preserved evidence package.
//
// CONTESTANT-OWNED. The authenticated player must match a non-null
// `contest.player_id`. Occupying the other seat in the source game grants
// nothing here, and neither does anything else: V2.6 ships no reviewer, admin
// or community access path.
//
// THE OWNERSHIP TEST IS IN THE QUERY, not in this handler. getContestById()
// cannot return a row belonging to someone else, so this route has no guard it
// could forget — the same reasoning that put the identity check inside
// getSecretForComposer() rather than in the route that calls it.
//
// A PRIVACY-ERASED CONTEST IS UNREACHABLE HERE, AND THAT IS INTENDED. Unlink
// sets player_id to NULL and a NULL matches no requester. The record survives
// as durable historical evidence — argument, snapshot, seat, verdict and
// timestamps all intact — with no end-user retrieval path. Future reviewer or
// community authorization is separate scope; it is deliberately NOT
// approximated here with a fallback.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/**
 * ONE response for "no such contest", "not yours", and "erased".
 *
 * Deliberate, and load-bearing. A distinguishable 404 would let anyone holding
 * a contest id confirm that it exists, which is the first half of an
 * enumeration attack against a table whose rows contain game transcripts.
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

  const contest = await getContestById(params.id, playerId);
  if (!contest) return denied();

  return NextResponse.json({ seat: contest.contestant_seat, contest });
}
