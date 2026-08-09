import type { ComposerAnswer, QuestionLogEntry } from "./types";

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
// MILESTONE 1: AMBIGUOUS is unlimited and never consumes a question credit,
// so question_count is simply the number of YES/NO answers in the surviving
// log. The positional free-allowance arithmetic this function used to carry is
// gone with the quota that required it.
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
 * question_count counts YES/NO answers only. MUTATES entries to clear the
 * retired `ambiguous_consumed_credit` flag, which repairs records written
 * before the quota was removed.
 */
export function recomputeCounters(qaLog: QuestionLogEntry[]): RecomputedCounters {
  let questionCount = 0;
  let ambiguousCount = 0;

  for (const entry of qaLog) {
    if (entry.turn_type !== "question") continue;
    const answer = entry.composer_response;
    if (answer === null) continue;

    if (answer === "AMBIGUOUS") {
      ambiguousCount += 1;
    } else {
      questionCount += 1;
    }
    // Retired flag: nothing charges a credit any more.
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
