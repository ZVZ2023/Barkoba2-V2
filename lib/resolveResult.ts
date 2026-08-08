import type {
  AdjudicatorVerdict,
  GameResult,
  IntegrityVerdict,
  RacerAction,
} from "./types";

// ---------------------------------------------------------------------------
// The result table, as a pure function. Zero I/O, zero model calls, zero
// imports beyond types.
//
// This module decides who won. A silent logic error here is unrecoverable —
// unlike a bad question or a soft adjudication, there is no later stage that
// catches it. So it is isolated from everything that can fail for unrelated
// reasons, and tested exhaustively in test/resolveResult.test.ts.
//
// THE TABLE
//
//   final_action | Adjudicator | Integrity  | result
//   -------------+-------------+------------+---------------------------------
//   guess        | correct     | NOT RUN    | racer_correct
//   guess        | incorrect   | violated   | racer_win_integrity_violation
//   guess        | incorrect   | upheld     | racer_incorrect
//   concede      | NOT RUN     | violated   | racer_win_integrity_violation
//   concede      | NOT RUN     | upheld     | composer_win_integrity_upheld
//
// Two deliberate properties:
//
// 1. A correct guess is unappealable AND cheap. The Integrity Review is not
//    invoked at all on that path — not invoked and ignored, not invoked. A
//    Composer who cheated and still lost is never accused, and the resolve
//    costs one strong-model call instead of two. This is why the skip decision
//    lives here, in tested code, rather than as an `if` in the route handler.
//
// 2. Integrity is decisive only where it can change something. On a concede or
//    an incorrect guess it determines the outcome; nowhere else does it run.
// ---------------------------------------------------------------------------

/** Adjudication is meaningful only when there is a guess to judge. */
export function needsAdjudication(finalAction: RacerAction | null): boolean {
  return finalAction === "guess";
}

/**
 * Integrity Review runs only when its verdict can affect the result:
 * on a concede, or on a guess already judged incorrect.
 */
export function needsIntegrityReview(
  finalAction: RacerAction | null,
  adjudicatorVerdict: AdjudicatorVerdict | null
): boolean {
  if (finalAction === "concede") return true;
  if (finalAction === "guess") return adjudicatorVerdict === "incorrect";
  return false;
}

export interface ResolveInputs {
  finalAction: RacerAction | null;
  /** null when adjudication was not run (concede). */
  adjudicator: AdjudicatorVerdict | null;
  /** null when the review was not run (correct guess). */
  integrity: IntegrityVerdict | null;
}

/**
 * Throws on combinations the table does not define, rather than silently
 * returning a default. An undefined combination means the orchestration
 * drifted from the table, and that must fail loudly at the point of drift.
 */
export function deriveResult(inputs: ResolveInputs): GameResult {
  const { finalAction, adjudicator, integrity } = inputs;

  if (finalAction === "guess") {
    if (adjudicator === null) {
      throw new Error("deriveResult: a guess requires an adjudicator verdict");
    }
    if (adjudicator === "correct") {
      if (integrity !== null) {
        throw new Error(
          "deriveResult: Integrity Review must not run on a correct guess — " +
            "it is skipped entirely, not run and discarded"
        );
      }
      return "racer_correct";
    }
    // adjudicator === "incorrect"
    if (integrity === null) {
      throw new Error(
        "deriveResult: an incorrect guess requires an integrity verdict"
      );
    }
    return integrity === "violated" ? "racer_win_integrity_violation" : "racer_incorrect";
  }

  if (finalAction === "concede") {
    if (adjudicator !== null) {
      throw new Error("deriveResult: adjudication must not run on a concede");
    }
    if (integrity === null) {
      throw new Error("deriveResult: a concede requires an integrity verdict");
    }
    return integrity === "violated"
      ? "racer_win_integrity_violation"
      : "composer_win_integrity_upheld";
  }

  throw new Error(
    `deriveResult: cannot resolve a game whose final action is ${String(finalAction)}`
  );
}

/** Expected strong-model calls for a given path. Used for cost accounting. */
export function expectedResolveCalls(
  finalAction: RacerAction | null,
  adjudicatorVerdict: AdjudicatorVerdict | null
): number {
  return (
    (needsAdjudication(finalAction) ? 1 : 0) +
    (needsIntegrityReview(finalAction, adjudicatorVerdict) ? 1 : 0)
  );
}
