import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getGame } from "@/lib/gameStore";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import { resolveAccountHeaderState, resolveActingPlayerIdentity } from "@/lib/actingPlayer";
import { decideGamePageAccess } from "@/lib/seats";
import { buildGameView, stripRacerOutputRaw } from "@/lib/gameView";
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
//
// V2.8.6 R1 Commit 4 — treated as ONE security boundary with
// app/api/game/[id]/view/route.ts. Until this commit, the single-human
// branches below (RacerClient, GameClient) rendered the WHOLE GameRecord for
// anyone who loaded the URL, with no identity or seat check at all — the
// same gap the R1 security commit closed on the mutating routes, just never
// closed here. decideGamePageAccess (lib/seats.ts) is the shared, pure,
// unit-tested decision; this page is a thin adapter over it. There is no
// intentionally public game view: no identity or wrong seat -> notFound(),
// exactly like the pre-existing Human↔Human branch already did.

export const dynamic = "force-dynamic";

function ServiceUnavailablePanel() {
  return (
    <main className="mx-auto flex w-full min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <h1 className="text-lg font-semibold text-[var(--ink)]">Most nem elérhető</h1>
      <p className="text-sm text-[var(--ink-soft)]">
        Nem sikerült azonosítani a munkameneted. Próbáld újra hamarosan.
      </p>
      <a href="/" className="mt-2 text-sm text-[var(--ink-soft)] underline underline-offset-2">
        Vissza a Barkóba főoldalra
      </a>
    </main>
  );
}

function RestartRequiredPanel() {
  return (
    <main className="mx-auto flex w-full min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <h1 className="text-lg font-semibold text-[var(--ink)]">Új játék szükséges</h1>
      <p className="text-sm text-[var(--ink-soft)]">
        Ez a játék egy régebbi verzióból származik, és a hozzáférés-ellenőrzés miatt nem folytatható.
      </p>
      <a
        href="/"
        className="mt-2 inline-block min-h-11 rounded-md bg-[var(--green)] px-5 py-3 text-sm font-medium text-[var(--parchment)]"
      >
        Új játék
      </a>
    </main>
  );
}

export default async function GamePage({ params }: { params: { id: string } }) {
  const identity = await resolveActingPlayerIdentity(headers());
  // A game lookup is pointless — and decideGamePageAccess discards it either
  // way — whenever identity resolution itself already settles the outcome
  // (an outage, or nobody presented a usable identity at all).
  const game = identity.kind === "identified" ? await getGame(params.id) : null;
  const decision = decideGamePageAccess(identity, game);

  if (decision.kind === "service_unavailable") {
    return <ServiceUnavailablePanel />;
  }
  if (decision.kind === "not_found") {
    notFound();
  }
  // game is non-null for every remaining decision kind (service_unavailable
  // and not_found — the only outcomes reachable with a null game — are both
  // handled above).
  const liveGame = game!;

  const versionLabel = formatVersionLabel(getAppVersion());

  if (decision.kind === "restart_required") {
    // eslint-disable-next-line no-console
    console.warn(
      `[barkoba] game ${liveGame.game_id}: no ${decision.requiredSeat} seat was ever recorded for this game — ` +
        "refusing rather than assigning the caller retroactively."
    );
    return <RestartRequiredPanel />;
  }

  if (decision.kind === "human_vs_human") {
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
    return (
      <HumanClient
        initialView={buildGameView(liveGame, decision.seat)}
        versionLabel={versionLabel}
      />
    );
  }

  // Single-human modes. Which client renders is decided by who occupies the
  // Racer seat — the field the record has carried since 0.3.0.1. Stripped of
  // racer_output_raw before it ever becomes an RSC prop: nothing downstream
  // renders it, and an unrendered prop is still serialized into the page.
  const safeGame = stripRacerOutputRaw(liveGame);

  if (decision.requiredSeat === "racer") {
    return <RacerClient initialGame={safeGame} versionLabel={versionLabel} />;
  }

  // V2.8.4.3 — the human-Composer/AI-Racer mode's own header gains the same
  // account control SiteHeader and GameShell already carry. Scoped to this
  // client only: RacerClient (AI Composer, human Racer) and HumanClient
  // (human vs human) are different modes, out of this hotfix's boundary.
  const accountHeaderState = await resolveAccountHeaderState(headers());
  return (
    <GameClient
      initialGame={safeGame}
      versionLabel={versionLabel}
      accountAuthenticated={accountHeaderState.authenticated}
      accountPhotoUrl={accountHeaderState.photoUrl}
    />
  );
}
