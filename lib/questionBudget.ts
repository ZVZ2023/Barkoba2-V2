import type { Difficulty } from "./types";

// ---------------------------------------------------------------------------
// The question allowance, and what Barkóba recommends for a given difficulty.
//
// Extracted from app/api/game/create/route.ts, where the same four values were
// already the AI-Composer options. Nothing about difficulty or the budget set
// is redesigned here — this module only gives the existing concepts one home,
// so the server that validates a choice and the screen that offers it cannot
// drift apart.
//
// WHY A RECOMMENDATION AND NOT A RULE: difficulty describes DEDUCTIVE DISTANCE
// (see the Difficulty docs in types.ts), and distance is what a question budget
// pays for — a target further from the obvious needs more questions to reach.
// But the Composer owns the target, so they are better placed than any table to
// know how far theirs really is. Barkóba proposes; the Composer decides.
//
// Deliberately a static map, not a computation and not a model call.
// ---------------------------------------------------------------------------

/** The offered allowances. Unchanged from the AI-Composer setup screen. */
export const QUESTION_BUDGETS = [20, 35, 50, 100] as const;

export type QuestionBudget = (typeof QUESTION_BUDGETS)[number];

const RECOMMENDED: Record<Difficulty, QuestionBudget> = {
  easy: 20,
  medium: 35,
  hard: 50,
};

/** What Barkóba suggests for this difficulty. Always a member of QUESTION_BUDGETS. */
export function recommendedBudget(difficulty: Difficulty): QuestionBudget {
  return RECOMMENDED[difficulty];
}

export function isQuestionBudget(value: unknown): value is QuestionBudget {
  return typeof value === "number" && (QUESTION_BUDGETS as readonly number[]).includes(value);
}

/**
 * The authoritative choice, resolved server-side.
 *
 * An override is honoured only if it is one of the offered allowances; anything
 * else falls back to the recommendation rather than being rejected, because a
 * malformed budget is not a reason to refuse to start a game. The client never
 * decides this — it only proposes.
 */
export function resolveQuestionBudget(difficulty: Difficulty, requested: unknown): QuestionBudget {
  return isQuestionBudget(requested) ? requested : recommendedBudget(difficulty);
}
