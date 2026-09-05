"use client";

import PostGameRegisterCTA from "@/app/components/PostGameRegisterCTA";
import { useCallback, useEffect, useRef, useState } from "react";
import { clueCreditsAvailable, cluesEnabled } from "@/lib/clueCredits";
import { completedHistoryForDisplay } from "@/lib/gameHistoryOrder";
import { questionNumbers } from "@/lib/questionNumbers";
import type { GameView } from "@/lib/gameView";
import type { GameRecord, QuestionLogEntry } from "@/lib/types";
import EvaluationState from "@/app/components/EvaluationState";
import { useResultReveal } from "@/app/components/useResultReveal";
import {
  ASK_CLIENT_TIMEOUT_MS,
  CLUE_CLIENT_TIMEOUT_MS,
  createRequestOwnership,
  mergeViewIntoGame,
  reconciliationShowsProgress,
  runOwnedTurnRequest,
  type ActiveRequestHandle,
  type RequestOwnership,
  type TurnResponseBody,
} from "@/lib/turnRequestGuard";
import { shouldReconcileStaleRequestOnForeground } from "@/lib/turnRecovery";

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
  // V2.8.7.3 — auto-reveal the terminal result on this screen too: the SAME
  // shared hook GameClient.tsx and HumanClient.tsx call (see
  // app/components/useResultReveal.ts). Before this, this screen had no
  // reveal mechanism at all — a player scrolled deep into a long game had
  // to find the result manually, the same field gap V2.8.7.2 left unfixed
  // here.
  const { headerRef, headingRef: resultHeadingRef } = useResultReveal(game.phase);
  // V2.8.6 R2 — required by TurnRequestState but with no auto-retry loop on
  // this screen (every RacerClient action is human-initiated; there is no
  // auto-turn effect to suspend). Plain refs, not React state: nothing here
  // renders differently based on either value, so there is nothing for a
  // re-render to accomplish — see runOwnedTurnRequest's own doc for what
  // each callback means.
  const turnFailedRef = useRef(false);
  const turnInProgressRef = useRef(false);

  // V2.8.6 R2 — request ownership + canonical-truth reconciliation, reused
  // from lib/turnRequestGuard.ts unchanged (see its module doc — the same
  // fix GameClient.sendTurn already carries). ONE shared tracker for send()
  // and askForClue(): both buttons are visible and tappable in the same
  // instant on this screen (unlike GameClient, where the clue-request panel
  // and the answer panel are mutually exclusive render branches) and both
  // routes acquire the SAME per-game server lock (see /ask's and /clue's own
  // lock-sharing comments) — so client-side they are correctly treated as
  // one action stream, not two independently-racing ones.
  const requestOwnershipRef = useRef<RequestOwnership | null>(null);
  if (!requestOwnershipRef.current) {
    requestOwnershipRef.current = createRequestOwnership();
  }
  const gameRef = useRef(game);
  useEffect(() => {
    gameRef.current = game;
  }, [game]);
  const activeRequestRef = useRef<ActiveRequestHandle | null>(null);
  // V2.8.6 R2 (D) — synchronous submission guard, claimed before any await,
  // mirroring GameClient's answerInFlightRef: a plain ref update is
  // synchronous, unlike React state, so checking it FIRST closes the exact
  // window a double-tap or duplicate event needs, before `disabled={busy}`
  // has had a chance to commit.
  const actionInFlightRef = useRef(false);

  // SÚGÓ. Derived from the record on every render, so the control cannot
  // disagree with what the server will allow.
  const clueOn = cluesEnabled(game);
  const cluesLeft = clueCreditsAvailable(game);

  // V2.8.6 R2 — reuses the SAME shared requestOwnershipRef/actionInFlightRef/
  // activeRequestRef as send(), not a second independent set: /clue and /ask
  // acquire the SAME server-side per-game lock (see /clue's own comment on
  // why), and both buttons are visible and tappable in the same instant on
  // this screen — see the mutex's own doc above send().
  const askForClue = useCallback(async () => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    try {
      await runOwnedTurnRequest(
        requestOwnershipRef.current as RequestOwnership,
        {
          requestTurn: async (signal) => {
            const res = await fetch(`/api/game/${gameRef.current.game_id}/clue`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ expected_revision: gameRef.current.revision }),
              signal,
            });
            const data = (await res.json()) as TurnResponseBody;
            return { ok: res.ok, data };
          },
          requestView: async () => {
            const res = await fetch(`/api/game/${gameRef.current.game_id}/view`);
            const viewBody = (await res.json()) as { view?: GameView };
            return { ok: res.ok, view: viewBody.view ?? null };
          },
        },
        {
          getGame: () => gameRef.current,
          setGame,
          setError,
          setTurnFailed: (failed) => {
            turnFailedRef.current = failed;
          },
          setBusy,
          setAmbiguousMode: () => {},
          setExplanation: () => {},
          clearAutoTurnGuard: () => {},
          setTurnInProgress: (inProgress) => {
            turnInProgressRef.current = inProgress;
          },
          registerActiveRequest: (handle) => {
            activeRequestRef.current = handle;
          },
          clearActiveRequest: () => {
            activeRequestRef.current = null;
          },
        },
        CLUE_CLIENT_TIMEOUT_MS
      );
    } finally {
      actionInFlightRef.current = false;
    }
  }, []);

  // V2.8.6 R2 — this function used to be a plain fetch/setState wrapper,
  // exactly the shape lib/turnRequestGuard.ts's own module doc describes as
  // the defect GameClient.sendTurn had. It is now a thin transport/state
  // adapter over runOwnedTurnRequest: request ownership (a superseded call's
  // late success/failure/finally can never overwrite what a newer one
  // already established), a bounded wait (ASK_CLIENT_TIMEOUT_MS, matching
  // /ask's own maxDuration/lock-TTL numbers), and canonical-truth
  // reconciliation on an uncertain transport failure (one GET /view read,
  // never a second /ask call) all live in that shared, tested module.
  const send = useCallback(
    async (body: Record<string, unknown>) => {
      // (D) synchronous guard — see actionInFlightRef's own doc above.
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      // V2.8.6 R2 — captured by requestTurn below, read by setGame. `true`
      // only for a direct, known-successful HTTP response (mirrors the
      // original's own "res.ok" gate for clearing the compose fields — a
      // documented rejection like edit_changes_intent still bumps the CAS
      // revision by recording the rejection, so revision-based progress
      // alone is not the right signal here). Stays `null` when the primary
      // request never resolved at all (thrown/aborted), which is exactly
      // when reconciliation's OWN progress check below is the only signal
      // available — the "server saved it but the response was lost" case.
      let attemptOk: boolean | null = null;
      try {
        await runOwnedTurnRequest(
          requestOwnershipRef.current as RequestOwnership,
          {
            requestTurn: async (signal) => {
              const res = await fetch(`/api/game/${gameRef.current.game_id}/ask`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ...body,
                  // V2.8.6 R2 — the My Car Key invariant, extended to /ask.
                  // Every action this function submits mutates, so the
                  // current real revision always rides along.
                  expected_revision: gameRef.current.revision,
                }),
                signal,
              });
              attemptOk = res.ok;
              const data = (await res.json()) as TurnResponseBody;
              return { ok: res.ok, data };
            },
            requestView: async () => {
              const res = await fetch(`/api/game/${gameRef.current.game_id}/view`);
              const viewBody = (await res.json()) as { view?: GameView };
              return { ok: res.ok, view: viewBody.view ?? null };
            },
          },
          {
            getGame: () => gameRef.current,
            setGame: (next) => {
              // V2.8.6 R2 — clear the compose fields on a direct success, or
              // when a lost-response reconciliation shows the attempt
              // genuinely landed (reconciliationShowsProgress) — but never
              // on a direct, known failure (attemptOk === false), even one
              // that itself advanced the CAS revision (e.g. a recorded
              // edit_changes_intent rejection): the player still has the
              // rejection reason on screen and should not lose their draft.
              const shouldClear =
                attemptOk === true ||
                (attemptOk === null && reconciliationShowsProgress(gameRef.current, next));
              if (shouldClear) {
                setQuestion("");
                setGuess("");
                setGuessMode(false);
                setEditing(null);
                setEditText("");
              }
              setGame(next);
            },
            setError,
            setTurnFailed: (failed) => {
              turnFailedRef.current = failed;
            },
            setBusy,
            // RacerClient has no ambiguous-answer or "+1" sandbox-clarification
            // UI (those are GameClient/human-Composer concepts) — harmless no-ops.
            setAmbiguousMode: () => {},
            setExplanation: () => {},
            clearAutoTurnGuard: () => {},
            setTurnInProgress: (inProgress) => {
              turnInProgressRef.current = inProgress;
            },
            registerActiveRequest: (handle) => {
              activeRequestRef.current = handle;
            },
            clearActiveRequest: () => {
              activeRequestRef.current = null;
            },
          },
          ASK_CLIENT_TIMEOUT_MS
        );
      } finally {
        // (D) released only once the owned request has fully reached its
        // terminal/reconciled state.
        actionInFlightRef.current = false;
      }
    },
    []
  );

  // V2.8.6 R2 — foreground reconciliation, mirroring GameClient's own
  // visibilitychange handler (see lib/turnRequestGuard.ts's
  // CLIENT_TURN_TIMEOUT_MS doc for the "silent stall" forensic this pattern
  // repairs). A busy request already within its legitimate window is left
  // alone; a STALE one is aborted directly, driving it down
  // runOwnedTurnRequest's own existing abort→reconcile path. When nothing is
  // busy, an opportunistic canonical read applies only if it shows genuine
  // progress.
  //
  // ASK_CLIENT_TIMEOUT_MS (120s), not CLUE_CLIENT_TIMEOUT_MS (90s), even
  // though activeRequestRef is shared by both send() and askForClue(): the
  // handle itself does not say which route it belongs to, and using the
  // LARGER of the two here is conservative in the safe direction — a
  // genuinely stale /clue request is still caught, at most ~30s later than
  // its own internal timeoutMs would have caught it anyway (that internal
  // timer keeps running regardless of this handler).
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState !== "visible") return;
      if (busy) {
        const active = activeRequestRef.current;
        if (
          !shouldReconcileStaleRequestOnForeground({
            busy,
            activeRequestStartedAt: active?.startedAt ?? null,
            now: Date.now(),
            timeoutMs: ASK_CLIENT_TIMEOUT_MS,
          })
        ) {
          return;
        }
        active?.abort();
        return;
      }
      void (async () => {
        try {
          const res = await fetch(`/api/game/${gameRef.current.game_id}/view`);
          const body = (await res.json()) as { view?: GameView };
          if (!res.ok || !body.view) return;
          const before = gameRef.current;
          const reconciled = mergeViewIntoGame(before, body.view);
          if (reconciliationShowsProgress(before, reconciled)) {
            setGame(reconciled);
            setError(null);
            turnFailedRef.current = false;
          }
        } catch {
          // Best-effort background refresh, not a user action — silent.
        }
      })();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [busy]);

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
  // Displayed question numbers count questions only, so the transcript agrees
  // with the header counter even after a clue has taken a turn slot.
  const numbers = questionNumbers(game.qa_log);
  const turns = [...answeredTurns(game), ...clueTurns(game)].sort(
    (a, b) => a.turn_index - b.turn_index
  );
  const remaining = Math.max(0, game.max_questions - game.question_count);
  const live = game.phase === "questioning";

  return (
    <main className="mx-auto flex w-full min-h-screen max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header
        ref={headerRef}
        className="flex items-center justify-between gap-3 border-b border-[var(--ink)]/10 pb-3"
      >
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

      {/*
        V2.8.7.3 — the result is the PRIMARY visible content on completion:
        it renders here, before the transcript, not after it (the old
        behavior).
      */}
      {game.phase === "complete" && game.result && (
        <section
          className={
            game.result === "racer_correct" || game.result === "racer_win_integrity_violation"
              ? "rounded-md border border-[var(--green)]/30 bg-[var(--green)]/5 p-5"
              : "rounded-md border border-[var(--red)]/30 bg-[var(--red)]/6 p-5"
          }
        >
          {/*
            V2.8.7.3 — ref/tabIndex/outline-none: see ResultPanel.tsx's own
            comment on the identical pattern. tabIndex={-1} makes this a
            valid PROGRAMMATIC focus target (never in the Tab order — only
            useResultReveal's effect ever focuses it); outline-none
            suppresses the default focus ring, which would otherwise read as
            an editable-input affordance on a heading that accepts no input.
          */}
          <h2
            ref={resultHeadingRef}
            tabIndex={-1}
            className="text-lg font-semibold text-[var(--ink)] outline-none"
          >
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
            <PostGameRegisterCTA />

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

      <section className="flex flex-col gap-4">
        {turns.length === 0 && live && (
          <p className="text-sm text-[var(--ink-soft)]">
            Kérdezz bármit, amire igennel vagy nemmel lehet felelni.
          </p>
        )}

        {/*
          V2.8.7.3 — completed history renders NEWEST-first, matching
          GameClient.tsx's own established pattern (lib/gameHistoryOrder.ts's
          completedHistoryForDisplay). `turns` itself (chronological) is
          untouched and remains what the "last turn" edit-button check below
          reads.
        */}
        {completedHistoryForDisplay(turns).map((entry) =>
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
                #{numbers.get(entry.id) ?? entry.turn_index}
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
