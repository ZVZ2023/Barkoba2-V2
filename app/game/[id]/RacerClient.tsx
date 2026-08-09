"use client";

import { useCallback, useRef, useState } from "react";
import type { GameRecord, QuestionLogEntry } from "@/lib/types";

// The human Racer's screen. Quarantined from secretStore by
// scripts/check-isolation.mjs — it renders only what the server sends, and the
// server never sends the target until the game is complete.

interface Props {
  initialGame: GameRecord;
  versionLabel: string;
}

const RESULT_HEADLINE: Record<string, string> = {
  racer_correct: "You got it.",
  racer_incorrect: "Not quite.",
  composer_win_integrity_upheld: "You conceded.",
  racer_win_integrity_violation: "Awarded to you — integrity review.",
};

function answeredTurns(game: GameRecord): QuestionLogEntry[] {
  return game.qa_log.filter((e) => e.turn_type === "question" && e.composer_response);
}

export default function RacerClient({ initialGame, versionLabel }: Props) {
  const [game, setGame] = useState<GameRecord>(initialGame);
  const [question, setQuestion] = useState("");
  const [guess, setGuess] = useState("");
  const [guessMode, setGuessMode] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolveFired = useRef(false);

  const send = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/game/${game.game_id}/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.game) setGame(data.game as GameRecord);
        if (!res.ok) setError(data.message || "Something went wrong.");
        else {
          setQuestion("");
          setGuess("");
          setGuessMode(false);
          setEditing(null);
          setEditText("");
        }
      } catch {
        setError("Network error — please try again.");
      } finally {
        setBusy(false);
      }
    },
    [game.game_id]
  );

  const resolveGame = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/game/${game.game_id}/resolve`, { method: "POST" });
      const data = await res.json();
      if (data.game) setGame(data.game as GameRecord);
      if (!res.ok) {
        setError(data.message || "Could not resolve the game.");
        resolveFired.current = false;
      }
    } catch {
      setError("Network error while resolving — please try again.");
      resolveFired.current = false;
    } finally {
      setBusy(false);
    }
  }, [game.game_id]);

  if (game.phase === "resolving" && !resolveFired.current && !busy) {
    resolveFired.current = true;
    void resolveGame();
  }

  const turns = answeredTurns(game);
  const remaining = Math.max(0, game.max_questions - game.question_count);
  const live = game.phase === "questioning";

  return (
    <main className="mx-auto flex w-full min-h-screen max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex items-baseline justify-between gap-3 border-b border-neutral-800 pb-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Barkóba</h1>
            <span className="shrink-0 text-xs font-normal text-neutral-600">
              {versionLabel}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            You are the Racer. The AI has locked a secret.
            {game.difficulty ? ` · ${game.difficulty}` : ""}
            {game.clue_mode && game.clue_mode !== "none" ? ` · ${game.clue_mode} clues` : ""}
          </p>
        </div>
        <div className="shrink-0 text-right text-xs text-neutral-400">
          <div>
            {game.question_count} / {game.max_questions}
          </div>
          <div className="text-neutral-600">{remaining} left</div>
        </div>
      </header>

      <section className="flex flex-col gap-4">
        {turns.length === 0 && live && (
          <p className="text-sm text-neutral-500">
            Ask anything that can be answered yes or no.
          </p>
        )}

        {turns.map((entry) => (
          <div key={entry.id} className="flex flex-col gap-1.5">
            <div className="flex min-w-0 gap-3">
              <span className="w-6 shrink-0 pt-0.5 text-xs text-neutral-600 sm:w-8">
                #{entry.turn_index}
              </span>
              <p className="min-w-0 break-words text-sm text-neutral-100">
                {entry.question_text}
              </p>
            </div>
            <div className="flex gap-3">
              <span className="w-6 shrink-0 sm:w-8" />
              <span
                className={
                  entry.composer_response === "YES"
                    ? "text-xs font-medium text-emerald-400"
                    : entry.composer_response === "NO"
                      ? "text-xs font-medium text-red-400"
                      : "text-xs font-medium text-amber-400"
                }
              >
                {entry.composer_response}
              </span>
            </div>
            {entry.ambiguous_explanation && (
              <div className="flex min-w-0 gap-3">
                <span className="w-6 shrink-0 sm:w-8" />
                <p className="min-w-0 break-words text-xs italic text-neutral-500">
                  {entry.ambiguous_explanation}
                </p>
              </div>
            )}
            {live &&
              entry.turn_index === turns[turns.length - 1]?.turn_index &&
              editing !== entry.turn_index && (
                <div className="flex min-w-0 gap-3">
                  <span className="w-6 shrink-0 sm:w-8" />
                  <button
                    onClick={() => {
                      setEditing(entry.turn_index);
                      setEditText(entry.question_text ?? "");
                    }}
                    disabled={busy}
                    className="text-xs text-neutral-600 underline underline-offset-2 disabled:opacity-40"
                  >
                    Fix a typo in this question
                  </button>
                </div>
              )}

            {editing === entry.turn_index && (
              <div className="flex min-w-0 gap-3">
                <span className="w-6 shrink-0 sm:w-8" />
                <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-md border border-neutral-700 bg-neutral-900/60 p-3">
                  <p className="text-xs text-neutral-400">
                    Repair a typo or autocorrect slip. Same question, fixed wording —
                    it will be re-answered and won&apos;t cost you a question. Asking
                    something different needs a new question.
                  </p>
                  <textarea
                    className="h-20 w-full min-w-0 resize-none rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    disabled={busy}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() =>
                        void send({
                          edit_turn_index: entry.turn_index,
                          question: editText,
                        })
                      }
                      disabled={busy || !editText.trim()}
                      className="min-h-11 rounded-md bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-900 disabled:opacity-40"
                    >
                      Fix it
                    </button>
                    <button
                      onClick={() => {
                        setEditing(null);
                        setEditText("");
                      }}
                      disabled={busy}
                      className="min-h-11 rounded-md border border-neutral-700 px-4 py-2.5 text-sm text-neutral-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {entry.original_question_text && entry.edit_status === "accepted" && (
              <div className="flex min-w-0 gap-3">
                <span className="w-6 shrink-0 sm:w-8" />
                <p className="min-w-0 break-words text-xs text-neutral-600">
                  corrected from &ldquo;{entry.original_question_text}&rdquo;
                </p>
              </div>
            )}

            {entry.clue_text && (
              <div className="flex min-w-0 gap-3">
                <span className="w-6 shrink-0 sm:w-8" />
                <p className="min-w-0 break-words rounded-md border border-sky-900/40 bg-sky-950/20 px-2.5 py-1.5 text-xs text-sky-200">
                  {entry.clue_text}
                </p>
              </div>
            )}
          </div>
        ))}

        {busy && <p className="text-sm text-neutral-500">Thinking…</p>}

        {live && !guessMode && (
          <div className="flex flex-col gap-2">
            {remaining > 0 ? (
              <>
                <textarea
                  className="h-20 w-full min-w-0 resize-none rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="e.g. Is it a physical object?"
                  disabled={busy}
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void send({ question })}
                    disabled={busy || !question.trim()}
                    className="min-h-11 flex-1 rounded-md bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-900 disabled:opacity-40 sm:flex-none"
                  >
                    Ask
                  </button>
                  <button
                    onClick={() => setGuessMode(true)}
                    disabled={busy}
                    className="min-h-11 flex-1 rounded-md border border-emerald-800 px-4 py-2.5 text-sm font-medium text-emerald-200 disabled:opacity-40 sm:flex-none"
                  >
                    Make my guess
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-2 rounded-md border border-amber-900/50 bg-amber-950/20 p-3">
                <p className="text-sm text-amber-200">
                  Out of questions. Time to commit.
                </p>
                <button
                  onClick={() => setGuessMode(true)}
                  disabled={busy}
                  className="min-h-11 self-start rounded-md bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-900"
                >
                  Make my guess
                </button>
              </div>
            )}
          </div>
        )}

        {live && guessMode && (
          <div className="flex flex-col gap-2 rounded-md border border-emerald-900/50 bg-emerald-950/20 p-4">
            <p className="text-sm text-emerald-200">You get one guess.</p>
            <input
              className="w-full min-w-0 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              placeholder="Name the target"
              disabled={busy}
            />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void send({ guess })}
                disabled={busy || !guess.trim()}
                className="min-h-11 rounded-md bg-emerald-900/60 px-4 py-2.5 text-sm font-medium text-emerald-100 disabled:opacity-40"
              >
                Commit guess
              </button>
              <button
                onClick={() => setGuessMode(false)}
                disabled={busy}
                className="min-h-11 rounded-md border border-neutral-700 px-4 py-2.5 text-sm text-neutral-300"
              >
                Back
              </button>
              <button
                onClick={() => void send({ concede: true })}
                disabled={busy}
                className="min-h-11 rounded-md border border-neutral-800 px-4 py-2.5 text-sm text-neutral-500"
              >
                Give up
              </button>
            </div>
          </div>
        )}
      </section>

      {game.phase === "resolving" && (
        <section className="rounded-md border border-sky-900/50 bg-sky-950/30 p-4">
          <p className="text-sm text-sky-200">Checking your answer…</p>
        </section>
      )}

      {game.phase === "complete" && game.result && (
        <section
          className={
            game.result === "racer_correct" || game.result === "racer_win_integrity_violation"
              ? "rounded-md border border-emerald-900/50 bg-emerald-950/20 p-5"
              : "rounded-md border border-amber-900/50 bg-amber-950/20 p-5"
          }
        >
          <h2 className="text-lg font-semibold text-neutral-100">
            {RESULT_HEADLINE[game.result] ?? "Game complete."}
          </h2>
          <dl className="mt-4 flex flex-col gap-3 border-t border-neutral-800 pt-4 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                The target was
              </dt>
              <dd className="mt-0.5 break-words text-neutral-100">
                {game.revealed_target}
              </dd>
            </div>
            {game.final_guess_text && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-neutral-500">
                  Your guess
                </dt>
                <dd className="mt-0.5 break-words text-neutral-100">
                  {game.final_guess_text}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                Questions used
              </dt>
              <dd className="mt-0.5 text-neutral-300">
                {game.question_count} of {game.max_questions}
              </dd>
            </div>
            {game.adjudication_notes && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-neutral-500">
                  Adjudicator
                </dt>
                <dd className="mt-0.5 break-words text-neutral-300">
                  {game.adjudication_notes}
                </dd>
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
      )}

      {error && (
        <div className="rounded-md border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-200">{error}</p>
        </div>
      )}
    </main>
  );
}
