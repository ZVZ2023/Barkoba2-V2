"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerGameView, GameView } from "@/lib/gameView";
import type { ComposerAnswer } from "@/lib/types";

// ---------------------------------------------------------------------------
// V2.3 — the Human↔Human screen. One component, both seats.
//
// It renders from the SERVER'S projection, never from a local GameRecord. That
// is the point: `your_turn` and `seat` are decided server-side, so a stale tab
// cannot offer a control that submits a turn the server will reject.
//
// Polling, not WebSockets. Barkóba is turn-alternating with think-time in tens
// of seconds; a 2.5s poll is inside the game's own tempo and needs no stateful
// connection in a stateless deployment. It stops while it is this player's turn
// and once the game is over — there is nothing to learn from the server then.
// ---------------------------------------------------------------------------

const POLL_MS = 2500;

type AnyView = GameView | ComposerGameView;

function isComposerView(v: AnyView): v is ComposerGameView {
  return v.seat === "composer" && "secret" in v;
}

export default function HumanClient({
  initialView,
  versionLabel,
}: {
  initialView: AnyView;
  versionLabel: string;
}) {
  const [view, setView] = useState<AnyView>(initialView);
  const [question, setQuestion] = useState("");
  const [guess, setGuess] = useState("");
  const [explanation, setExplanation] = useState("");
  const [guessMode, setGuessMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const resolving = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/game/${view.game_id}/view`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.view) setView(data.view as AnyView);
    } catch {
      // A dropped poll is not an error the player needs to see; the next one
      // will pick the state back up. Backgrounding a tab does exactly this.
    }
  }, [view.game_id]);

  // One fetch on mount, always. The server component hands over the shared,
  // target-free projection, so this is what delivers the Composer their own
  // secret and their invitation link — and it is also what makes a refresh or a
  // returning background tab converge on server truth immediately.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while waiting on the opponent.
  useEffect(() => {
    const over = view.phase === "complete";
    const waiting = !view.your_turn || view.awaiting_racer;
    if (over || !waiting) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [view.your_turn, view.awaiting_racer, view.phase, refresh]);

  // Either seat may drive resolution; /resolve is idempotent once complete.
  useEffect(() => {
    if (view.phase !== "resolving" || resolving.current) return;
    resolving.current = true;
    (async () => {
      try {
        await fetch(`/api/game/${view.game_id}/resolve`, { method: "POST" });
      } finally {
        await refresh();
        resolving.current = false;
      }
    })();
  }, [view.phase, view.game_id, refresh]);

  const send = useCallback(
    async (payload: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/game/${view.game_id}/hh/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, expected_revision: view.revision }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setError(data?.message || "Nem sikerült elküldeni. Próbáld újra.");
        await refresh();
      } catch {
        setError("Hálózati hiba — próbáld újra.");
      } finally {
        setBusy(false);
      }
    },
    [view.game_id, view.revision, refresh]
  );

  const answer = (a: ComposerAnswer) =>
    void send({ action: "answer", answer: a, ambiguous_explanation: explanation });

  // Only ever present on a Composer view — no Racer payload carries it.
  const code = isComposerView(view) ? view.join_code : null;
  const inviteUrl =
    typeof window !== "undefined" && code ? `${window.location.origin}/join/${code}` : null;

  const over = view.phase === "complete";
  const live = view.phase === "questioning" && !view.awaiting_racer;
  const iAmComposer = view.seat === "composer";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <header className="flex items-baseline justify-between border-b border-neutral-900/10 pb-2">
        <div>
          <span className="font-semibold">Barkóba</span>
          <span className="ml-2 text-sm text-neutral-600">
            {iAmComposer ? "Te vagy a gondolkodó" : "Te kérdezel"}
          </span>
        </div>
        <span className="text-xs text-neutral-600">{versionLabel}</span>
      </header>

      <div className="flex items-center justify-between text-sm text-neutral-700">
        <span>
          {view.question_count} / {view.max_questions} kérdés
        </span>
        {!over && !view.awaiting_racer && (
          <span className={view.your_turn ? "font-semibold text-[#1e3a24]" : "text-neutral-500"}>
            {view.your_turn ? "Te jössz" : "A másik játékos jön…"}
          </span>
        )}
      </div>

      {/* The Composer's own secret. Never present in a Racer payload. */}
      {isComposerView(view) && !over && (
        <div className="rounded-md border border-[#1e3a24]/25 bg-[#1e3a24]/5 p-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-neutral-600">A te titkod</div>
          <div className="text-base font-semibold">{view.secret.target}</div>
          {view.secret.definition && (
            <div className="mt-1 text-neutral-700">{view.secret.definition}</div>
          )}
        </div>
      )}

      {view.awaiting_racer && (
        <div className="rounded-md border border-neutral-900/15 bg-white/60 p-4 text-sm">
          <p className="font-medium">Várunk a másik játékosra.</p>
          <p className="mt-1 text-neutral-700">Küldd el neki ezt a linket:</p>
          {inviteUrl ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all rounded bg-white px-2 py-1 font-mono text-xs">
                {inviteUrl}
              </code>
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(inviteUrl);
                  setCopied(true);
                }}
                className="min-h-11 rounded-md bg-[#1e3a24] px-3 py-2 text-xs font-medium text-[#f6ece0]"
              >
                {copied ? "Másolva" : "Másolom"}
              </button>
            </div>
          ) : (
            <p className="mt-2 text-neutral-600">A meghívó a játék indításakor jelent meg.</p>
          )}
        </div>
      )}

      <ol className="flex flex-col gap-2">
        {view.turns.map((t) => (
          <li key={t.turn_index} className="rounded-md border border-neutral-900/10 bg-white/60 p-3">
            <div className="text-xs text-neutral-500">#{t.turn_index}</div>
            {t.question_text && <div className="text-[15px]">{t.question_text}</div>}
            {t.turn_type === "guess" && (
              <div className="text-[15px]">Tipp: <strong>{t.guess_text}</strong></div>
            )}
            {t.turn_type === "concede" && <div className="text-[15px]">Feladta.</div>}
            {t.composer_response && (
              <div className="mt-1 text-sm font-semibold text-[#1e3a24]">
                {t.composer_response === "YES" ? "IGEN" : t.composer_response === "NO" ? "NEM" : "BIZONYTALAN"}
              </div>
            )}
            {t.ambiguous_explanation && (
              <div className="text-sm text-neutral-700">{t.ambiguous_explanation}</div>
            )}
          </li>
        ))}
      </ol>

      {error && <p className="text-sm text-[#8b2f2f]">{error}</p>}

      {/* Composer's controls: answer the outstanding question. */}
      {live && iAmComposer && view.your_turn && (
        <div className="flex flex-col gap-2 rounded-md border border-neutral-900/15 bg-white/60 p-3">
          <input
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            placeholder="Ha bizonytalan: miért? (nem kötelező)"
            className="w-full rounded-md border border-neutral-900/15 px-3 py-2 text-sm"
            disabled={busy}
          />
          <div className="flex flex-wrap gap-2">
            {(["YES", "NO", "AMBIGUOUS"] as ComposerAnswer[]).map((a) => (
              <button
                key={a}
                onClick={() => answer(a)}
                disabled={busy}
                className="min-h-11 flex-1 rounded-md bg-[#1e3a24] px-4 py-2 text-sm font-medium text-[#f6ece0] disabled:opacity-40"
              >
                {a === "YES" ? "IGEN" : a === "NO" ? "NEM" : "BIZONYTALAN"}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Racer's controls: ask, guess or concede. */}
      {live && !iAmComposer && view.your_turn && (
        <div className="flex flex-col gap-2 rounded-md border border-neutral-900/15 bg-white/60 p-3">
          {!guessMode ? (
            <>
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Kérdezz bármit, amire igennel vagy nemmel lehet felelni."
                rows={2}
                className="w-full rounded-md border border-neutral-900/15 px-3 py-2 text-sm"
                disabled={busy}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => {
                    void send({ action: "question", question });
                    setQuestion("");
                  }}
                  disabled={busy || !question.trim()}
                  className="min-h-11 flex-1 rounded-md bg-[#1e3a24] px-4 py-2 text-sm font-medium text-[#f6ece0] disabled:opacity-40"
                >
                  Kérdezek
                </button>
                <button
                  onClick={() => setGuessMode(true)}
                  disabled={busy}
                  className="min-h-11 rounded-md border border-neutral-900/25 px-4 py-2 text-sm"
                >
                  Tippelek
                </button>
              </div>
            </>
          ) : (
            <>
              <input
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
                placeholder="Írd le, mire gondolt"
                className="w-full rounded-md border border-neutral-900/15 px-3 py-2 text-sm"
                disabled={busy}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void send({ action: "guess", guess })}
                  disabled={busy || !guess.trim()}
                  className="min-h-11 flex-1 rounded-md bg-[#1e3a24] px-4 py-2 text-sm font-medium text-[#f6ece0] disabled:opacity-40"
                >
                  Tipp véglegesítése
                </button>
                <button
                  onClick={() => setGuessMode(false)}
                  disabled={busy}
                  className="min-h-11 rounded-md border border-neutral-900/25 px-4 py-2 text-sm"
                >
                  Vissza
                </button>
                <button
                  onClick={() => void send({ action: "concede" })}
                  disabled={busy}
                  className="min-h-11 rounded-md border border-neutral-900/25 px-4 py-2 text-sm"
                >
                  Feladom
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {view.phase === "resolving" && (
        <p className="text-sm text-neutral-700">Értékelés folyamatban…</p>
      )}

      {over && (
        <div className="flex flex-col gap-2 rounded-md border border-neutral-900/15 bg-white/70 p-4">
          <div className="text-lg font-semibold">
            {view.result === "racer_correct"
              ? "Eltalálta!"
              : view.result === "racer_incorrect"
                ? "Nem talált."
                : view.result === "racer_win_integrity_violation"
                  ? "A kérdezőé — integritás-ellenőrzés."
                  : "A gondolkodóé."}
          </div>
          {view.revealed_target && (
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-600">A megfejtés</div>
              <div className="text-base">{view.revealed_target}</div>
            </div>
          )}
          {view.final_guess_text && (
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-600">A tipp</div>
              <div className="text-base">{view.final_guess_text}</div>
            </div>
          )}
          {view.adjudication_notes && (
            <p className="text-sm text-neutral-700">{view.adjudication_notes}</p>
          )}
          {view.integrity_notes && (
            <p className="text-sm text-neutral-700">{view.integrity_notes}</p>
          )}
        </div>
      )}

      <a href="/" className="min-h-11 text-sm text-neutral-600 underline underline-offset-2">
        ← Vissza a Barkóba főoldalra
      </a>
    </div>
  );
}
