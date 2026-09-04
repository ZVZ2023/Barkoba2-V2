import type { GameRecord } from "./types";
import type { IdentityResolution } from "./actingPlayer";

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
 *
 * V2.8.6 R1 — this fallback is no longer relied on by any AUTHORIZATION
 * decision: /ask, /turn, /clue, /correct, /view and app/game/[id]/page.tsx
 * all use resolveSeatStrict/requireSeatStrict below instead, which refuse
 * to trust it. resolveSeat itself is UNCHANGED (still used directly by
 * /resolve's isParticipant check and by page.tsx's Human↔Human branch,
 * where it never engages this fallback in the first place — see below).
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
 * True when `seat`'s `*_player_id` was never recorded, for a single-human
 * mode (Human↔Human is excluded — resolveSeat never falls back for it, so
 * there is nothing to distrust there). Shared by requireSeatStrict (a
 * SPECIFIC required seat — /ask, /turn, /clue, /correct) and
 * resolveSeatStrict (either seat — /view, page.tsx) so the one rule lives
 * in one place.
 */
function isSeatUnrecorded(game: GameRecord, seat: Seat): boolean {
  const recordedId = seat === "composer" ? game.composer_player_id : game.racer_player_id;
  const kind = seat === "composer" ? game.composer_kind : game.racer_kind;
  return !isHumanVsHuman(game) && kind === "human" && !recordedId;
}

/**
 * V2.8.6 R1 — requireSeat, but for a MUTATING single-human-mode route that
 * never checked identity before this. resolveSeat's "the one human seat
 * belongs to whoever is asking" fallback exists for backward compatibility
 * with pre-V2.3 records and must never become the authorization for a
 * route that is only now gaining a check at all: a game whose relevant
 * `*_player_id` was never recorded is not evidence the caller IS that seat,
 * only that nothing was ever asked. Retrofitting a real check onto such a
 * route and then letting the old fallback answer it would make the
 * retrofit a no-op precisely where it matters most.
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
  if (isSeatUnrecorded(game, required)) {
    return { ok: false, seat: null, error: "legacy_seat_unassigned" };
  }
  const check = requireSeat(game, playerId, required);
  return { ok: check.ok, seat: check.seat, error: check.error };
}

export interface SeatResolution {
  kind: "seat" | "not_a_participant" | "legacy_seat_unassigned";
  seat: Seat | null;
}

/**
 * resolveSeat's strict counterpart for a caller that may occupy EITHER
 * seat (/view, page.tsx) — there is no single "required" seat to check
 * against. Resolves via resolveSeat first, then downgrades a match to
 * "legacy_seat_unassigned" if it was only ever the historic fallback
 * answering (an unset seat matches ANY playerId, including a genuine
 * stranger's) rather than a real recorded identity. Same fail-closed
 * policy as requireSeatStrict, same reason.
 */
export function resolveSeatStrict(game: GameRecord, playerId: string | null): SeatResolution {
  const seat = resolveSeat(game, playerId);
  if (!seat) return { kind: "not_a_participant", seat: null };
  if (isSeatUnrecorded(game, seat)) return { kind: "legacy_seat_unassigned", seat: null };
  return { kind: "seat", seat };
}

/** Is the Human↔Human game still waiting for its second player? */
export function awaitingRacer(game: GameRecord): boolean {
  return isHumanVsHuman(game) && !game.racer_player_id;
}

/**
 * V2.8.6 R1 Commit 4 — app/game/[id]/page.tsx's own access decision,
 * extracted as a pure function so it is unit-testable without a Next.js
 * request context (this project has no such harness — see
 * lib/turnRequestGuard.ts's own module doc for the same reasoning). The
 * page itself becomes a thin adapter: resolve identity, read the game,
 * feed both in here, then render whatever `kind` says.
 *
 * Treats /view and this page as ONE security boundary: the same identity
 * taxonomy (identified/absent/backend_unavailable) and the same
 * fail-closed null-seat policy apply to both.
 */
export type GamePageDecision =
  | { kind: "service_unavailable" }
  | { kind: "not_found" }
  | { kind: "restart_required"; requiredSeat: Seat }
  | { kind: "human_vs_human"; seat: Seat }
  | { kind: "single_human"; requiredSeat: Seat };

export function decideGamePageAccess(
  identity: IdentityResolution,
  game: GameRecord | null
): GamePageDecision {
  if (identity.kind === "backend_unavailable") return { kind: "service_unavailable" };
  // Whether the game_id is invalid or the identity is absent, the visitor
  // sees the identical Next.js 404 — so checking identity before the game
  // even loads costs nothing in distinguishability and avoids a wasted
  // lookup for an anonymous crawler.
  if (identity.kind === "absent") return { kind: "not_found" };
  if (!game) return { kind: "not_found" };

  if (isHumanVsHuman(game)) {
    const seat = resolveSeat(game, identity.playerId);
    if (!seat) return { kind: "not_found" };
    return { kind: "human_vs_human", seat };
  }

  const requiredSeat: Seat = game.racer_kind === "human" ? "racer" : "composer";
  const seatCheck = requireSeatStrict(game, identity.playerId, requiredSeat);
  if (!seatCheck.ok) {
    if (seatCheck.error === "legacy_seat_unassigned") {
      return { kind: "restart_required", requiredSeat };
    }
    return { kind: "not_found" };
  }
  return { kind: "single_human", requiredSeat };
}
