"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ClueMode, Difficulty } from "@/lib/types";

// Pre-game controls for the human Racer. Deliberately three buttons and four
// numbers — the brief called for the smallest sensible selector, and anything
// more here is polish on a screen the player sees for four seconds.

const DIFFICULTIES: { value: Difficulty; label: string; blurb: string }[] = [
  { value: "easy", label: "Easy", blurb: "Everyday things. Good with a child." },
  { value: "medium", label: "Medium", blurb: "General knowledge. No looking things up." },
  { value: "hard", label: "Hard", blurb: "Further to deduce — not more obscure." },
];

const CLUE_MODES: { value: ClueMode; label: string; blurb: string }[] = [
  { value: "none", label: "No clues", blurb: "Answers only." },
  { value: "minimal", label: "Minimal", blurb: "An occasional nudge when you stall." },
  { value: "progressive", label: "Progressive", blurb: "Help that grows as questions run out." },
];

const BUDGETS = [20, 35, 50, 100];

export default function RacerSetup({ versionLabel }: { versionLabel: string }) {
  const router = useRouter();
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [clueMode, setClueMode] = useState<ClueMode>("none");
  const [budget, setBudget] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/game/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "ai_composer",
          difficulty,
          clue_mode: difficulty === "hard" ? clueMode : "none",
          max_questions: budget,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.game_id) {
        setError(data.message || "Could not start a game.");
        setBusy(false);
        return;
      }
      router.push(`/game/${data.game_id}`);
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  }

  const pill = (active: boolean) =>
    `min-h-11 flex-1 rounded-md border px-3 py-2.5 text-sm font-medium ${
      active
        ? "border-neutral-300 bg-neutral-100 text-neutral-900"
        : "border-neutral-800 bg-neutral-900 text-neutral-300"
    }`;

  return (
    <main className="mx-auto flex w-full min-h-screen max-w-xl flex-col gap-6 px-4 py-10 sm:justify-center sm:px-6 sm:py-16">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Barkóba</h1>
          <span className="shrink-0 text-xs font-normal text-neutral-600">{versionLabel}</span>
        </div>
        <p className="mt-1 text-sm text-neutral-400">
          The AI picks a secret. You have questions to find it.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm text-neutral-300">Difficulty</span>
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
        <p className="text-xs text-neutral-500">
          {DIFFICULTIES.find((d) => d.value === difficulty)?.blurb}
        </p>
      </div>

      {difficulty === "hard" && (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-neutral-300">Clues</span>
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
          <p className="text-xs text-neutral-500">
            {CLUE_MODES.find((c) => c.value === clueMode)?.blurb}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-sm text-neutral-300">Questions</span>
        <div className="flex flex-wrap gap-2">
          {BUDGETS.map((b) => (
            <button
              key={b}
              onClick={() => setBudget(b)}
              disabled={busy}
              className={pill(budget === b)}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => void start()}
        disabled={busy}
        className="min-h-11 rounded-md bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-900 disabled:opacity-40"
      >
        {busy ? "The AI is choosing…" : "Start"}
      </button>

      <a href="/compose" className="text-xs text-neutral-600 underline underline-offset-2">
        Or set a secret yourself, and let the AI guess
      </a>

      {error && (
        <div className="rounded-md border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-200">{error}</p>
        </div>
      )}
    </main>
  );
}
