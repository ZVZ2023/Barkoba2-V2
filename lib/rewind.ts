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
// THE SUBTLETY THAT WOULD OTHERWISE MISCOUNT: `ambiguous_consumed_credit` is
// positional, not intrinsic. With a free allowance of 3, if turns 1-3 were
// AMBIGUOUS (free) and turn 4 AMBIGUOUS (costed), correcting turn 1 to YES
// promotes turn 4 into the free tier. Its stored flag is now wrong. So the
// flags are REWRITTEN across the whole retained log rather than trusted.
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
 * Recompute both counters from the log, rewriting each entry's
 * `ambiguous_consumed_credit` to match its position in the surviving sequence.
 *
 * MUTATES the entries it is given — deliberately, since the flags are part of
 * the record being repaired, not a derived view of it.
 */
export function recomputeCounters(
  qaLog: QuestionLogEntry[],
  freeAmbiguousAllowance: number
): RecomputedCounters {
  let questionCount = 0;
  let ambiguousCount = 0;

  for (const entry of qaLog) {
    if (entry.turn_type !== "question") continue;
    const answer = entry.composer_response;
    if (answer === null) continue;

    if (answer === "AMBIGUOUS") {
      const costsCredit = ambiguousCount >= freeAmbiguousAllowance;
      entry.ambiguous_consumed_credit = costsCredit;
      if (costsCredit) questionCount += 1;
      ambiguousCount += 1;
    } else {
      entry.ambiguous_consumed_credit = false;
      questionCount += 1;
    }
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
