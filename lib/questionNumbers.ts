import { isSandboxClarificationEntry } from "./sandboxClarification";
import type { QuestionLogEntry } from "./types";

/**
 * Player-facing question numbering — display only.
 *
 * `turn_index` counts every entry in the log, clue turns included, because it
 * is an engineering identifier: it is what the correction API addresses and
 * what a rewind splits on. It was never meant to be shown as a count.
 *
 * Showing it produced the 12/20-versus-#13 report. After one SÚGÓ the
 * transcript labelled the twelfth charged question "#13", so the header and the
 * transcript disagreed and the player reasonably concluded a clue had cost them
 * a question. It had not — the engine was right and the label was lying.
 *
 * This maps each question turn to its ordinal AMONG QUESTION TURNS, which is
 * exactly what `question_count` counts. Clue turns are skipped and never get a
 * number at all; they are identified in the transcript by their SÚGÓ label.
 *
 * V2.8.5 ENGINE-CONTRACT CORRECTION (defect 5) — the "+1" private
 * sandbox-clarification corridor (lib/sandboxClarification.ts) is also
 * skipped and never gets a number, for the same reason clue turns are: it
 * consumes no Racer question and is not one of the AI's questions at all
 * (see app/api/game/[id]/turn/route.ts, which never increments
 * question_count for these entries). Before this correction, a clarification
 * entry silently consumed a number slot, which would have shifted every
 * REAL question's displayed number up by one — the exact "12/20-versus-#13"
 * failure mode this module already exists to prevent, reintroduced by a
 * different turn kind.
 *
 * Nothing here changes counting. It changes what the player is shown.
 */
export function questionNumbers(qaLog: readonly QuestionLogEntry[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let n = 0;
  for (const entry of qaLog) {
    if (entry.turn_type !== "question") continue;
    if (isSandboxClarificationEntry(entry)) continue;
    n += 1;
    numbers.set(entry.id, n);
  }
  return numbers;
}
