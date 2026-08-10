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
 * Nothing here changes counting. It changes what the player is shown.
 */
export function questionNumbers(qaLog: readonly QuestionLogEntry[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let n = 0;
  for (const entry of qaLog) {
    if (entry.turn_type !== "question") continue;
    n += 1;
    numbers.set(entry.id, n);
  }
  return numbers;
}
