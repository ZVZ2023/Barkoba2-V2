"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { QUESTION_BUDGETS, recommendedBudget } from "@/lib/questionBudget";
import type { Difficulty } from "@/lib/types";

// Same wording as the AI-Composer setup screen. Difficulty describes deductive
// DISTANCE, never obscurity — reused verbatim so the two screens cannot drift.
const DIFFICULTIES: { value: Difficulty; label: string; blurb: string }[] = [
  { value: "easy", label: "Könnyű", blurb: "Hétköznapi dolgok. Gyerekkel is jó." },
  { value: "medium", label: "Közepes", blurb: "Általános műveltség. Nem kell utánanézni." },
  { value: "hard", label: "Nehéz", blurb: "Több lépés a megfejtésig — nem homályosabb." },
];

// ---------------------------------------------------------------------------
// V2.3 — creating a Human↔Human game.
//
// Deliberately the same shape as the 0.3.x Composer entry: the Composer sets
// the target FIRST, then invites. That removes a "waiting for the Composer to
// think" state the second player would otherwise sit in, and it means a join
// link is never live for a game that has no secret yet.
// ---------------------------------------------------------------------------

export default function HumanSetup({ versionLabel }: { versionLabel: string }) {
  const router = useRouter();
  const [target, setTarget] = useState("");
  const [clarification, setClarification] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  // null means "follow the recommendation". It stays null until the Composer
  // actually overrides, so changing difficulty keeps moving the suggestion
  // rather than silently freezing whatever was shown first.
  const [budgetOverride, setBudgetOverride] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsForce, setNeedsForce] = useState(false);

  const recommended = recommendedBudget(difficulty);
  const budget = budgetOverride ?? recommended;

  async function create(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/game/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "human_human",
          target: target.trim(),
          private_clarification: clarification.trim(),
          difficulty,
          // The server re-resolves this; the client only proposes.
          max_questions: budget,
          force,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        setError(data?.message || "Elérted az óránkénti határt. Próbáld később.");
        return;
      }
      if (!res.ok) {
        setError(data?.message || "Most nem sikerült elindítani a játékot.");
        return;
      }
      if (data.status === "INVALID") {
        setError(data.message);
        return;
      }
      if (data.status === "CLARIFICATION_REQUIRED") {
        setError(data.message);
        setNeedsForce(true);
        return;
      }
      router.push(`/game/${data.game_id}`);
    } catch {
      setError("Hálózati hiba — próbáld újra.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Játék egy másik emberrel</h1>
        <p className="mt-1 text-sm text-neutral-700">
          Te gondolsz valamire, a másik játékos kérdez. Előbb zárd le a titkot, utána kapsz egy
          meghívó linket.
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Mire gondolsz?</span>
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="pl. a nagymamám régi órája"
          className="w-full rounded-md border border-neutral-900/15 bg-white/70 px-3 py-2"
          disabled={busy}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Pontosítás (nem kötelező)</span>
        <textarea
          value={clarification}
          onChange={(e) => setClarification(e.target.value)}
          rows={2}
          placeholder="Csak neked látszik. Ez rögzíti, mit jelent pontosan a titkod."
          className="w-full rounded-md border border-neutral-900/15 bg-white/70 px-3 py-2"
          disabled={busy}
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Nehézség</span>
        <div className="flex flex-wrap gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => setDifficulty(d.value)}
              disabled={busy}
              className={`min-h-11 flex-1 rounded-md px-4 py-2 text-sm ${
                difficulty === d.value
                  ? "bg-[#1e3a24] font-medium text-[#f6ece0]"
                  : "border border-neutral-900/20 bg-white/70"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-neutral-600">
          {DIFFICULTIES.find((d) => d.value === difficulty)?.blurb}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Kérdések száma</span>
        <div className="flex flex-wrap gap-2">
          {QUESTION_BUDGETS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBudgetOverride(b)}
              disabled={busy}
              className={`min-h-11 flex-1 rounded-md px-4 py-2 text-sm ${
                budget === b
                  ? "bg-[#1e3a24] font-medium text-[#f6ece0]"
                  : "border border-neutral-900/20 bg-white/70"
              }`}
            >
              {b}
            </button>
          ))}
        </div>
        <p className="text-sm text-neutral-600">
          {budget === recommended
            ? `Ennyit javaslunk ehhez a nehézséghez (${recommended}). Felülírhatod.`
            : `Te választottad: ${budget}. Javaslatunk ${recommended} lenne.`}
          {budgetOverride !== null && (
            <button
              type="button"
              onClick={() => setBudgetOverride(null)}
              className="ml-2 underline underline-offset-2"
            >
              Vissza a javaslathoz
            </button>
          )}
        </p>
      </div>

      {error && <p className="text-sm text-[#8b2f2f]">{error}</p>}

      <button
        onClick={() => void create(needsForce)}
        disabled={busy || !target.trim()}
        className="min-h-11 rounded-md bg-[#1e3a24] px-5 py-3 text-sm font-medium text-[#f6ece0] disabled:opacity-40"
      >
        {needsForce ? "Mégis ez legyen" : "Titok lezárása és meghívó"}
      </button>

      <div className="flex items-center justify-between pt-2">
        <a href="/play" className="min-h-11 text-sm text-neutral-600 underline underline-offset-2">
          Vissza
        </a>
        <span className="text-xs text-neutral-600">{versionLabel}</span>
      </div>
    </div>
  );
}
