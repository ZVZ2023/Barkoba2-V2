import { NextRequest, NextResponse } from "next/server";
import { getGame } from "@/lib/gameStore";
import { resolveActingPlayerIdentity } from "@/lib/actingPlayer";
import { resolveSeatStrict } from "@/lib/seats";
import { getSecretForComposer } from "@/lib/secretStore";
import { buildComposerView, buildGameView } from "@/lib/gameView";

// ---------------------------------------------------------------------------
// V2.3 — the role-aware read endpoint. Polled while it is the opponent's turn.
//
// THIS ROUTE REVERSES A DELIBERATE DECISION. app/game/[id]/page.tsx says there
// is no GET route "because adding one would mean another place where a record
// gets serialized toward a client". That held while state only ever flowed back
// as the return value of the caller's own mutation — but a player waiting for
// an opponent has no mutation to make, so Human↔Human is impossible without a
// read.
//
// The reversal makes the system safer, not merely possible. The old path
// serialized the WHOLE GameRecord through a server component identically for
// everyone. This one is the first projection in the codebase computed from who
// is asking, and it is narrowed field by field in lib/gameView.ts.
//
// PERMITTED SECRET CALL SITE. Reads the target through getSecretForComposer,
// which returns null unless the caller IS the recorded Composer. The identity
// check lives in the getter, not here, so this route cannot forget it.
//
// V2.8.6 R1 Commit 4 — treated as one security boundary with
// app/game/[id]/page.tsx: the same typed identity resolution and the same
// FIXED NULL-SEAT POLICY (no fallback to "whoever is asking" for an unset
// single-human seat) now apply here too. Human↔Human behavior is unchanged —
// resolveSeatStrict never falls back for it, exactly like resolveSeat
// already didn't.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  // The header middleware sets, having stripped any client-supplied copy.
  const identity = await resolveActingPlayerIdentity(_req.headers);
  if (identity.kind === "backend_unavailable") {
    return NextResponse.json(
      {
        error: "identity_unavailable",
        message: "Most nem tudjuk azonosítani a munkameneted. Próbáld újra hamarosan.",
      },
      { status: 503 }
    );
  }

  const game = await getGame(params.id);
  if (!game) {
    return NextResponse.json(
      { error: "not_found", message: "Nincs ilyen játék, vagy már lejárt." },
      { status: 404 }
    );
  }

  if (identity.kind === "absent") {
    return NextResponse.json(
      { error: "unauthenticated", message: "A játékhoz be kell azonosítanod magad." },
      { status: 401 }
    );
  }

  const seatResolution = resolveSeatStrict(game, identity.playerId);
  if (seatResolution.kind === "legacy_seat_unassigned") {
    // eslint-disable-next-line no-console
    console.warn(
      `[barkoba] game ${game.game_id}: no seat was ever recorded for this game — ` +
        "refusing rather than assigning the caller retroactively."
    );
    return NextResponse.json(
      {
        error: "restart_required",
        message:
          "Ez a játék egy régebbi verzióból származik, és a hozzáférés-ellenőrzés miatt nem folytatható. Kezdj új játékot.",
      },
      { status: 409 }
    );
  }
  if (seatResolution.kind === "not_a_participant") {
    // A stranger learns only that they are not in this game. No phase, no
    // counts, no transcript — a 403 body is still a response body.
    return NextResponse.json(
      { error: "not_a_participant", message: "Ehhez a játékhoz nincs hozzáférésed." },
      { status: 403 }
    );
  }

  const seat = seatResolution.seat!;
  if (seat === "racer") {
    return NextResponse.json({ view: buildGameView(game, "racer") });
  }

  const secret = await getSecretForComposer(game, identity.playerId);
  if (!secret) {
    // Seat says composer but the getter refused: the secret has expired, or the
    // seat is unassigned. Serve the shared view rather than failing the poll —
    // the game is still readable, the Composer just cannot see their own target.
    return NextResponse.json({ view: buildGameView(game, "composer") });
  }

  return NextResponse.json({
    view: buildComposerView(game, {
      target: secret.target,
      definition: secret.private_clarification,
    }),
  });
}
