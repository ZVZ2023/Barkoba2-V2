"use client";

import type { GameRecord } from "@/lib/types";

// This component is quarantined from secretStore by scripts/check-isolation.mjs.
// It shows the target by reading game.revealed_target, which the resolve route
// writes at the single declassification point. It has no other route to it.

interface Props {
  game: GameRecord;
  resolving: boolean;
  error: string | null;
  onRetry: () => void;
}

const HEADLINE: Record<string, string> = {
  racer_correct: "The Racer got it.",
  racer_incorrect: "The Racer missed. You win.",
  composer_win_integrity_upheld: "The Racer conceded. You win.",
  racer_win_integrity_violation: "Awarded to the Racer — integrity review.",
};

const SUBHEAD: Record<string, string> = {
  racer_correct: "Named your target within the question limit.",
  racer_incorrect: "Your answers held up under review.",
  composer_win_integrity_upheld: "It ran out of room and gave up. Your answers held up under review.",
  racer_win_integrity_violation:
    "The review found at least one answer that contradicted your target.",
};

export default function ResultPanel({ game, resolving, error, onRetry }: Props) {
  if (game.phase === "resolving") {
    return (
      <section className="rounded-md border border-sky-900/50 bg-sky-950/30 p-4">
        <p className="text-sm text-sky-200">
          {game.final_action === "concede"
            ? "The Racer has conceded."
            : "The Racer has committed to a guess."}
        </p>
        {game.final_guess_text && (
          <p className="mt-1 break-words text-sm text-neutral-100">“{game.final_guess_text}”</p>
        )}

        {error ? (
          <div className="mt-3 flex flex-col items-start gap-2">
            <p className="text-sm text-red-300">{error}</p>
            <p className="text-xs text-neutral-500">
              Your game is unchanged — nothing has been decided yet.
            </p>
            <button
              onClick={onRetry}
              className="min-h-11 rounded-md border border-neutral-600 px-4 py-2.5 text-sm text-neutral-200"
            >
              Try again
            </button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-neutral-500">
            {resolving ? "Adjudicating…" : "Waiting to adjudicate…"}
          </p>
        )}
      </section>
    );
  }

  if (game.phase !== "complete" || !game.result) return null;

  const racerWon =
    game.result === "racer_correct" || game.result === "racer_win_integrity_violation";

  return (
    <section
      className={
        racerWon
          ? "rounded-md border border-amber-900/50 bg-amber-950/20 p-5"
          : "rounded-md border border-emerald-900/50 bg-emerald-950/20 p-5"
      }
    >
      <h2 className="text-lg font-semibold text-neutral-100">
        {HEADLINE[game.result] ?? "Game complete."}
      </h2>
      <p className="mt-1 text-sm text-neutral-400">{SUBHEAD[game.result] ?? ""}</p>

      <dl className="mt-4 flex flex-col gap-3 border-t border-neutral-800 pt-4 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Your target</dt>
          <dd className="mt-0.5 break-words text-neutral-100">{game.revealed_target}</dd>
        </div>

        {game.final_action === "guess" && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">
              The Racer&apos;s guess
            </dt>
            <dd className="mt-0.5 break-words text-neutral-100">{game.final_guess_text}</dd>
          </div>
        )}

        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Questions used</dt>
          <dd className="mt-0.5 text-neutral-300">
            {game.question_count} of {game.max_questions}
            {game.ambiguous_count > 0 && ` · ${game.ambiguous_count} ambiguous`}
          </dd>
        </div>

        {game.adjudication_notes && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Adjudicator</dt>
            <dd className="mt-0.5 break-words text-neutral-300">{game.adjudication_notes}</dd>
          </div>
        )}

        {game.integrity_notes && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">
              Integrity review
            </dt>
            <dd className="mt-0.5 break-words text-neutral-300">{game.integrity_notes}</dd>
            {game.integrity_flagged_turns && game.integrity_flagged_turns.length > 0 && (
              <dd className="mt-1 text-xs text-amber-300">
                Contradicting turns: {game.integrity_flagged_turns.map((t) => `#${t}`).join(", ")}
              </dd>
            )}
          </div>
        )}
      </dl>

      <a
        href="/"
        className="mt-5 inline-block min-h-11 rounded-md bg-neutral-100 px-5 py-3 text-sm font-medium text-neutral-900"
      >
        Play again
      </a>
    </section>
  );
}
