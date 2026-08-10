import type { GameRecord, QuestionLogEntry } from "./types";

/**
 * SÚGÓ credit accounting — 0.9.8.0.
 *
 * Everything here is DERIVED. There is no stored credit counter, on purpose:
 * a counter is a second source of truth that can drift from the transcript,
 * and drift in a scarce resource is the kind of bug players notice and
 * remember. Earned credits come from question_count, which the engine already
 * maintains as the authoritative record of charged questions; spent credits
 * come from counting clue turns in the log.
 *
 * This also makes the feature backward compatible for free. A record written
 * before 0.9.8.0 has no clue turns, so it reports zero used and behaves as a
 * game in which no clue has yet been taken. Nothing needs migrating.
 */

/** One credit per ten completed questions: 10, 20, 30 … up to the budget. */
export const QUESTIONS_PER_CLUE_CREDIT = 10;

export function clueCreditsEarned(questionCount: number): number {
  if (!Number.isFinite(questionCount) || questionCount <= 0) return 0;
  return Math.floor(questionCount / QUESTIONS_PER_CLUE_CREDIT);
}

/** A clue turn is one that was requested, whether or not its text arrived yet. */
export function clueCreditsUsed(qaLog: readonly QuestionLogEntry[]): number {
  return qaLog.filter((e) => e.turn_type === "clue").length;
}

/**
 * Clues exist only on Hard, and only when a clue mode was chosen. Easy and
 * Medium are untouched by this feature, as is "none".
 */
export function cluesEnabled(game: GameRecord): boolean {
  return game.difficulty === "hard" && game.clue_mode !== null && game.clue_mode !== "none";
}

/**
 * Credits accumulate. A player who does not spend the credit earned at ten
 * questions still has it at twenty, alongside the new one — eligibility is
 * never forfeited by not using it.
 */
export function clueCreditsAvailable(game: GameRecord): number {
  if (!cluesEnabled(game)) return 0;
  return Math.max(0, clueCreditsEarned(game.question_count) - clueCreditsUsed(game.qa_log));
}

/** True when a clue turn exists whose text the Composer has not yet supplied. */
export function pendingClueRequest(game: GameRecord): QuestionLogEntry | null {
  for (let i = game.qa_log.length - 1; i >= 0; i--) {
    const entry = game.qa_log[i];
    if (!entry) continue;
    if (entry.turn_type === "clue") return entry.clue_text ? null : entry;
  }
  return null;
}
