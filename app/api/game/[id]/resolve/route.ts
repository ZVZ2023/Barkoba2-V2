import { NextRequest, NextResponse } from "next/server";
import { getGame, saveGame } from "@/lib/gameStore";
import { resolveActingPlayerId } from "@/lib/actingPlayer";
import { isParticipant } from "@/lib/seats";
import { getSecretForAdjudication } from "@/lib/secretStore";
import { runAdjudicator } from "@/lib/prompts/adjudicator";
import { runIntegrityReview } from "@/lib/prompts/integrityReview";
import {
  deriveResult,
  needsAdjudication,
  needsIntegrityReview,
} from "@/lib/resolveResult";
import { consumeModelCall } from "@/lib/callBudget";
import type {
  AdjudicatorVerdict,
  GameRecord,
  IntegrityVerdict,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// PERMITTED SECRET CALL SITE. This route reads the secret via
// getSecretForAdjudication and is on the allowlist in
// scripts/check-isolation.mjs.
//
// It is also the SINGLE DECLASSIFICATION POINT: the one place in the codebase
// where target text is copied into public game state, as revealed_target, and
// only at the transition to phase "complete". That is what lets the result
// screen show the answer while app/game/[id]/** stays fully quarantined.
//
// Costs up to two strong-model calls. A correct guess costs ONE — the Integrity
// Review is skipped entirely on that path, not run and discarded. The skip
// decision lives in lib/resolveResult.ts so it is unit-tested rather than
// implied by control flow here.
// ---------------------------------------------------------------------------

export const maxDuration = 60;

function respond(game: GameRecord, status = 200) {
  return NextResponse.json({ game }, { status });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const game = await getGame(params.id);
  if (!game) {
    return NextResponse.json(
      { error: "not_found", message: "Nincs ilyen játék, vagy már lejárt." },
      { status: 404 }
    );
  }

  // V2.3 — only a participant may trigger resolution. Either seat qualifies:
  // both clients poll and either may be first to fire this, and the endpoint is
  // already idempotent for phase "complete". Single-human modes are unaffected,
  // because resolveSeat falls back to the historic one-human rule for them.
  if (!isParticipant(game, await resolveActingPlayerId(_req.headers))) {
    return NextResponse.json(
      { error: "not_a_participant", message: "Ehhez a játékhoz nincs hozzáférésed." },
      { status: 403 }
    );
  }

  // -------------------------------------------------------------------------
  // Idempotency. Non-negotiable on this endpoint: every invocation that gets
  // past here spends strong-model calls, and the client auto-fires it.
  // -------------------------------------------------------------------------
  if (game.phase === "complete") {
    return respond(game);
  }

  if (game.phase !== "resolving") {
    return NextResponse.json(
      {
        error: "wrong_phase",
        message: `Ez a játék "${game.phase}" állapotban van, nincs mit értékelni.`,
        game,
      },
      { status: 409 }
    );
  }

  const secret = await getSecretForAdjudication(game.game_id);
  if (!secret) {
    // Secret and game share a TTL, so this is close to unreachable — but a
    // resolved game with no target would be a silently wrong verdict.
    return NextResponse.json(
      {
        error: "secret_unavailable",
        message:
          "The target for this game is no longer available, so it cannot be adjudicated.",
        game,
      },
      { status: 410 }
    );
  }

  let adjudicatorVerdict: AdjudicatorVerdict | null = null;
  let integrityVerdict: IntegrityVerdict | null = null;
  let adjudicationNotes: string | null = null;
  let adjudicationConfidence: number | null = null;
  let integrityNotes: string | null = null;
  let flaggedTurns: number[] | null = null;

  // -------------------------------------------------------------------------
  // Adjudication — only when there is a guess to judge.
  // -------------------------------------------------------------------------
  if (needsAdjudication(game.final_action)) {
    const budget = await consumeModelCall("resolve");
    if (!budget.allowed) {
      return NextResponse.json(
        {
          error: budget.failedClosed ? "budget_unavailable" : "budget_exhausted",
          message: budget.failedClosed
            ? "Most nem tudjuk ellenőrizni a keretet. A játék megvan — próbáld újra hamarosan."
            : "A Barkóba elérte az értékelésre szánt napi globális határát. A játék megvan — próbáld újra holnap.",
          game,
        },
        { status: budget.failedClosed ? 503 : 429 }
      );
    }

    try {
      const adjudication = await runAdjudicator({
        target: secret.target,
        privateClarification: secret.private_clarification,
        guess: game.final_guess_text ?? "",
        gameLanguage: game.game_language,
      });
      adjudicatorVerdict = adjudication.verdict;
      adjudicationNotes = adjudication.reasoning;
      // V2.2: the Adjudicator has always produced this and the record has
      // always dropped it. Kept exactly as returned — it does not gate the
      // verdict here and must not be interpreted anywhere else.
      adjudicationConfidence =
        typeof adjudication.confidence === "number" ? adjudication.confidence : null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[barkoba] Adjudicator call failed:", err);
      // Phase stays "resolving". A game must never be decided by an error path.
      return NextResponse.json(
        {
          error: "adjudicator_unavailable",
          message: "Most nem sikerült értékelni. A játék változatlan — próbáld újra.",
          game,
        },
        { status: 502 }
      );
    }
  }

  // -------------------------------------------------------------------------
  // Integrity Review — only where the verdict can change the outcome. A correct
  // guess never reaches this branch, so it never costs the call.
  // -------------------------------------------------------------------------
  if (needsIntegrityReview(game.final_action, adjudicatorVerdict)) {
    const budget = await consumeModelCall("resolve");
    if (!budget.allowed) {
      return NextResponse.json(
        {
          error: budget.failedClosed ? "budget_unavailable" : "budget_exhausted",
          message: budget.failedClosed
            ? "Most nem tudjuk ellenőrizni a keretet. A játék megvan — próbáld újra hamarosan."
            : "A Barkóba elérte az értékelésre szánt napi globális határát. A játék megvan — próbáld újra holnap.",
          game,
        },
        { status: budget.failedClosed ? 503 : 429 }
      );
    }

    try {
      const review = await runIntegrityReview({
        target: secret.target,
        privateClarification: secret.private_clarification,
        qaLog: game.qa_log,
        gameLanguage: game.game_language,
      });
      integrityVerdict = review.verdict;
      integrityNotes = review.reasoning;
      flaggedTurns = review.contradicting_turns.length > 0 ? review.contradicting_turns : null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[barkoba] Integrity Review call failed:", err);
      return NextResponse.json(
        {
          error: "integrity_review_unavailable",
          message: "Most nem sikerült befejezni az ellenőrzést. A játék változatlan — próbáld újra.",
          game,
        },
        { status: 502 }
      );
    }
  }

  // -------------------------------------------------------------------------
  // The verdict. deriveResult throws on any combination the table does not
  // define, so orchestration drift fails loudly instead of inventing a winner.
  // -------------------------------------------------------------------------
  let result;
  try {
    result = deriveResult({
      finalAction: game.final_action,
      adjudicator: adjudicatorVerdict,
      integrity: integrityVerdict,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] result derivation failed:", err);
    return NextResponse.json(
      {
        error: "resolution_failed",
        message: "Ebből a játékból nem jött ki egyértelmű eredmény.",
        game,
      },
      { status: 500 }
    );
  }

  game.result = result;
  game.adjudication_notes = adjudicationNotes;
  game.integrity_notes = integrityNotes;
  game.integrity_flagged_turns = flaggedTurns;
  // V2.2 — the verdicts themselves, not only the conclusion drawn from them.
  game.adjudicator_verdict = adjudicatorVerdict;
  game.integrity_verdict = integrityVerdict;
  game.adjudication_confidence = adjudicationConfidence;

  // ---- DECLASSIFICATION: the only copy of secret text into public state. ----
  //
  // V2.2 widened WHAT this single point declassifies. The target's definition,
  // granularity and modifiers are what the granularity-adjudication questions
  // will eventually be answered with, and they died with the secret's 24h TTL.
  // Copying them here — at the same instant, under the same rule, at the same
  // one auditable seam — is what allows lib/corpus/* to record them while
  // remaining structurally incapable of reading secretStore.
  //
  // The alternative was adding the corpus writer to PERMITTED_SECRET_IMPORTERS.
  // That was rejected: one deliberately widened seam is auditable, two seams
  // that each look reasonable in isolation are how an invariant erodes.
  game.revealed_target = secret.target;
  game.revealed_definition = secret.private_clarification;
  game.revealed_granularity = secret.granularity;
  game.revealed_modifiers = secret.modifiers;
  game.revealed_locked_at = secret.locked_at;
  game.phase = "complete";

  await saveGame(game);
  return respond(game);
}
