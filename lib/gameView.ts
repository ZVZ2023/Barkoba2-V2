import type { ComposerAnswer, GameRecord, GameResult, RacerAction } from "./types";
import { awaitingRacer, type Seat } from "./seats";

// ---------------------------------------------------------------------------
// V2.3 — THE ROLE-NARROWING BOUNDARY.
//
// The Human↔Human sibling of lib/racerState.ts, and the same idea: a projection
// that is structurally incapable of carrying what the recipient must not see.
//
// This is the ONLY thing serialized to a Human↔Human client. Note what the
// Racer branch is built from — an explicit field list, never a spread of
// GameRecord. If GameRecord grows a field tomorrow, the Racer does not inherit
// it silently; someone has to come here and add it deliberately. That is the
// property the type system is being used for, and it is why `secret` lives in
// a separate interface rather than as an optional field on a shared one.
//
// This module must never import lib/secretStore.ts. The Composer's target is
// PASSED IN by the route, which read it through the identity-gated
// getSecretForComposer(). So the narrowing rule and the secret lookup stay in
// different files, and neither can quietly acquire the other's job.
// ---------------------------------------------------------------------------

export interface ViewTurn {
  turn_index: number;
  turn_type: RacerAction;
  question_text: string | null;
  guess_text: string | null;
  clue_text: string | null;
  composer_response: ComposerAnswer | null;
  ambiguous_explanation: string | null;
}

/** What both seats may see. Contains no target information before resolution. */
export interface GameView {
  game_id: string;
  seat: Seat;
  phase: string;
  awaiting_racer: boolean;
  game_language: string;
  max_questions: number;
  question_count: number;
  questions_remaining: number;
  ambiguous_count: number;
  turns: ViewTurn[];
  /** turn_index of a question still awaiting an answer, or null. */
  pending_question_index: number | null;
  /** May THIS seat act right now? The client never decides this for itself. */
  your_turn: boolean;
  final_action: RacerAction | null;
  final_guess_text: string | null;
  result: GameResult;
  adjudication_notes: string | null;
  integrity_notes: string | null;
  /**
   * Written at the single declassification point in /resolve, and null for the
   * entire life of the game before that. Safe for both seats precisely because
   * it is only ever non-null once the game is over.
   */
  revealed_target: string | null;
  /** Monotonic change marker so a poll can cheaply tell "anything new?". */
  revision: number;
  /**
   * S1 review follow-up — the ACTUAL GameRecord.revision (the V2.8.1 My Car
   * Key CAS counter), distinct from `revision` above (this file's own
   * derived qa_log-length/answered-count poll marker, load-bearing for
   * Human↔Human's /hh/turn staleness check via HumanClient.tsx's
   * `expected_revision: view.revision` — untouched, never repurposed).
   *
   * Exists so a client that reconciles through this route after a transport
   * failure (see lib/turnRequestGuard.ts) can recover the TRUE revision
   * rather than being stuck submitting a stale one and bouncing off /turn's
   * stale_turn guard on every subsequent attempt. SAFE TO EXPOSE TO BOTH
   * SEATS: it is a plain write counter, structurally the same class of
   * information as `question_count`/`ambiguous_count` above (both already
   * shared with both seats) — it carries no information about the secret
   * target, only how many times the record has been written.
   */
  record_revision: number;
}

/**
 * The Composer's additional payload. A SEPARATE interface, not an optional
 * field, so a Racer view cannot be widened into a Composer view by accident and
 * `secret` cannot appear on a value typed as GameView.
 */
export interface ComposerSecretView {
  target: string;
  definition: string;
}

export interface ComposerGameView extends GameView {
  seat: "composer";
  secret: ComposerSecretView;
  /** The invitation, so a refreshed Composer can retrieve the link. */
  join_code: string | null;
}

/**
 * The most recent question with no answer yet, or null.
 *
 * Scans backwards and SKIPS clue turns. A Composer hint may land between a
 * question and its answer — that is the moment it is most useful — and it must
 * not mask the question underneath it. Treating any non-question as "nothing
 * pending" would hand the turn back to the Racer and let them stack a second
 * question on an unanswered one.
 *
 * A guess or concede ends the questioning phase, so it correctly stops the scan.
 */
export function pendingQuestionIndex(game: GameRecord): number | null {
  for (let i = game.qa_log.length - 1; i >= 0; i -= 1) {
    const entry = game.qa_log[i];
    if (!entry) continue;
    if (entry.turn_type === "clue") continue;
    if (entry.turn_type !== "question") return null;
    return entry.composer_response === null ? entry.turn_index : null;
  }
  return null;
}

/**
 * Whose move is it?
 *
 * Server-authoritative on purpose. If the client decided, a stale tab could
 * offer a control that submits a turn the server will reject — or worse, one it
 * will accept out of order.
 */
export function isSeatsTurn(game: GameRecord, seat: Seat): boolean {
  if (game.phase !== "questioning") return false;
  if (awaitingRacer(game)) return false;
  const pending = pendingQuestionIndex(game);
  // A question awaiting an answer is the Composer's move; otherwise the Racer's.
  return pending === null ? seat === "racer" : seat === "composer";
}

function toViewTurn(e: GameRecord["qa_log"][number]): ViewTurn {
  return {
    turn_index: e.turn_index,
    turn_type: e.turn_type,
    question_text: e.question_text,
    guess_text: e.guess_text,
    clue_text: e.clue_text,
    composer_response: e.composer_response,
    ambiguous_explanation: e.ambiguous_explanation,
  };
}

/**
 * A cheap change marker. Not a lock and not a version vector: it exists so a
 * client can decide whether to re-render, and so a submitted turn can say which
 * state it was composed against (see the stale-turn guard in the H↔H routes).
 */
export function revisionOf(game: GameRecord): number {
  const answered = game.qa_log.filter((e) => e.composer_response !== null).length;
  return game.qa_log.length * 1000 + answered * 10 + (game.phase === "complete" ? 1 : 0);
}
// A hint bumps the revision, so a question composed before it is rejected as
// stale. That is the intended behaviour rather than friction: the hint exists
// precisely to redirect the Racer BEFORE they spend the next question.

/** The shared, target-free projection. Built field by field, never spread. */
export function buildGameView(game: GameRecord, seat: Seat): GameView {
  return {
    game_id: game.game_id,
    seat,
    phase: game.phase,
    awaiting_racer: awaitingRacer(game),
    game_language: game.game_language,
    max_questions: game.max_questions,
    question_count: game.question_count,
    questions_remaining: Math.max(0, game.max_questions - game.question_count),
    ambiguous_count: game.ambiguous_count,
    turns: game.qa_log.map(toViewTurn),
    pending_question_index: pendingQuestionIndex(game),
    your_turn: isSeatsTurn(game, seat),
    final_action: game.final_action,
    final_guess_text: game.final_guess_text,
    result: game.result,
    adjudication_notes: game.adjudication_notes,
    integrity_notes: game.integrity_notes,
    revealed_target: game.revealed_target,
    revision: revisionOf(game),
    record_revision: game.revision,
  };
}

/**
 * The Composer's view. `secret` is supplied by the caller, which obtained it
 * through the identity-gated getter — this function performs no lookup and has
 * no way to obtain a target on its own.
 */
export function buildComposerView(
  game: GameRecord,
  secret: ComposerSecretView
): ComposerGameView {
  return {
    ...buildGameView(game, "composer"),
    seat: "composer",
    secret,
    join_code: game.join_code,
  };
}

/**
 * V2.8.6 R1 Commit 4 — app/game/[id]/page.tsx passes the single-human modes'
 * FULL GameRecord straight to a client component as an RSC prop (unlike
 * this file's own narrowed GameView, built for Human↔Human). Nothing in
 * GameClient.tsx or RacerClient.tsx renders `racer_output_raw` — the AI
 * participant's raw structured output, which can carry its own rationale/
 * reasoning fields — but an unrendered prop is still serialized into the
 * page's RSC payload. This is the one declassification-adjacent seam that
 * needed closing there: strip it before the record ever reaches a client
 * component, rather than trust that nothing downstream reads it.
 */
export function stripRacerOutputRaw(game: GameRecord): GameRecord {
  return {
    ...game,
    qa_log: game.qa_log.map((entry) => ({ ...entry, racer_output_raw: "" })),
  };
}
