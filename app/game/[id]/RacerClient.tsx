"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clueCreditsAvailable, cluesEnabled } from "@/lib/clueCredits";
import type { GameRecord, QuestionLogEntry } from "@/lib/types";
import EvaluationState from "@/app/components/EvaluationState";

/** Stored values stay YES/NO/AMBIGUOUS; only the display is Hungarian. */
const ANSWER_HU: Record<string, string> = {
  YES: "IGEN",
  NO: "NEM",
  AMBIGUOUS: "IS-IS",
};

const DIFFICULTY_HU: Record<string, string> = {
  easy: "könnyű",
  medium: "közepes",
  hard: "nehéz",
};
const CLUE_HU: Record<string, string> = {
  minimal: "minimális",
  progressive: "fokozatos",
};

// The human Racer's screen. Quarantined from secretStore by
// scripts/check-isolation.mjs — it renders only what the server sends, and the
// server never sends the target until the game is complete.

interface Props {
  initialGame: GameRecord;
  versionLabel: string;
}

const RESULT_HEADLINE: Record<string, string> = {
  racer_correct: "Eltaláltad.",
  racer_incorrect: "Nem talált.",
  composer_win_integrity_upheld: "Feladtad.",
  racer_win_integrity_violation: "Neked ítélve — integritás-ellenőrzés.",
};

function clueTurns(game: GameRecord): QuestionLogEntry[] {
  return game.qa_log.filter((e) => e.turn_type === "clue" && e.clue_text);
}

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

  // SÚGÓ. Derived from the record on every render, so the control cannot
  // disagree with what the server will allow.
  const clueOn = cluesEnabled(game);
  const cluesLeft = clueCreditsAvailable(game);

  const askForClue = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/game/${game.game_id}/clue`, { method: "POST" });
      const data = await res.json();
      if (data.game) setGame(data.game as GameRecord);
      if (!res.ok) setError(data.message || "Valami hiba történt.");
    } catch {
      setError("Nem sikerült súgót kérni.");
    } finally {
      setBusy(false);
    }
  }, [game.game_id]);

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
        if (!res.ok) setError(data.message || "Valami hiba történt.");
        else {
          setQuestion("");
          setGuess("");
          setGuessMode(false);
          setEditing(null);
          setEditText("");
        }
      } catch {
        setError("Hálózati hiba — próbáld újra.");
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
        setError(data.message || "Nem sikerült lezárni a játékot.");
        resolveFired.current = false;
      }
    } catch {
      setError("Hálózati hiba a lezárásnál — próbáld újra.");
      resolveFired.current = false;
    } finally {
      setBusy(false);
    }
  }, [game.game_id]);

  useEffect(() => {
    if (resolveFired.current) return;
    if (game.phase !== "resolving") return;
    resolveFired.current = true;
    void resolveGame();
  }, [game.phase, resolveGame]);

  // Questions and clues share one timeline so a clue appears where it happened.
  // A clue that is not visible in the transcript is a clue the player cannot
  // reason about afterwards.
  const turns = [...answeredTurns(game), ...clueTurns(game)].sort(
    (a, b) => a.turn_index - b.turn_index
  );
  const remaining = Math.max(0, game.max_questions - game.question_count);
  const live = game.phase === "questioning";

  return (
    <main className="mx-auto flex w-full min-h-screen max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--ink)]/10 pb-3">
        <div className="flex min-w-0 flex-col">
          <a href="/" className="flex min-w-0 items-center gap-2" aria-label="Barkóba főoldal">
            <span
              aria-hidden="true"
              className="inline-block h-6 w-6 shrink-0 rounded-full border-[3px] border-[var(--ink)]/80"
              style={{ borderRightColor: "transparent" }}
            />
            <span className="truncate text-base font-semibold tracking-tight">Barkóba</span>
          </a>
          {/*
            The version also sits at the very bottom of this screen, which after
            a twenty-question transcript is a scroll hunt. A field tester must
            be able to read the build identity without leaving the first
            viewport, so it lives in the persistent header too. Same single
            source, rendered twice — no second hardcoded string.
          */}
          <span
            className="mt-0.5 text-[11px] tabular-nums text-[var(--ink-soft)]"
            title="Telepített Barkóba verzió"
          >
            {versionLabel}
          </span>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold tabular-nums">
            {game.question_count} / {game.max_questions}
          </div>
          <div className="text-xs text-[var(--ink-soft)]">{remaining} maradt</div>
        </div>
      </header>

      <p className="-mt-2 text-sm text-[var(--ink-soft)]">
        <span className="font-medium text-[var(--ink)]">Az AI gondolt valamire. Te kérdezel.</span>
        {game.difficulty ? ` · ${DIFFICULTY_HU[game.difficulty] ?? game.difficulty}` : ""}
        {game.clue_mode && game.clue_mode !== "none"
          ? ` · ${CLUE_HU[game.clue_mode] ?? game.clue_mode} segítség`
          : ""}
      </p>

      <section className="flex flex-col gap-4">
        {turns.length === 0 && live && (
          <p className="text-sm text-[var(--ink-soft)]">
            Kérdezz bármit, amire igennel vagy nemmel lehet felelni.
          </p>
        )}

        {turns.map((entry) =>
          entry.turn_type === "clue" ? (
            <div
              key={entry.id}
              className="flex flex-col gap-1 rounded-md border border-[var(--blue)]/25 bg-[var(--blue)]/6 px-2.5 py-2"
            >
              <span className="whitespace-nowrap text-xs uppercase tracking-wide text-[var(--blue)]">
                SÚGÓ
              </span>
              <p className="min-w-0 break-words text-sm text-[var(--blue)]">
                {entry.clue_text}
              </p>
            </div>
          ) : (
          <div key={entry.id} className="flex flex-col gap-1.5">
            <div className="flex min-w-0 gap-3">
              <span className="w-6 shrink-0 pt-0.5 text-xs text-[var(--ink-soft)] sm:w-8">
                #{entry.turn_index}
              </span>
              <p className="min-w-0 break-words text-sm text-[var(--ink)]">
                {entry.question_text}
              </p>
            </div>
            <div className="flex gap-3">
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
                    className="text-xs text-[var(--ink-soft)] underline underline-offset-2 disabled:opacity-40"
                  >
                    Elgépelés javítása
                  </button>
                </div>
              )}

            {editing === entry.turn_index && (
              <div className="flex min-w-0 gap-3">
                <span className="w-6 shrink-0 sm:w-8" />
                <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-md border border-[var(--ink)]/25 bg-white/60 p-3">
                  <p className="text-xs text-[var(--ink-soft)]">
                    Elgépelés vagy automatikus javítás helyreállítása. Ugyanaz a
                    kérdés, javított szöveggel — újra megválaszoljuk, és nem kerül
                    újabb kérdésbe. Más kérdéshez új kérdés kell.
                  </p>
                  <textarea
                    spellCheck
                    autoCorrect="on"
                    autoCapitalize="sentences"
                    className="h-20 w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
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
                      className="min-h-11 rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
                    >
                      Javítom
                    </button>
                    <button
                      onClick={() => {
                        setEditing(null);
                        setEditText("");
                      }}
                      disabled={busy}
                      className="min-h-11 rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm text-[var(--ink)]"
                    >
                      Mégsem
                    </button>
                  </div>
                </div>
              </div>
            )}

            {entry.original_question_text && entry.edit_status === "accepted" && (
              <div className="flex min-w-0 gap-3">
                <span className="w-6 shrink-0 sm:w-8" />
                <p className="min-w-0 break-words text-xs text-[var(--ink-soft)]">
                  javítva erről: &bdquo;{entry.original_question_text}&rdquo;
                </p>
              </div>
            )}

            {/*
              A clue no longer rides along with an answer — 0.9.9.0 removed that
              channel. Clues appear as their own timeline entries above.
            */}
          </div>
          )
        )}

        {busy && <p className="text-sm text-[var(--ink-soft)]">Gondolkodik…</p>}

        {live && !guessMode && (
          <div className="flex flex-col gap-2">
            {remaining > 0 ? (
              <>
                <textarea
                  spellCheck
                  autoCorrect="on"
                  autoCapitalize="sentences"
                  className="h-20 w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="pl. Fizikai tárgy?"
                  disabled={busy}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => void send({ question })}
                    disabled={busy || !question.trim()}
                    className="min-h-11 flex-1 rounded-md bg-[var(--green)] px-3 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
                  >
                    Kérdezek
                  </button>
                  {clueOn && (
                    <button
                      onClick={() => void askForClue()}
                      disabled={busy || cluesLeft < 1}
                      title={
                        cluesLeft > 0
                          ? `${cluesLeft} súgó áll rendelkezésedre`
                          : "Még nincs súgód"
                      }
                      className="min-h-11 flex-1 rounded-md border border-[var(--blue)]/50 px-3 py-2.5 text-sm font-medium text-[var(--blue)] disabled:opacity-30"
                    >
                      Súgó
                    </button>
                  )}
                  <button
                    onClick={() => setGuessMode(true)}
                    disabled={busy}
                    className="min-h-11 flex-1 rounded-md border border-[var(--red)]/60 px-3 py-2.5 text-sm font-medium text-[var(--red)] disabled:opacity-40"
                  >
                    Tippelek
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-2 rounded-md border border-[var(--red)]/30 bg-[var(--red)]/6 p-3">
                <p className="text-sm text-[var(--ink)]">
                  Elfogytak a kérdések. Ideje tippelni.
                </p>
                {/*
                  A credit earned by the LAST question is still spendable. SÚGÓ
                  rewards the deduction, so answering question 20 of 20 earns a
                  clue that may be used before the final guess — the guess is
                  what closes the door, not the question budget.
                */}
                <div className="flex gap-2">
                  {clueOn && cluesLeft > 0 && (
                    <button
                      onClick={() => void askForClue()}
                      disabled={busy}
                      title={`${cluesLeft} súgó áll rendelkezésedre`}
                      className="min-h-11 flex-1 rounded-md border border-[var(--blue)]/50 px-3 py-2.5 text-sm font-medium text-[var(--blue)] disabled:opacity-30"
                    >
                      Súgó
                    </button>
                  )}
                  <button
                    onClick={() => setGuessMode(true)}
                    disabled={busy}
                    className="min-h-11 flex-1 rounded-md bg-[var(--red)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
                  >
                    Tippelek
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {live && guessMode && (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--green)]/30 bg-[var(--green)]/5 p-4">
            <p className="text-sm text-[var(--green)]">Egyetlen tipped van.</p>
            <input
              spellCheck
              autoCorrect="on"
              autoCapitalize="sentences"
              className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              placeholder="Írd le, mire gondolt"
              disabled={busy}
            />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void send({ guess })}
                disabled={busy || !guess.trim()}
                className="min-h-11 rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
              >
                Tipp véglegesítése
              </button>
              <button
                onClick={() => setGuessMode(false)}
                disabled={busy}
                className="min-h-11 rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm text-[var(--ink)]"
              >
                Vissza
              </button>
              <button
                onClick={() => void send({ concede: true })}
                disabled={busy}
                className="min-h-11 rounded-md border border-[var(--ink)]/15 px-4 py-2.5 text-sm text-[var(--ink-soft)]"
              >
                Feladom
              </button>
            </div>
          </div>
        )}
      </section>

      {game.phase === "resolving" && (
        <EvaluationState error={error} busy={busy} onRetry={() => void resolveGame()} />
      )}

      {game.phase === "complete" && game.result && (
        <section
          className={
            game.result === "racer_correct" || game.result === "racer_win_integrity_violation"
              ? "rounded-md border border-[var(--green)]/30 bg-[var(--green)]/5 p-5"
              : "rounded-md border border-[var(--red)]/30 bg-[var(--red)]/6 p-5"
          }
        >
          <h2 className="text-lg font-semibold text-[var(--ink)]">
            {RESULT_HEADLINE[game.result] ?? "A játék véget ért."}
          </h2>
          <dl className="mt-4 flex flex-col gap-3 border-t border-[var(--ink)]/15 pt-4 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">
                A megfejtés
              </dt>
              <dd className="mt-0.5 break-words text-[var(--ink)]">
                {game.revealed_target}
              </dd>
            </div>
            {game.final_guess_text && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">
                  A tipped
                </dt>
                <dd className="mt-0.5 break-words text-[var(--ink)]">
                  {game.final_guess_text}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">
                Felhasznált kérdés
              </dt>
              <dd className="mt-0.5 text-[var(--ink)]">
                {game.question_count} / {game.max_questions}
              </dd>
            </div>
            {game.adjudication_notes && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">
                  Értékelés
                </dt>
                <dd className="mt-0.5 break-words text-[var(--ink)]">
                  {game.adjudication_notes}
                </dd>
              </div>
            )}
          </dl>
          {game.private_target && (
            <p className="mt-4 rounded-md border border-[var(--ink)]/15 bg-white/70 p-3 text-xs text-[var(--ink-soft)]">
              Személyes titok volt: az értékelés a játék során megadott
              információk alapján készült, nem független ellenőrzéssel.
            </p>
          )}

          <a
            href="/"
            className="mt-5 inline-block min-h-11 rounded-md bg-[var(--green)] px-5 py-3 text-sm font-medium text-[var(--parchment)]"
          >
            Új játék
          </a>
        </section>
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
