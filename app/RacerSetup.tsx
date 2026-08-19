"use client";

import ThinkingState from "./components/ThinkingState";
import NamePrompt from "./components/NamePrompt";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ClueMode, Difficulty } from "@/lib/types";
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

const CLUE_MODES: { value: ClueMode; label: string; blurb: string }[] = [
  { value: "none", label: "Nincs segítség", blurb: "Csak a válaszok." },
  { value: "minimal", label: "Minimális", blurb: "Néha egy apró terelés, ha elakadsz." },
  { value: "progressive", label: "Fokozatos", blurb: "Egyre több segítség, ahogy fogynak a kérdések." },
];

const BUDGETS = [20, 35, 50, 100];

export default function RacerSetup({ versionLabel, askForName = false }: { versionLabel: string; askForName?: boolean }) {
  const router = useRouter();
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [clueMode, setClueMode] = useState<ClueMode>("none");
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
          clue_mode: difficulty === "hard" ? clueMode : "none",
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
    <GameShell role="Az AI gondol valamire. Te fogsz kérdezni." version={versionLabel}>
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

      {difficulty === "hard" && (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-[var(--ink)]">Segítség</span>
          <div className="flex flex-wrap gap-2">
            {CLUE_MODES.map((c) => (
              <button
                key={c.value}
                onClick={() => setClueMode(c.value)}
                disabled={busy}
                className={pill(clueMode === c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-[var(--ink-soft)]">
            {CLUE_MODES.find((c) => c.value === clueMode)?.blurb}
          </p>
        </div>
      )}

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
