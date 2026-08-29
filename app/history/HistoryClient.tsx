"use client";

import { useCallback, useEffect, useState } from "react";

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

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("hu-HU", {
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
            return (
              <li
                key={entry.game_id}
                className="flex flex-col gap-1 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-[var(--ink)]">{formatWhen(entry.created_at)}</span>
                  <span className="text-xs text-[var(--ink-soft)]">
                    {entry.role ? ROLE_HU[entry.role] : "szerep ismeretlen"}
                  </span>
                </div>
                <span className={`text-sm font-medium ${status.className}`}>{status.text}</span>
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
