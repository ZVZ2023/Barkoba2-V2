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

// ---------------------------------------------------------------------------
// V2.4.1 — Play Credit cost, keyed on the question budget and nothing else.
//
// THIS CURVE IS ARBITRARY AND MONOTONIC. It is NOT a calibrated cost proxy and
// does NOT attempt to track the real model-call-volume ratios between tiers — a
// 100-question game costs far more than five times a 20-question one in actual
// API spend. The curve exists to create field-testable price differentiation
// and nothing more. Do not "rebalance" it to look proportional; it will be
// replaced once token-level telemetry (a separate workstream) gives real
// numbers to calibrate against.
//
// SINGLE VARIABLE ON PURPOSE. Composer/Racer kind, difficulty and clue mode are
// all resolved and in scope at the charge, and are all deliberately unused
// here, so this first experiment has one dimension to read.
// ---------------------------------------------------------------------------

const PLAY_CREDIT_COST: Record<QuestionBudget, number> = {
  20: 1,
  35: 2,
  50: 3,
  100: 5,
};

/**
 * Play Credits required for a game with this question budget.
 *
 * Takes the BUDGET, not a cost. The mapping never leaves this module, so no
 * caller — and therefore no request — can state what a game should cost.
 *
 * MAX_QUESTIONS is a deployment knob and can be set to a value that is not one
 * of the four offered tiers. Such a budget is charged at the tier at or above
 * it, so a non-standard budget can never be cheaper than the offered tier it
 * exceeds. Beyond the top tier, the top price applies.
 */
export function playCreditCostForBudget(budget: number): number {
  if (isQuestionBudget(budget)) return PLAY_CREDIT_COST[budget];
  const tier = QUESTION_BUDGETS.find((b) => budget <= b);
  return tier ? PLAY_CREDIT_COST[tier] : PLAY_CREDIT_COST[100];
}
