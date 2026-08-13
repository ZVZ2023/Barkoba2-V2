import type { GameRecord } from "./types";

// ---------------------------------------------------------------------------
// V2.3 — who is allowed to do what, in one place.
//
// Until V2.3 no gameplay route authorized its caller. Only /api/game/create
// read the acting player at all; /ask, /turn, /clue, /correct and /resolve
// accepted anyone who knew the game id. That was tolerable while the only other
// participant was an AI. With two humans it means either player can drive the
// other's seat, so every mutation now resolves a seat first.
//
// Pure functions, no I/O, so the rules are unit-testable and cannot drift into
// six slightly different inline checks.
// ---------------------------------------------------------------------------

export type Seat = "composer" | "racer";

/** Is this game Human↔Human? Derived — no mode column was needed. */
export function isHumanVsHuman(game: GameRecord): boolean {
  return game.composer_kind === "human" && game.racer_kind === "human";
}

/**
 * Which seat this player occupies, or null for a stranger.
 *
 * BACKWARD COMPATIBILITY: games created before 2.3.0.0 have no seats recorded
 * and are still live in Redis for up to 24h. For those, and for the two
 * single-human modes generally, a game with no seat assigned falls back to the
 * historic rule — the one human seat belongs to whoever is asking. That keeps
 * existing games playable without a migration of live state, and it is safe
 * because those modes have exactly one human by construction.
 */
export function resolveSeat(game: GameRecord, playerId: string | null): Seat | null {
  if (game.composer_player_id && game.composer_player_id === playerId) return "composer";
  if (game.racer_player_id && game.racer_player_id === playerId) return "racer";

  // Human↔Human never falls back: an unassigned caller is a stranger.
  if (isHumanVsHuman(game)) return null;

  if (!game.composer_player_id && game.composer_kind === "human") return "composer";
  if (!game.racer_player_id && game.racer_kind === "human") return "racer";
  return null;
}

export interface SeatCheck {
  ok: boolean;
  seat: Seat | null;
  /** Machine-readable reason, used as the API error code. */
  error: "not_a_participant" | "wrong_seat" | null;
}

/**
 * May this player act in `required`?
 *
 * Two distinct failures, deliberately not collapsed: a stranger is not a
 * participant at all, while a participant acting in the other seat is an
 * attempted role inversion. They deserve different error codes because they are
 * different events — the second is the one worth noticing.
 */
export function requireSeat(
  game: GameRecord,
  playerId: string | null,
  required: Seat
): SeatCheck {
  const seat = resolveSeat(game, playerId);
  if (seat === null) return { ok: false, seat: null, error: "not_a_participant" };
  if (seat !== required) return { ok: false, seat, error: "wrong_seat" };
  return { ok: true, seat, error: null };
}

/** May this player see the game at all? Either seat qualifies. */
export function isParticipant(game: GameRecord, playerId: string | null): boolean {
  return resolveSeat(game, playerId) !== null;
}

/** Is the Human↔Human game still waiting for its second player? */
export function awaitingRacer(game: GameRecord): boolean {
  return isHumanVsHuman(game) && !game.racer_player_id;
}
