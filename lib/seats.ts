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

export interface StrictSeatCheck {
  ok: boolean;
  seat: Seat | null;
  error: "not_a_participant" | "wrong_seat" | "legacy_seat_unassigned" | null;
}

/**
 * V2.8.6 R1 — requireSeat, but for a MUTATING single-human-mode route that
 * never checked identity before this. resolveSeat's "the one human seat
 * belongs to whoever is asking" fallback exists for a READ affordance
 * (/view's Human↔Human poll, /resolve's idempotent trigger) and for
 * backward compatibility with pre-V2.3 records. It must never become the
 * authorization for a route that is only now gaining a check at all: a game
 * whose relevant `*_player_id` was never recorded is not evidence the caller
 * IS that seat, only that nothing was ever asked. Retrofitting a real check
 * onto such a route and then letting the old fallback answer it would make
 * the retrofit a no-op precisely where it matters most.
 *
 * So this fails CLOSED instead of falling back, for single-human modes only
 * (Human↔Human already never falls back — see resolveSeat). No caller,
 * including the game's own creator, is assigned the seat retroactively;
 * the game must be treated as unplayable through this route until it is
 * replaced. See each call site for the "restart required" response this
 * produces.
 */
export function requireSeatStrict(
  game: GameRecord,
  playerId: string | null,
  required: Seat
): StrictSeatCheck {
  const recordedId = required === "composer" ? game.composer_player_id : game.racer_player_id;
  const requiredKind = required === "composer" ? game.composer_kind : game.racer_kind;
  if (!isHumanVsHuman(game) && requiredKind === "human" && !recordedId) {
    return { ok: false, seat: null, error: "legacy_seat_unassigned" };
  }
  const check = requireSeat(game, playerId, required);
  return { ok: check.ok, seat: check.seat, error: check.error };
}

/** Is the Human↔Human game still waiting for its second player? */
export function awaitingRacer(game: GameRecord): boolean {
  return isHumanVsHuman(game) && !game.racer_player_id;
}
