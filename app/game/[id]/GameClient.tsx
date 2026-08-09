"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerAnswer, GameRecord, QuestionLogEntry } from "@/lib/types";
import ResultPanel from "./ResultPanel";

interface Props {
  initialGame: GameRecord;
  versionLabel: string;
}

function pendingQuestion(game: GameRecord): QuestionLogEntry | null {
  const last = game.qa_log.length > 0 ? game.qa_log[game.qa_log.length - 1] : undefined;
  if (!last) return null;
  if (last.turn_type !== "question") return null;
  return last.composer_response === null ? last : null;
}

/** How many turns a correction at this turn would discard. */
function discardCount(game: GameRecord, turnIndex: number): number {
  const index = game.qa_log.findIndex((e) => e.turn_index === turnIndex);
  return index < 0 ? 0 : game.qa_log.length - index - 1;
}

function answeredTurns(game: GameRecord): QuestionLogEntry[] {
  return game.qa_log.filter(
    (e) => e.turn_type !== "question" || e.composer_response !== null
  );
}

export default function GameClient({ initialGame, versionLabel }: Props) {
  const [game, setGame] = useState<GameRecord>(initialGame);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ambiguousMode, setAmbiguousMode] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [correctionExplanation, setCorrectionExplanation] = useState("");
  // Mirrors `ambiguousMode` on the main answer path: Ambiguous reveals the
  // optional note before committing, Yes/No commit straight away.
  const [correctionAmbiguousMode, setCorrectionAmbiguousMode] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Keyed on qa_log length rather than a boolean, so the resume also fires
  // after a rewind truncates the log — not only on the opening turn.
  const autoTurnFor = useRef<number | null>(null);
  const resolveFired = useRef(false);

  const pending = pendingQuestion(game);

  const sendTurn = useCallback(
    async (answer?: ComposerAnswer, ambiguousExplanation?: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/game/${game.game_id}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            answer
              ? { answer, ambiguous_explanation: ambiguousExplanation }
              : {}
          ),
        });
        const data = await res.json();

        if (data.game) {
          setGame(data.game as GameRecord);
        }
        if (!res.ok) {
          setError(data.message || "Something went wrong.");
        }
      } catch {
        setError("Network error — please try again.");
      } finally {
        setBusy(false);
        setAmbiguousMode(false);
        setExplanation("");
      }
    },
    [game.game_id]
  );

  const correctAnswer = useCallback(
    async (turnIndex: number, answer: ComposerAnswer, explanation?: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/game/${game.game_id}/correct`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            turn_index: turnIndex,
            answer,
            ambiguous_explanation: explanation,
            // Optimistic concurrency: refuses if the game moved on meanwhile.
            expected_log_length: game.qa_log.length,
          }),
        });
        const data = await res.json();
        if (data.game) setGame(data.game as GameRecord);
        if (!res.ok) setError(data.message || "Could not correct that answer.");
      } catch {
        setError("Network error — please try again.");
      } finally {
        setBusy(false);
        setCorrecting(null);
        setCorrectionAmbiguousMode(false);
        setCorrectionExplanation("");
      }
    },
    [game.game_id, game.qa_log.length]
  );

  const resolveGame = useCallback(async () => {
    setResolving(true);
    setResolveError(null);
    try {
      const res = await fetch(`/api/game/${game.game_id}/resolve`, { method: "POST" });
      const data = await res.json();
      if (data.game) setGame(data.game as GameRecord);
      if (!res.ok) {
        setResolveError(data.message || "Could not resolve the game.");
        // Allow a retry: the route is idempotent and the phase is unchanged.
        resolveFired.current = false;
      }
    } catch {
      setResolveError("Network error while resolving — please try again.");
      resolveFired.current = false;
    } finally {
      setResolving(false);
    }
  }, [game.game_id]);

  // Resolve as soon as the game reaches "resolving". The ref guards strict-mode
  // double-effect; the route is idempotent regardless, which matters here
  // because each real invocation spends strong-model calls.
  useEffect(() => {
    if (resolveFired.current) return;
    if (game.phase !== "resolving") return;
    resolveFired.current = true;
    void resolveGame();
  }, [game.phase, resolveGame]);

  // Ask the Racer for the next question whenever the game is live and nothing
  // is pending. That covers the opening turn and the resume after a rewind,
  // which leaves exactly the same state: last entry answered, none pending.
  // The ref keys on log length so it fires once per state, and the route's
  // idempotency guard covers every other duplicate path.
  useEffect(() => {
    if (game.phase !== "questioning") return;
    if (pendingQuestion(game)) return;
    if (busy) return;
    if (autoTurnFor.current === game.qa_log.length) return;
    autoTurnFor.current = game.qa_log.length;
    void sendTurn();
  }, [game, busy, sendTurn]);

  const turns = answeredTurns(game);
  const questionsLeft = Math.max(0, game.max_questions - game.question_count);

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
            You are the Composer. Answer honestly.
          </p>
        </div>
        <div className="shrink-0 text-right text-xs text-neutral-400">
          <div>
            {game.question_count} / {game.max_questions} questions used
          </div>
          <div className="text-neutral-600">{questionsLeft} left</div>
          <div className="mt-0.5 text-[10px] text-neutral-700">
            # is the turn number, not the question count
          </div>
        </div>
      </header>

      <section className="flex flex-col gap-4">
        {turns.length === 0 && !pending && (
          <p className="text-sm text-neutral-500">
            {busy ? "The Racer is thinking…" : "Waiting for the Racer's opening question."}
          </p>
        )}

        {turns.map((entry) => (
          <div key={entry.id} className="flex flex-col gap-1.5">
            {entry.turn_type === "question" && entry.question_text && (
              <>
                <div className="flex min-w-0 gap-3">
                  <span className="w-6 shrink-0 pt-0.5 text-xs text-neutral-600 sm:w-8">
                    #{entry.turn_index}
                  </span>
                  <p className="min-w-0 break-words text-sm text-neutral-100">{entry.question_text}</p>
                </div>
                <div className="flex min-w-0 gap-3">
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

                {game.phase === "questioning" && correcting !== entry.turn_index && (
                  <div className="flex min-w-0 gap-3">
                    <span className="w-6 shrink-0 sm:w-8" />
                    <button
                      onClick={() => {
                        setCorrecting(entry.turn_index);
                        setCorrectionAmbiguousMode(false);
                        setCorrectionExplanation(entry.ambiguous_explanation ?? "");
                      }}
                      disabled={busy}
                      className="text-xs text-neutral-600 underline underline-offset-2 disabled:opacity-40"
                    >
                      Correct answer
                    </button>
                  </div>
                )}

                {correcting === entry.turn_index && (
                  <div className="flex min-w-0 gap-3">
                    <span className="w-6 shrink-0 sm:w-8" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-md border border-neutral-700 bg-neutral-900/60 p-3">
                      <p className="text-xs text-neutral-400">
                        {discardCount(game, entry.turn_index) > 0 ? (
                          <>
                            Correcting this rewinds the game to turn {entry.turn_index} and
                            discards the {discardCount(game, entry.turn_index)} turns after
                            it. Questions used since then are given back.
                          </>
                        ) : (
                          <>Replace your answer to this question.</>
                        )}
                      </p>
                      {!correctionAmbiguousMode ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => void correctAnswer(entry.turn_index, "YES")}
                            disabled={busy}
                            className="min-h-11 flex-1 rounded-md bg-emerald-900/60 px-3 py-2.5 text-sm font-medium text-emerald-100 disabled:opacity-40 sm:flex-none"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => void correctAnswer(entry.turn_index, "NO")}
                            disabled={busy}
                            className="min-h-11 flex-1 rounded-md bg-red-900/60 px-3 py-2.5 text-sm font-medium text-red-100 disabled:opacity-40 sm:flex-none"
                          >
                            No
                          </button>
                          <button
                            onClick={() => setCorrectionAmbiguousMode(true)}
                            disabled={busy}
                            className="min-h-11 flex-1 rounded-md border border-amber-800 px-3 py-2.5 text-sm font-medium text-amber-200 disabled:opacity-40 sm:flex-none"
                          >
                            Ambiguous
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <p className="text-xs text-neutral-400">
                            Say why a straight yes or no would mislead. Optional. The
                            Racer sees this note.
                          </p>
                          <textarea
                            className="h-20 w-full min-w-0 resize-none rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
                            value={correctionExplanation}
                            onChange={(e) => setCorrectionExplanation(e.target.value)}
                            placeholder="e.g. it depends on whether you count the handle as part of it"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() =>
                                void correctAnswer(
                                  entry.turn_index,
                                  "AMBIGUOUS",
                                  correctionExplanation
                                )
                              }
                              disabled={busy}
                              className="min-h-11 rounded-md bg-amber-900/60 px-4 py-2.5 text-sm font-medium text-amber-100 disabled:opacity-40"
                            >
                              Send ambiguous
                            </button>
                            <button
                              onClick={() => setCorrectionAmbiguousMode(false)}
                              disabled={busy}
                              className="min-h-11 rounded-md border border-neutral-700 px-4 py-2.5 text-sm text-neutral-300"
                            >
                              Back
                            </button>
                          </div>
                        </div>
                      )}
                      <button
                        onClick={() => {
                          setCorrecting(null);
                          setCorrectionAmbiguousMode(false);
                          setCorrectionExplanation("");
                        }}
                        disabled={busy}
                        className="self-start text-xs text-neutral-500 underline underline-offset-2"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {entry.turn_type === "guess" && (
              <div className="rounded-md border border-neutral-700 bg-neutral-900 p-3">
                <p className="text-xs uppercase tracking-wide text-neutral-500">
                  The Racer guesses
                </p>
                <p className="mt-1 break-words text-sm text-neutral-100">{entry.guess_text}</p>
              </div>
            )}

            {entry.turn_type === "concede" && (
              <div className="rounded-md border border-neutral-700 bg-neutral-900 p-3">
                <p className="text-sm text-neutral-300">The Racer concedes.</p>
              </div>
            )}
          </div>
        ))}

        {pending && pending.question_text && (
          <div className="flex flex-col gap-3 rounded-md border border-neutral-700 bg-neutral-900/60 p-4">
            <div className="flex min-w-0 gap-3">
              <span className="w-6 shrink-0 pt-0.5 text-xs text-neutral-600 sm:w-8">
                #{pending.turn_index}
              </span>
              <p className="min-w-0 break-words text-sm text-neutral-100">{pending.question_text}</p>
            </div>

            {!ambiguousMode ? (
              <div className="flex flex-wrap gap-2 sm:pl-11">
                <button
                  onClick={() => void sendTurn("YES")}
                  disabled={busy}
                  className="min-h-11 flex-1 rounded-md bg-emerald-900/60 px-4 py-2.5 text-sm font-medium text-emerald-100 disabled:opacity-40 sm:flex-none"
                >
                  Yes
                </button>
                <button
                  onClick={() => void sendTurn("NO")}
                  disabled={busy}
                  className="min-h-11 flex-1 rounded-md bg-red-900/60 px-4 py-2.5 text-sm font-medium text-red-100 disabled:opacity-40 sm:flex-none"
                >
                  No
                </button>
                <button
                  onClick={() => setAmbiguousMode(true)}
                  disabled={busy}
                  className="min-h-11 flex-1 rounded-md border border-amber-800 px-4 py-2.5 text-sm font-medium text-amber-200 disabled:opacity-40 sm:flex-none"
                >
                  Ambiguous
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:pl-11">
                <p className="text-xs text-neutral-400">
                  Say why a straight yes or no would mislead. The Racer sees this note.
                </p>
                <textarea
                  className="h-20 w-full min-w-0 resize-none rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  placeholder="e.g. it depends on whether you count the handle as part of it"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => void sendTurn("AMBIGUOUS", explanation)}
                    disabled={busy}
                    className="min-h-11 rounded-md bg-amber-900/60 px-4 py-2.5 text-sm font-medium text-amber-100 disabled:opacity-40"
                  >
                    Send ambiguous
                  </button>
                  <button
                    onClick={() => {
                      setAmbiguousMode(false);
                      setExplanation("");
                    }}
                    disabled={busy}
                    className="min-h-11 rounded-md border border-neutral-700 px-4 py-2.5 text-sm text-neutral-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

          </div>
        )}

        {busy && pending && (
          <p className="text-sm text-neutral-500">The Racer is thinking…</p>
        )}
      </section>

      {(game.phase === "resolving" || game.phase === "complete") && (
        <ResultPanel
          game={game}
          resolving={resolving}
          error={resolveError}
          onRetry={() => void resolveGame()}
        />
      )}

      {error && (
        <div className="rounded-md border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-200">{error}</p>
        </div>
      )}
    </main>
  );
}
