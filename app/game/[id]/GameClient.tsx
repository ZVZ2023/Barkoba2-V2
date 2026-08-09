"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerAnswer, GameRecord, QuestionLogEntry } from "@/lib/types";
import ResultPanel from "./ResultPanel";
import EvaluationState from "@/app/components/EvaluationState";

interface Props {
  initialGame: GameRecord;
  versionLabel: string;
}

/** Stored values stay YES/NO/AMBIGUOUS; only the display is Hungarian. */
const ANSWER_HU: Record<string, string> = {
  YES: "IGEN",
  NO: "NEM",
  AMBIGUOUS: "IS-IS",
};

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
          setError(data.message || "Valami hiba történt.");
        }
      } catch {
        setError("Hálózati hiba — próbáld újra.");
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
        if (!res.ok) setError(data.message || "Nem sikerült javítani a választ.");
      } catch {
        setError("Hálózati hiba — próbáld újra.");
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
        setResolveError(data.message || "Nem sikerült lezárni a játékot.");
        // Allow a retry: the route is idempotent and the phase is unchanged.
        resolveFired.current = false;
      }
    } catch {
      setResolveError("Hálózati hiba a lezárásnál — próbáld újra.");
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
      <header className="flex items-center justify-between gap-3 border-b border-[var(--ink)]/10 pb-3">
        <a href="/" className="flex min-w-0 items-center gap-2" aria-label="Barkóba főoldal">
          <span
            aria-hidden="true"
            className="inline-block h-6 w-6 shrink-0 rounded-full border-[3px] border-[var(--ink)]/80"
            style={{ borderRightColor: "transparent" }}
          />
          <span className="truncate text-base font-semibold tracking-tight">Barkóba</span>
        </a>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold tabular-nums">
            {game.question_count} / {game.max_questions}
          </div>
          <div className="text-xs text-[var(--ink-soft)]">{questionsLeft} maradt</div>
        </div>
      </header>

      <p className="-mt-2 text-sm text-[var(--ink-soft)]">
        <span className="font-medium text-[var(--ink)]">Te gondoltál valamire. Az AI kérdez.</span>
      </p>

      <section className="flex flex-col gap-4">
        {turns.length === 0 && !pending && (
          <p className="text-sm text-[var(--ink-soft)]">
            {busy ? "Az AI gondolkodik…" : "Várjuk az AI első kérdését."}
          </p>
        )}

        {turns.map((entry) => (
          <div key={entry.id} className="flex flex-col gap-1.5">
            {entry.turn_type === "question" && entry.question_text && (
              <>
                <div className="flex min-w-0 gap-3">
                  <span className="w-6 shrink-0 pt-0.5 text-xs text-[var(--ink-soft)] sm:w-8">
                    #{entry.turn_index}
                  </span>
                  <p className="min-w-0 break-words text-sm text-[var(--ink)]">{entry.question_text}</p>
                </div>
                <div className="flex min-w-0 gap-3">
                  <span className="w-6 shrink-0 sm:w-8" />
                  <span
                    className={
                      entry.composer_response === "YES"
                        ? "text-xs font-medium text-[var(--green)]"
                        : entry.composer_response === "NO"
                          ? "text-xs font-medium text-[var(--red)]"
                          : "text-xs font-medium text-[var(--red)]"
                    }
                  >
                    {ANSWER_HU[entry.composer_response ?? ""] ?? entry.composer_response}
                  </span>
                </div>
                {entry.ambiguous_explanation && (
                  <div className="flex min-w-0 gap-3">
                    <span className="w-6 shrink-0 sm:w-8" />
                    <p className="min-w-0 break-words text-xs italic text-[var(--ink-soft)]">
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
                      className="text-xs text-[var(--ink-soft)] underline underline-offset-2 disabled:opacity-40"
                    >
                      Válasz javítása
                    </button>
                  </div>
                )}

                {correcting === entry.turn_index && (
                  <div className="flex min-w-0 gap-3">
                    <span className="w-6 shrink-0 sm:w-8" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-md border border-[var(--ink)]/25 bg-white/60 p-3">
                      <p className="text-xs text-[var(--ink-soft)]">
                        {discardCount(game, entry.turn_index) > 0 ? (
                          <>
                            A javítás visszaállítja a játékot a(z) {entry.turn_index}. körre,
                            és eldobja az utána következő {discardCount(game, entry.turn_index)} kört.
                            Az azóta felhasznált kérdéseket visszakapod.
                          </>
                        ) : (
                          <>Cseréld le a válaszod erre a kérdésre.</>
                        )}
                      </p>
                      {!correctionAmbiguousMode ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => void correctAnswer(entry.turn_index, "YES")}
                            disabled={busy}
                            className="min-h-11 flex-1 rounded-md bg-[var(--green)] px-3 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40 sm:flex-none"
                          >
                            IGEN
                          </button>
                          <button
                            onClick={() => void correctAnswer(entry.turn_index, "NO")}
                            disabled={busy}
                            className="min-h-11 flex-1 rounded-md bg-[var(--red)] px-3 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40 sm:flex-none"
                          >
                            NEM
                          </button>
                          <button
                            onClick={() => setCorrectionAmbiguousMode(true)}
                            disabled={busy}
                            className="min-h-11 flex-1 rounded-md border border-[var(--red)]/45 px-3 py-2.5 text-sm font-medium text-[var(--ink)] disabled:opacity-40 sm:flex-none"
                          >
                            IS-IS
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <p className="text-xs text-[var(--ink-soft)]">
                            Say why a straight yes or no would mislead. Optional. The
                            Racer sees this note.
                          </p>
                          <textarea
                            spellCheck
                            autoCorrect="on"
                            autoCapitalize="sentences"
                            className="h-20 w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
                            value={correctionExplanation}
                            onChange={(e) => setCorrectionExplanation(e.target.value)}
                            placeholder="pl. attól függ, beleszámít-e a fogantyú"
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
                              className="min-h-12 rounded-md bg-[var(--green)] px-5 py-3 text-base font-semibold text-[var(--parchment)] disabled:opacity-40"
                            >
                              IS-IS küldése
                            </button>
                            <button
                              onClick={() => setCorrectionAmbiguousMode(false)}
                              disabled={busy}
                              className="min-h-11 rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm text-[var(--ink)]"
                            >
                              Vissza
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
                        className="self-start text-xs text-[var(--ink-soft)] underline underline-offset-2"
                      >
                        Mégsem
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {entry.turn_type === "guess" && (
              <div className="rounded-md border border-[var(--ink)]/25 bg-white/70 p-3">
                <p className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">
                  Az AI tippje
                </p>
                <p className="mt-1 break-words text-sm text-[var(--ink)]">{entry.guess_text}</p>
              </div>
            )}

            {entry.turn_type === "concede" && (
              <div className="rounded-md border border-[var(--ink)]/25 bg-white/70 p-3">
                <p className="text-sm text-[var(--ink)]">Az AI feladta.</p>
              </div>
            )}
          </div>
        ))}

        {pending && pending.question_text && (
          <div className="flex flex-col gap-3 rounded-md border border-[var(--ink)]/25 bg-white/60 p-4">
            <div className="flex min-w-0 gap-3">
              <span className="w-6 shrink-0 pt-0.5 text-xs text-[var(--ink-soft)] sm:w-8">
                #{pending.turn_index}
              </span>
              <p className="min-w-0 break-words text-sm text-[var(--ink)]">{pending.question_text}</p>
            </div>

            {!ambiguousMode ? (
              <div className="flex flex-wrap gap-2 sm:pl-11">
                <button
                  onClick={() => void sendTurn("YES")}
                  disabled={busy}
                  className="min-h-11 flex-1 rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40 sm:flex-none"
                >
                  IGEN
                </button>
                <button
                  onClick={() => void sendTurn("NO")}
                  disabled={busy}
                  className="min-h-11 flex-1 rounded-md bg-[var(--red)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40 sm:flex-none"
                >
                  NEM
                </button>
                <button
                  onClick={() => setAmbiguousMode(true)}
                  disabled={busy}
                  className="min-h-11 flex-1 rounded-md border border-[var(--red)]/45 px-4 py-2.5 text-sm font-medium text-[var(--ink)] disabled:opacity-40 sm:flex-none"
                >
                  IS-IS
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:pl-11">
                <p className="text-xs text-[var(--ink-soft)]">
                  IS-IS: sem az IGEN, sem a NEM nem lenne pontos pontosítás nélkül. Írd le, miért — az AI látja ezt a megjegyzést. Kitöltése nem kötelező.
                </p>
                <textarea
                  spellCheck
                  autoCorrect="on"
                  autoCapitalize="sentences"
                  className="h-20 w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  placeholder="pl. attól függ, beleszámít-e a fogantyú"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => void sendTurn("AMBIGUOUS", explanation)}
                    disabled={busy}
                    className="min-h-12 flex-1 rounded-md bg-[var(--green)] px-5 py-3 text-base font-semibold text-[var(--parchment)] shadow-sm disabled:opacity-40 sm:flex-none"
                  >
                    IS-IS küldése
                  </button>
                  <button
                    onClick={() => {
                      setAmbiguousMode(false);
                      setExplanation("");
                    }}
                    disabled={busy}
                    className="min-h-11 rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm text-[var(--ink)]"
                  >
                    Mégsem
                  </button>
                </div>
              </div>
            )}

          </div>
        )}

        {busy && pending && (
          <p className="text-sm text-[var(--ink-soft)]">Az AI gondolkodik…</p>
        )}
      </section>

      {game.phase === "resolving" && (
        <EvaluationState error={resolveError} busy={resolving} onRetry={() => void resolveGame()} />
      )}

      {game.phase === "complete" && (
        <ResultPanel
          game={game}
          resolving={resolving}
          error={resolveError}
          onRetry={() => void resolveGame()}
        />
      )}

      {error && (
        <div className="rounded-md border border-[var(--red)]/35 bg-[var(--red)]/8 p-3">
          <p className="text-sm text-[var(--red)]">{error}</p>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <a
          href="/"
          className="inline-flex min-h-11 items-center text-sm text-[var(--ink-soft)] underline-offset-2 hover:underline"
        >
          ← Vissza a Barkóba főoldalra
        </a>
        <span className="text-xs text-[var(--ink-soft)]" title="Telepített Barkóba verzió">
          {versionLabel}
        </span>
      </div>
    </main>
  );
}
