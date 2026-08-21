import type { ComposerAnswer, GamePhase, GameResult, QuestionLogEntry } from "./types";

// ---------------------------------------------------------------------------
// Answer correction and rewind. Pure functions, no I/O.
//
// THE CENTRAL IDEA: question_count and ambiguous_count are never decremented.
// They are RECOMPUTED from the surviving log.
//
// The turn route increments them as it goes, but they are fully derivable from
// qa_log: +1 per YES/NO, +1 per AMBIGUOUS past the free allowance. Subtracting
// on rewind would mean reversing arithmetic across an arbitrary span of turns,
// which is where this class of feature usually goes quietly wrong. Recomputing
// from what remains cannot drift.
//
// MILESTONE 1 RULE: every Racer question costs one of the 20, whatever answer
// it receives. YES, NO and AMBIGUOUS are all worth exactly one question.
// AMBIGUOUS is unlimited in COUNT — there is no quota — but it is not free.
//
// So question_count is simply the number of answered questions in the
// surviving log, and no per-entry credit bookkeeping is needed at all: there
// is no longer any way for two answered questions to cost different amounts.
// ---------------------------------------------------------------------------

export interface SplitResult {
  /** Entries up to and including the corrected turn. */
  retained: QuestionLogEntry[];
  /** Everything after it — invalid, because it was generated from the old answer. */
  abandoned: QuestionLogEntry[];
}

/**
 * Split the log at a turn. Returns null when no entry carries that turn_index.
 */
export function splitAtTurn(
  qaLog: QuestionLogEntry[],
  turnIndex: number
): SplitResult | null {
  const index = qaLog.findIndex((e) => e.turn_index === turnIndex);
  if (index < 0) return null;
  return {
    retained: qaLog.slice(0, index + 1),
    abandoned: qaLog.slice(index + 1),
  };
}

/** Only an answered question can be corrected. */
export function isCorrectable(entry: QuestionLogEntry | undefined): boolean {
  if (!entry) return false;
  return entry.turn_type === "question" && entry.composer_response !== null;
}

export interface RecomputedCounters {
  questionCount: number;
  ambiguousCount: number;
}

/**
 * Recompute both counters from the log.
 *
 * question_count is the number of ANSWERED questions, of any answer type.
 * ambiguous_count is a subset of that, tracked for later abuse analysis.
 * MUTATES entries to clear the retired `ambiguous_consumed_credit` flag,
 * repairing records written under either earlier rule.
 */
export function recomputeCounters(qaLog: QuestionLogEntry[]): RecomputedCounters {
  let questionCount = 0;
  let ambiguousCount = 0;

  for (const entry of qaLog) {
    if (entry.turn_type !== "question") continue;
    const answer = entry.composer_response;
    if (answer === null) continue;

    // Every answered question costs exactly one, regardless of answer type.
    questionCount += 1;
    if (answer === "AMBIGUOUS") ambiguousCount += 1;

    // Retired flag. Under a flat cost there is nothing for it to record —
    // every answered question consumes a credit, so a per-entry "did this one
    // consume a credit?" carries zero information. Cleared, never set.
    entry.ambiguous_consumed_credit = false;
  }

  return { questionCount, ambiguousCount };
}

/** True when applying this answer would leave the log unchanged. */
export function isNoOpCorrection(
  entry: QuestionLogEntry,
  answer: ComposerAnswer,
  explanation: string | null
): boolean {
  if (entry.composer_response !== answer) return false;
  if (answer !== "AMBIGUOUS") return true;
  return (entry.ambiguous_explanation ?? null) === explanation;
}

// ---------------------------------------------------------------------------
// V2.6.x — the pre-guess checkpoint.
//
// Corrections are normally closed the moment the Racer guesses or concedes
// (phase leaves "questioning"): once the Composer can see the guess, letting
// them rewind would let them read the outcome and retroactively invalidate
// it — a cheat, not a recovery affordance. See the WINDOW comment in
// app/api/game/[id]/correct/route.ts.
//
// GameClient.tsx now withholds exactly that guess from view until the
// Composer confirms the single answer that produced it — the AI's guess is
// computed and stored server-side as soon as the triggering answer is
// recorded, but never rendered, and /resolve is never called, until the
// Composer either confirms it or corrects that one answer. This function is
// the server-side half of that checkpoint: it opens the same correction path
// used mid-game, but ONLY for the one turn directly beneath an unrevealed
// guess, and ONLY before adjudication has produced a result. Once `result`
// is set the original close applies again unconditionally. See
// docs/DESIGN-NOTES.md §48.
// ---------------------------------------------------------------------------
export function isPreGuessCheckpointCorrection(
  game: { phase: GamePhase; result: GameResult; qa_log: QuestionLogEntry[] },
  turnIndex: number
): boolean {
  if (game.phase !== "resolving") return false;
  if (game.result !== null) return false;
  const log = game.qa_log;
  const last = log[log.length - 1];
  if (!last || last.turn_type !== "guess") return false;
  const preceding = log[log.length - 2];
  if (!preceding || preceding.turn_index !== turnIndex) return false;
  return true;
}
