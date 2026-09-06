import type { ExperienceMode, GameResult } from "./types";
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

function baseResultCopy(result: GameResult, seat: Seat): ResultCopy {
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

// ---------------------------------------------------------------------------
// V2.8.8 COMPLETION — headline-only mode variants, keyed by [result][seat].
// `detail` and `won` are NEVER overridden here — only the headline's
// wording changes; the underlying outcome is untouched. Competitive and
// legacy (mode omitted/null) share baseResultCopy() unchanged — "concise,
// neutral presentation" is exactly what it already is. Teaching has no
// entry: this screen's Teaching differentiator is the racer-seat strategy
// tip and hint-entry guidance already shown during play, not a different
// closing headline. The integrity-violation outcome is left out of both
// mode maps below on purpose, in every seat — its wording stays neutral in
// every mode, since dramatizing or joking about an integrity finding is not
// what "supportive" or "playful" should mean here.
// ---------------------------------------------------------------------------
type ResultKey = "racer_correct" | "racer_incorrect" | "composer_win_integrity_upheld";

const MODE_HEADLINE: Partial<Record<ExperienceMode, Partial<Record<ResultKey, Partial<Record<Seat, string>>>>>> = {
  friendly: {
    racer_correct: { racer: "ELTALÁLTAD! Szoros volt.", composer: "VESZTETTÉL — de jó meccs volt!" },
    racer_incorrect: { composer: "NYERTÉL! Szép munka.", racer: "NEM TALÁLTAD EL — közel jártál." },
    composer_win_integrity_upheld: { composer: "NYERTÉL!", racer: "FELADTAD — semmi baj, lesz még meccs." },
  },
  humorous: {
    racer_correct: { racer: "ELTALÁLTAD! Na tessék.", composer: "VESZTETTÉL — a titok győzött." },
    racer_incorrect: { composer: "NYERTÉL! A titkod jól bujkált.", racer: "NEM TALÁLTAD EL — pedig közel voltál." },
    composer_win_integrity_upheld: { composer: "NYERTÉL!", racer: "FELADTAD — a titok most megúszta." },
  },
};

/**
 * Both seats' copy for every defined outcome.
 *
 * "gondolkodó" and "kérdező" are the player-facing words for the two seats —
 * the internal role names never reach a screen.
 *
 * `mode` is OPTIONAL and defaults to no variation: every pre-existing
 * 2-argument call site (test/humanVsHuman.test.ts's literal-string
 * assertions included) gets byte-identical output to before this
 * completion pass. Only `headline` can ever differ by mode; `detail` and
 * `won` come from baseResultCopy() unconditionally.
 */
export function resultCopy(result: GameResult, seat: Seat, mode?: ExperienceMode | null): ResultCopy {
  const base = baseResultCopy(result, seat);
  if (!mode || result === null) return base;

  const override = MODE_HEADLINE[mode]?.[result as ResultKey]?.[seat];
  return override ? { ...base, headline: override } : base;
}
