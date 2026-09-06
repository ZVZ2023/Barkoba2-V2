"use client";

import { useCallback, useEffect, useState } from "react";
import { EXPERIENCE_MODE_LABEL_HU, isExperienceMode } from "@/lib/experienceMode";

interface Props {
  versionLabel: string;
}

/**
 * V2.7 — mirrors the shape of GET /api/player/history exactly. Defined
 * locally rather than imported from lib/corpus/gameCorpus.ts: that module
 * pulls in the corpus database client, and a client component must never be
 * the reason server-only code ends up reachable from the browser bundle —
 * the same boundary lib/entitlements.ts's own header states for a different
 * pairing of modules. Four fields are cheap to duplicate; the boundary is not
 * cheap to get wrong.
 */
interface HistoryEntry {
  game_id: string;
  created_at: string;
  lifecycle_state: string;
  outcome: string | null;
  role: "composer" | "racer" | null;
  /**
   * V2.8.8 — NULL for every game recorded before this field existed, never
   * "competitive" (see lib/experienceMode.ts's own doc on this convention).
   */
  experience_mode: string | null;
  /**
   * V2.8.8.5 — MEANINGFUL GAME-HISTORY CARDS. game_language drives the
   * bilingual "not retained" copy below; NOT NULL at the schema level.
   * target is populated ONLY for a completed game (see
   * lib/corpus/gameCorpus.ts's listPlayerHistory doc for the two
   * independent gates that make this true) — always null for anything
   * in_progress/abandoned/stalled/unresolved, by construction on the
   * server, never filtered here.
   *
   * V2.8.8.6 — the final guess was deliberately REMOVED from this list's
   * shape. A production data audit confirmed the server was never sending
   * the wrong value; showing both the target and the guess side by side on
   * a selection list was itself the ambiguity. The guess still exists on
   * the opened game's own detail view (ArchivedGameView.tsx), which is
   * where a specific answer belongs, not the list used to pick a game.
   */
  game_language: string;
  max_questions: number;
  question_count: number;
  target: string | null;
}

type LoadState =
  | { step: "loading" }
  | { step: "no_identity" }
  | { step: "unavailable" }
  | { step: "network_error" }
  | { step: "ready"; games: HistoryEntry[] };

/** Matches HumanClient.tsx's existing vocabulary for these two seats. */
const ROLE_HU: Record<string, string> = {
  composer: "gondolkodó voltál",
  racer: "kérdező voltál",
};

const RACER_WON = new Set(["racer_correct", "racer_win_integrity_violation"]);

function statusOf(entry: HistoryEntry): { text: string; className: string } {
  if (entry.lifecycle_state === "in_progress") {
    return { text: "Folyamatban", className: "text-[var(--ink-soft)]" };
  }
  if (entry.lifecycle_state === "stalled_resolving") {
    return { text: "Megszakadt — értékelés közben", className: "text-[var(--ink-soft)]" };
  }
  if (entry.lifecycle_state === "abandoned_inferred") {
    return { text: "Abbahagyva", className: "text-[var(--ink-soft)]" };
  }
  if (!entry.outcome) {
    return { text: "Lezárva", className: "text-[var(--ink-soft)]" };
  }

  const racerWon = RACER_WON.has(entry.outcome);
  if (entry.role === "composer") {
    return racerWon
      ? { text: "Vesztettél", className: "text-[var(--red)]" }
      : { text: "Nyertél", className: "text-[var(--green)]" };
  }
  if (entry.role === "racer") {
    return racerWon
      ? { text: "Nyertél", className: "text-[var(--green)]" }
      : { text: "Vesztettél", className: "text-[var(--red)]" };
  }
  // Role could not be determined (pre-V2.3 record). Report the outcome
  // itself rather than guessing which side this player was on.
  return racerWon
    ? { text: "Az AI nyert", className: "text-[var(--ink-soft)]" }
    : { text: "A gondolkodó nyert", className: "text-[var(--ink-soft)]" };
}

// ---------------------------------------------------------------------------
// V2.8.8.5 — MEANINGFUL GAME-HISTORY CARDS.
//
// Scoped to COMPLETED games only, matching this ticket's own scope: a
// non-completed card's existing, unchanged layout (role/mode badge/status/
// date/link) is untouched. The enriched fields below (target,
// questions-used) exist ONLY on a completed card, and their own "not
// retained" copy follows the SAME bilingual-by-game_language precedent
// ArchivedGameView.tsx already established for identical narrative
// copy — role and experience-mode LABELS still stay Hungarian everywhere,
// matching that same file's documented, already-approved reasoning.
//
// V2.8.8.6 — the final guess no longer renders on this card at all (see
// HistoryEntry's own doc): it belongs on the opened game's detail view,
// not the selection list.
// ---------------------------------------------------------------------------

interface CompletedCardCopy {
  targetLabel: string;
  targetNotRetained: string;
  questionsLabel: string;
}

const COMPLETED_CARD_COPY: Record<"hu" | "en", CompletedCardCopy> = {
  hu: {
    targetLabel: "Cél",
    targetNotRetained: "A cél nem maradt meg.",
    questionsLabel: "kérdés",
  },
  en: {
    targetLabel: "Target",
    targetNotRetained: "Target not retained.",
    questionsLabel: "questions",
  },
};

function completedCopyFor(gameLanguage: string): CompletedCardCopy {
  return gameLanguage === "en" ? COMPLETED_CARD_COPY.en : COMPLETED_CARD_COPY.hu;
}

function formatWhen(iso: string, gameLanguage: string = "hu"): string {
  try {
    return new Date(iso).toLocaleString(gameLanguage === "en" ? "en-US" : "hu-HU", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function HistoryClient({ versionLabel }: Props) {
  const [state, setState] = useState<LoadState>({ step: "loading" });

  const load = useCallback(async () => {
    setState({ step: "loading" });
    try {
      const res = await fetch("/api/player/history", { cache: "no-store" });
      const data = await res.json();
      if (res.status === 409) {
        setState({ step: "no_identity" });
        return;
      }
      if (!res.ok) {
        setState({ step: "unavailable" });
        return;
      }
      setState({ step: "ready", games: (data.games ?? []) as HistoryEntry[] });
    } catch {
      setState({ step: "network_error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
        <h1 className="text-sm font-semibold text-[var(--ink)]">Játékaim</h1>
      </header>

      {state.step === "loading" && (
        <p className="text-sm text-[var(--ink-soft)]">Betöltés…</p>
      )}

      {state.step === "no_identity" && (
        <div className="rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
          <p className="text-sm text-[var(--ink)]">
            Most nem érhető el a játékosazonosítód. Ha bejelentkeztél, próbáld
            frissíteni az oldalt.
          </p>
        </div>
      )}

      {(state.step === "unavailable" || state.step === "network_error") && (
        <div className="rounded-md border border-[var(--red)]/35 bg-[var(--red)]/8 p-4">
          <p className="text-sm text-[var(--red)]">
            {state.step === "network_error"
              ? "Hálózati hiba — a játéktörténet most nem tölthető be."
              : "A játéktörténet most nem érhető el."}
          </p>
          <button
            onClick={() => void load()}
            className="mt-3 min-h-11 rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm text-[var(--ink)]"
          >
            Újra
          </button>
        </div>
      )}

      {state.step === "ready" && state.games.length === 0 && (
        <p className="text-sm text-[var(--ink-soft)]">Még nincs mentett játékod.</p>
      )}

      {state.step === "ready" && state.games.length > 0 && (
        <ul className="flex flex-col gap-3">
          {state.games.map((entry) => {
            const status = statusOf(entry);
            const megnyitas = (
              // V2.8.7.1 — an owned, still-live game must actually open from
              // here. V2.8.8.2 widened this from "in_progress" only, so
              // every lifecycle_state gets a link: /game/[id]'s OWN existing,
              // unchanged access control (decideGamePageAccess) still
              // enforces strict per-game ownership, and its OWN existing
              // not_found path still handles an expired live record — this
              // page never guesses at or fabricates the game's state, it
              // only always OFFERS to check.
              <a
                href={`/game/${entry.game_id}`}
                className="min-h-11 rounded-md border border-[var(--ink)]/25 px-3 py-2 text-sm text-[var(--ink)] underline-offset-2 hover:underline"
              >
                {entry.lifecycle_state === "in_progress" ? "Folytatás →" : "Megnyitás →"}
              </a>
            );

            if (entry.lifecycle_state === "completed") {
              // V2.8.8.5 — the enriched, completed-game card. Scoped to
              // 'completed' only: the target field the server sends is
              // ALREADY null for anything else (see lib/corpus/gameCorpus.ts's
              // own two independent gates), so this branch adds no security
              // decision of its own — it is presentation-only, choosing to
              // make target the most prominent text on a card whose target
              // the server has already decided is safe to show.
              //
              // V2.8.8.6 — the final guess deliberately never renders here
              // (the server no longer even sends it to this list — see
              // listPlayerHistory). It belongs on the opened game's own
              // detail view, not the card used to pick a game.
              const c = completedCopyFor(entry.game_language);
              return (
                <li
                  key={entry.game_id}
                  className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4"
                >
                  <p
                    className="text-base font-semibold leading-snug text-[var(--ink)]"
                    lang={entry.target ? entry.game_language : undefined}
                  >
                    {entry.target ?? c.targetNotRetained}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--ink-soft)]">
                    <span>{entry.role ? ROLE_HU[entry.role] : "szerep ismeretlen"}</span>
                    {isExperienceMode(entry.experience_mode) && (
                      <span>· {EXPERIENCE_MODE_LABEL_HU[entry.experience_mode]}</span>
                    )}
                    <span>
                      · {entry.question_count} / {entry.max_questions} {c.questionsLabel}
                    </span>
                    <span className={`font-medium ${status.className}`}>· {status.text}</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-[var(--ink-soft)]">
                      {formatWhen(entry.created_at, entry.game_language)}
                    </span>
                    {megnyitas}
                  </div>
                </li>
              );
            }

            // Every non-completed lifecycle_state keeps the ORIGINAL,
            // unchanged card layout — this ticket scopes the enriched
            // fields to completed games only.
            return (
              <li
                key={entry.game_id}
                className="flex flex-col gap-1 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-[var(--ink)]">{formatWhen(entry.created_at)}</span>
                  <span className="text-xs text-[var(--ink-soft)]">
                    {entry.role ? ROLE_HU[entry.role] : "szerep ismeretlen"}
                    {/* V2.8.8 — absent for a legacy game (no experience_mode
                        recorded), exactly like every other field here that
                        predates its own arrival. */}
                    {isExperienceMode(entry.experience_mode)
                      ? ` · ${EXPERIENCE_MODE_LABEL_HU[entry.experience_mode]}`
                      : ""}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-medium ${status.className}`}>{status.text}</span>
                  {megnyitas}
                </div>
              </li>
            );
          })}
        </ul>
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
