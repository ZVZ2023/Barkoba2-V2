import type { GameResult } from "./types";
import type { Seat } from "./seats";

// ---------------------------------------------------------------------------
// V2.3.1 — who won, said from the reader's own point of view.
//
// FIELD FINDING: the first real two-player game resolved correctly and neither
// player could tell at a glance who had won. The screen said "Nem talált." —
// true, neutral, and silent about the thing both players most wanted to know.
// The adjudication paragraph explained it well, but a paragraph is not where a
// result belongs.
//
// The fix is not more words. It is saying the SAME outcome differently to each
// seat: the person reading always learns their own result first, in the
// headline, and the shared detail comes second.
//
// Pure and seat-parameterised so both directions of every outcome are testable
// without rendering anything — there are eight combinations and a screen is a
// poor place to check them.
// ---------------------------------------------------------------------------

export interface ResultCopy {
  /** Short, unmistakable, from this seat's point of view. */
  headline: string;
  /** One line of context. The full adjudication text still follows. */
  detail: string;
  /** Did the reader win? Drives emphasis only. */
  won: boolean;
}

/** Did this seat win, given the adjudicated result? */
export function seatWon(result: GameResult, seat: Seat): boolean {
  const racerWon = result === "racer_correct" || result === "racer_win_integrity_violation";
  return seat === "racer" ? racerWon : !racerWon;
}

/**
 * Both seats' copy for every defined outcome.
 *
 * "gondolkodó" and "kérdező" are the player-facing words for the two seats —
 * the internal role names never reach a screen.
 */
export function resultCopy(result: GameResult, seat: Seat): ResultCopy {
  const won = result === null ? false : seatWon(result, seat);

  switch (result) {
    case "racer_correct":
      return seat === "racer"
        ? { headline: "ELTALÁLTAD!", detail: "Nyertél.", won }
        : { headline: "VESZTETTÉL", detail: "A másik játékos eltalálta.", won };

    case "racer_incorrect":
      return seat === "composer"
        ? { headline: "NYERTÉL!", detail: "A másik játékos nem találta el.", won }
        : { headline: "NEM TALÁLTAD EL", detail: "A gondolkodó nyert.", won };

    case "composer_win_integrity_upheld":
      // Reached when the Racer concedes and the answers hold up.
      return seat === "composer"
        ? { headline: "NYERTÉL!", detail: "A másik játékos feladta.", won }
        : { headline: "FELADTAD", detail: "A gondolkodó nyert.", won };

    case "racer_win_integrity_violation":
      return seat === "racer"
        ? {
            headline: "NYERTÉL!",
            detail: "A gondolkodó válaszai ellentmondtak egymásnak.",
            won,
          }
        : {
            headline: "VESZTETTÉL",
            detail: "A válaszaid ellentmondtak egymásnak.",
            won,
          };

    default:
      // No result yet. The screen does not show this block at all, but a
      // total function is easier to reason about than one with a hole in it.
      return { headline: "Vége", detail: "", won: false };
  }
}
