"use client";

import ThinkingState from "./components/ThinkingState";
import NamePrompt from "./components/NamePrompt";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Difficulty, ExperienceMode } from "@/lib/types";
import {
  DEFAULT_EXPERIENCE_MODE,
  EXPERIENCE_MODES,
  EXPERIENCE_MODE_DESCRIPTION_HU,
  EXPERIENCE_MODE_LABEL_HU,
} from "@/lib/experienceMode";
import AccountControl from "./components/AccountControl";
import GameShell from "./components/GameShell";
import { BalanceBadge, CreditGateway, useEntitlement } from "./components/Entitlement";

// Pre-game controls for the human Racer. Deliberately three buttons and four
// numbers — the brief called for the smallest sensible selector, and anything
// more here is polish on a screen the player sees for four seconds.

const DIFFICULTIES: { value: Difficulty; label: string; blurb: string }[] = [
  { value: "easy", label: "Könnyű", blurb: "Hétköznapi dolgok. Gyerekkel is jó." },
  { value: "medium", label: "Közepes", blurb: "Általános műveltség. Nem kell utánanézni." },
  { value: "hard", label: "Nehéz", blurb: "Több lépés a megfejtésig — nem homályosabb." },
];

// V2.8.8 — REPLACES the old CLUE_MODES ("Segítség") selector for every new
// game: the four experience modes now derive clue_mode themselves (server-
// side, lib/experienceMode.ts's clueModeForExperienceMode), so a player can
// no longer create a contradictory combination like Competitive + Progressive
// assistance. clue_mode itself is untouched for every historical game — see
// lib/clueCredits.ts's cluesEnabled().
const EXPERIENCE_MODE_OPTIONS: { value: ExperienceMode; label: string; blurb: string }[] =
  EXPERIENCE_MODES.map((value) => ({
    value,
    label: EXPERIENCE_MODE_LABEL_HU[value],
    blurb: EXPERIENCE_MODE_DESCRIPTION_HU[value],
  }));

const BUDGETS = [20, 35, 50, 100];

export default function RacerSetup({
  versionLabel,
  askForName = false,
  accountAuthenticated = false,
  accountPhotoUrl = null,
}: {
  versionLabel: string;
  askForName?: boolean;
  /** V2.8.4.3 — resolved server-side by app/play/ai/page.tsx. */
  accountAuthenticated?: boolean;
  accountPhotoUrl?: string | null;
}) {
  const router = useRouter();
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  // V2.8.8 — visibly defaults to Friendly, never Competitive (decision #3).
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>(DEFAULT_EXPERIENCE_MODE);
  const [budget, setBudget] = useState(20);
  // V2.5 — the language of PLAY, not of this screen. There is no human target
  // text to read here, so "Automatikus" means Hungarian; choosing English makes
  // the AI pick AND play its target in English.
  const [gameLanguage, setGameLanguage] = useState<"auto" | "hu" | "en">("auto");
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(askForName);
  const [error, setError] = useState<string | null>(null);
  // V2.4 - refusal for lack of Play Credits must lead somewhere.
  const [noCredit, setNoCredit] = useState(false);
  const entitlement = useEntitlement();

  async function start() {
    setBusy(true);
    setError(null);
    setNoCredit(false);
    try {
      const res = await fetch("/api/game/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "ai_composer",
          difficulty,
          // V2.8.8 — a NEW client always sends its visible selection; the
          // server derives clue_mode from it and ignores any clue_mode this
          // client might otherwise have sent (see resolveExperienceAndClueMode
          // in app/api/game/create/route.ts).
          experience_mode: experienceMode,
          max_questions: budget,
          game_language: gameLanguage,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.game_id) {
        setError(data.message || "Nem sikerült elindítani a játékot.");
        if (data.error === "no_play_credit") setNoCredit(true);
        setBusy(false);
        return;
      }
      router.push(`/game/${data.game_id}`);
    } catch {
      setError("Hálózati hiba — próbáld újra.");
      setBusy(false);
    }
  }

  const pill = (active: boolean) =>
    `min-h-11 flex-1 rounded-md border px-3 py-2.5 text-sm font-medium ${
      active
        ? "border-[var(--green)] bg-[var(--green)] text-[var(--parchment)]"
        : "border-[var(--ink)]/15 bg-white/70 text-[var(--ink)]"
    }`;

  return (
    <GameShell
      role="A Barkóba AI gondol valamire. Te fogsz kérdezni."
      version={versionLabel}
      meta={<AccountControl authenticated={accountAuthenticated} photoUrl={accountPhotoUrl} />}
    >
      {naming ? (
        <NamePrompt onDone={() => setNaming(false)} />
      ) : busy ? (
        <ThinkingState note="Kiválaszt valamit, amire gondol. Mindjárt kezdhetsz kérdezni." />
      ) : (
      <>
      <BalanceBadge view={entitlement.view} />

      {/* V2.5 — the language of PLAY. Barkóba's interface stays Hungarian
          whichever option is chosen. */}
      <div className="flex flex-col gap-2">
        <span className="text-sm text-[var(--ink)]">A játék nyelve</span>
        <div className="flex flex-wrap gap-2">
          {(
            [
              { value: "auto", label: "Automatikus" },
              { value: "hu", label: "Magyar" },
              { value: "en", label: "English" },
            ] as const
          ).map((l) => (
            <button
              key={l.value}
              onClick={() => setGameLanguage(l.value)}
              disabled={busy}
              className={pill(gameLanguage === l.value)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm text-[var(--ink)]">Nehézség</span>
        <div className="flex flex-wrap gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.value}
              onClick={() => setDifficulty(d.value)}
              disabled={busy}
              className={pill(difficulty === d.value)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--ink-soft)]">
          {DIFFICULTIES.find((d) => d.value === difficulty)?.blurb}
        </p>
      </div>

      {/*
        V2.8.8 — replaces the old difficulty==="hard"-only "Segítség"
        selector. Always shown: difficulty and the experience mode are
        separate axes now (a player may pick Friendly at any difficulty),
        so this is never conditionally hidden the way the old assistance
        picker was.
      */}
      <div className="flex flex-col gap-2">
        <span className="text-sm text-[var(--ink)]">Élmény</span>
        <div className="flex flex-wrap gap-2">
          {EXPERIENCE_MODE_OPTIONS.map((m) => (
            <button
              key={m.value}
              onClick={() => setExperienceMode(m.value)}
              disabled={busy}
              className={pill(experienceMode === m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--ink-soft)]">
          {EXPERIENCE_MODE_OPTIONS.find((m) => m.value === experienceMode)?.blurb}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm text-[var(--ink)]">Kérdések</span>
        <div className="flex flex-wrap gap-2">
          {BUDGETS.map((b) => {
            const cost = entitlement.view?.costs?.[String(b)];
            const bal = entitlement.view?.balance;
            // Marked, never blocked — the server decides refusals.
            const short = typeof cost === "number" && typeof bal === "number" && bal < cost;
            return (
              <button
                key={b}
                onClick={() => setBudget(b)}
                disabled={busy}
                title={short ? "Ehhez nincs elég VERSENYED" : undefined}
                className={`${pill(budget === b)} ${short && budget !== b ? "opacity-45" : ""}`}
              >
                <span className="block">{b}</span>
                {typeof cost === "number" && (
                  <span className="block text-xs opacity-80">
                    {cost} VERSENY{short ? " ⚠" : ""}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <button
        onClick={() => void start()}
        disabled={busy}
        className="min-h-11 rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
      >
        {busy ? "Az AI választ…" : "Indulhat"}
      </button>

      <a href="/compose" className="text-xs text-[var(--ink-soft)] underline underline-offset-2">
        Vagy gondolj te valamire, és az AI találja ki
      </a>

      {error && (
        <div className="rounded-md border border-[var(--red)]/35 bg-[var(--red)]/8 p-3">
          <p className="text-sm text-[var(--red)]">{error}</p>
        </div>
      )}

      {noCredit && entitlement.view?.play_state === "exhausted" && (
        <CreditGateway />
      )}
      </>
      )}
    </GameShell>
  );
}
