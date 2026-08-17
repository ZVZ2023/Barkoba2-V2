"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import BudgetPicker, { pickedBudget } from "@/app/components/BudgetPicker";
import { BalanceBadge, CreditGateway, useEntitlement } from "@/app/components/Entitlement";
import type { Difficulty } from "@/lib/types";

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
  // V2.4 — set when creation was refused for lack of Play Credits, so the
  // refusal leads to the gateway instead of naming an action that goes nowhere.
  const [noCredit, setNoCredit] = useState(false);
  const entitlement = useEntitlement();

  const budget = pickedBudget(difficulty, budgetOverride);

  async function create(force: boolean) {
    setBusy(true);
    setError(null);
    setNoCredit(false);
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
        if (data?.error === "no_play_credit") setNoCredit(true);
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
      <BalanceBadge view={entitlement.view} />

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

      <BudgetPicker
        difficulty={difficulty}
        onDifficultyChange={setDifficulty}
        budgetOverride={budgetOverride}
        onBudgetChange={setBudgetOverride}
        disabled={busy}
        racer="human"
        costs={entitlement.view?.costs ?? null}
        balance={entitlement.view?.balance ?? null}
        playState={entitlement.view?.play_state ?? null}
      />

      {error && <p className="text-sm text-[#8b2f2f]">{error}</p>}
      {noCredit && entitlement.view?.play_state === "exhausted" && (
        <CreditGateway onBalanceMayHaveChanged={entitlement.refresh} />
      )}

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
