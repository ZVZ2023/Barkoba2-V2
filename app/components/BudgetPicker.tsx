"use client";

import { QUESTION_BUDGETS, recommendedBudget } from "@/lib/questionBudget";
import type { PlayState } from "@/lib/entitlements";
import type { Difficulty } from "@/lib/types";

// ---------------------------------------------------------------------------
// Difficulty → recommended allowance → Composer override.
//
// SHARED BY BOTH HUMAN-COMPOSER FLOWS: /compose (AI Racer) and /play/human
// (Human Racer). The rule is a property of "a human set the target", not of who
// is guessing, so the two screens must not each grow their own copy of it —
// that is how the same control ends up meaning two different things.
//
// The difficulty vocabulary is reused verbatim from the AI-Composer setup
// screen. Difficulty describes DEDUCTIVE DISTANCE, never obscurity; the budget
// is what that distance is paid for in. Nothing about difficulty is redesigned
// here.
//
// Controlled component: the parent owns the state, this owns the presentation
// and the recommendation. `budgetOverride === null` means "follow the
// recommendation", so changing difficulty keeps moving the suggestion instead
// of silently freezing whatever was displayed first.
// ---------------------------------------------------------------------------

const DIFFICULTIES: { value: Difficulty; label: string; blurb: string }[] = [
  { value: "easy", label: "Könnyű", blurb: "Hétköznapi dolgok. Gyerekkel is jó." },
  { value: "medium", label: "Közepes", blurb: "Általános műveltség. Nem kell utánanézni." },
  { value: "hard", label: "Nehéz", blurb: "Több lépés a megfejtésig — nem homályosabb." },
];

export interface BudgetPickerProps {
  difficulty: Difficulty;
  onDifficultyChange: (d: Difficulty) => void;
  budgetOverride: number | null;
  onBudgetChange: (b: number | null) => void;
  disabled?: boolean;
  /** Who will be spending the questions. Only changes the wording. */
  racer: "ai" | "human";
  /**
   * V2.4 — Play Credit cost per tier and the player's balance, both from
   * GET /api/player/entitlement. Null/absent means entitlement is not
   * enforcing, and no price or affordability hint is shown at all.
   *
   * A tier the player cannot afford is MARKED, never blocked: the server is the
   * only authority on refusal, and a client that disabled the control would be
   * making a decision it is not entitled to make.
   */
  costs?: Record<string, number> | null;
  balance?: number | null;
  playState?: PlayState | null;
}

/** The allowance this picker currently resolves to. Exported so callers submit the same value. */
export function pickedBudget(difficulty: Difficulty, budgetOverride: number | null): number {
  return budgetOverride ?? recommendedBudget(difficulty);
}

export default function BudgetPicker({
  difficulty,
  onDifficultyChange,
  budgetOverride,
  onBudgetChange,
  disabled = false,
  racer,
  costs = null,
  balance = null,
  playState = null,
}: BudgetPickerProps) {
  const recommended = recommendedBudget(difficulty);
  const budget = pickedBudget(difficulty, budgetOverride);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Nehézség</span>
        <div className="flex flex-wrap gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => onDifficultyChange(d.value)}
              disabled={disabled}
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
        <span className="text-sm font-medium">
          {racer === "ai" ? "Hány kérdést kapjon az AI?" : "Kérdések száma"}
        </span>
        <div className="flex flex-wrap gap-2">
          {QUESTION_BUDGETS.map((b) => {
            const cost = costs?.[String(b)];
            // Marked, not blocked. The server decides refusals; this only
            // spares the player a wasted attempt.
            const unaffordable =
              playState !== "unlimited" &&
              playState !== "introductory_available" &&
              typeof cost === "number" &&
              typeof balance === "number" &&
              balance < cost;
            return (
              <button
                key={b}
                type="button"
                onClick={() => onBudgetChange(b)}
                disabled={disabled}
                title={unaffordable ? "Ehhez nincs elég VERSENYED" : undefined}
                className={`min-h-11 flex-1 rounded-md px-4 py-2 text-sm ${
                  budget === b
                    ? "bg-[#1e3a24] font-medium text-[#f6ece0]"
                    : "border border-neutral-900/20 bg-white/70"
                } ${unaffordable && budget !== b ? "opacity-45" : ""}`}
              >
                <span className="block">{b}</span>
                {typeof cost === "number" && (
                  <span className="block text-xs opacity-80">
                    {cost} VERSENY{unaffordable ? " ⚠" : ""}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="text-sm text-neutral-600">
          {budget === recommended
            ? `Ennyit javaslunk ehhez a nehézséghez (${recommended}). Felülírhatod.`
            : `Te választottad: ${budget}. Javaslatunk ${recommended} lenne.`}
          {budgetOverride !== null && (
            <button
              type="button"
              onClick={() => onBudgetChange(null)}
              className="ml-2 underline underline-offset-2"
            >
              Vissza a javaslathoz
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
