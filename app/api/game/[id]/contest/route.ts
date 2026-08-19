import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayerId } from "@/lib/actingPlayer";
import {
  createContest,
  listOwnContestsForGame,
  resolveContestSeat,
} from "@/lib/corpus/gameContests";

// ---------------------------------------------------------------------------
// V2.6 — Contest Verdict: create, and list for one game.
//
// TWO PROPERTIES WORTH STATING BEFORE THE CODE.
//
// 1. THE CLIENT SUPPLIES TWO THINGS: the game id (in the path) and the argument
//    (in the body). Everything else on the stored record — identity, seat, the
//    contested verdict, the status, the evidence snapshot and its schema
//    version — is derived server-side inside lib/corpus/gameContests.ts. There
//    is no field a client can assert.
//
// 2. IDENTITY COMES FROM THE HEADER MIDDLEWARE SETS, having stripped any
//    client-supplied copy first. Same mechanism as every other authorized route
//    in this codebase; no parallel identity path is introduced here.
//
// AUTHORIZATION IS DELIBERATELY STRICTER THAN lib/seats.ts. It requires a
// non-null durable seat id on the corpus row matching the caller, and never
// falls back to the single-human rule. See resolveContestSeat() for why that
// fallback is safe for a live game and unsafe for a historical one.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/** Body cap. The argument itself is length-capped again in the module. */
const MAX_BODY_BYTES = 16_000;

const ERROR_STATUS: Record<string, number> = {
  corpus_unavailable: 503,
  invalid_argument: 400,
  game_not_found: 404,
  game_not_completed: 409,
  not_a_participant: 403,
  duplicate_contest: 409,
  write_failed: 500,
};

/**
 * Player-facing text. Hungarian, like every other message in this shell —
 * V2.6 Task 2 introduces no localization, per the explicit non-scope.
 */
const ERROR_MESSAGE: Record<string, string> = {
  corpus_unavailable: "A vitatás jelenleg nem érhető el.",
  invalid_argument: "Az indoklás nem lehet üres.",
  game_not_found: "Nincs ilyen megőrzött játék.",
  game_not_completed: "Csak lezárt, ítélettel rendelkező játék vitatható.",
  not_a_participant: "Ehhez a játékhoz nincs hozzáférésed.",
  duplicate_contest: "Ehhez a játékhoz már nyújtottál be vitatást.",
  write_failed: "A vitatás rögzítése nem sikerült.",
};

function fail(error: string) {
  return NextResponse.json(
    { error, message: ERROR_MESSAGE[error] ?? "Ismeretlen hiba." },
    { status: ERROR_STATUS[error] ?? 500 }
  );
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const playerId = await resolveActingPlayerId(req.headers);

  // An unauthenticated caller is rejected before any database work. Identity
  // may be unconfigured in a deployment, in which case nobody can contest —
  // which is the correct failure, not a reason to relax the check.
  if (!playerId) return fail("not_a_participant");

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail("invalid_argument");
    body = JSON.parse(raw);
  } catch {
    return fail("invalid_argument");
  }

  const playerArgument =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).player_argument
      : undefined;

  const result = await createContest({
    operationalGameId: params.id,
    playerId,
    playerArgument,
  });

  if (!result.ok) return fail(result.error);

  return NextResponse.json({ contest: result.contest }, { status: 201 });
}

/**
 * The requesting player's OWN contest against this game.
 *
 * CONTESTANT-OWNED, NOT PARTICIPANT-SHARED. Occupying the other seat in the
 * source game does not grant access to the opponent's contest. Creation
 * authorization and retrieval authorization are deliberately different rules:
 * "may you contest this verdict?" is a question about the game, "is this
 * yours?" is a question about the contest.
 *
 * The seat check below does not authorize the payload — the `player_id`
 * predicate inside listOwnContestsForGame does that, in SQL, where a route
 * cannot forget it. The seat check exists so that "you are not in this game"
 * and "you have not contested it" stay distinguishable, because they are
 * genuinely different answers.
 *
 * A non-participant gets 403 and learns nothing else: not whether the game
 * exists, not whether any contest was filed, and never anything about one.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const playerId = await resolveActingPlayerId(req.headers);
  if (!playerId) return fail("not_a_participant");

  const loaded = await listOwnContestsForGame(params.id, playerId);
  // A missing game and an unauthorized reader are answered identically on
  // purpose: probing this endpoint must not reveal which games exist.
  if (!loaded) return fail("not_a_participant");

  const seat = resolveContestSeat(loaded.subject, playerId);
  if (!seat) return fail("not_a_participant");

  // An empty list is a legitimate answer for a participant who has not
  // contested — and is also what a participant sees after their own contest was
  // privacy-unlinked. V2.6 adds no way to tell those apart, deliberately.
  return NextResponse.json({ seat, contests: loaded.contests });
}
