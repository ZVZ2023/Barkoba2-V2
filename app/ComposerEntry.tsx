"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import GameShell from "./components/GameShell";

type ViewState =
  | { step: "entry" }
  | { step: "submitting" }
  | { step: "clarification_required"; message: string }
  | { step: "invalid"; message: string }
  | { step: "valid"; gameId: string; maxQuestions: number; difficultyWarning: string | null }
  | { step: "error"; message: string };

export default function ComposerEntry({ versionLabel }: { versionLabel: string }) {
  const router = useRouter();
  const [target, setTarget] = useState("");
  const [clarification, setClarification] = useState("");
  const [view, setView] = useState<ViewState>({ step: "entry" });

  async function submit() {
    setView({ step: "submitting" });
    try {
      const res = await fetch("/api/game/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          private_clarification: clarification,
        }),
      });

      const data = await res.json();

      if (res.status === 429) {
        setView({ step: "error", message: data.message });
        return;
      }
      if (!res.ok && data.error && data.error !== "validator_unavailable") {
        setView({ step: "error", message: data.message || "Valami hiba történt." });
        return;
      }

      if (data.status === "INVALID") {
        setView({ step: "invalid", message: data.message });
      } else if (data.status === "CLARIFICATION_REQUIRED") {
        setView({ step: "clarification_required", message: data.message });
      } else if (data.status === "VALID") {
        setView({
          step: "valid",
          gameId: data.game_id,
          maxQuestions: data.max_questions,
          difficultyWarning: data.difficulty_warning,
        });
        // A difficulty warning is worth a beat to read; otherwise go straight in.
        if (!data.difficulty_warning) {
          router.push(`/game/${data.game_id}`);
        }
      } else {
        setView({ step: "error", message: "Váratlan válasz a szervertől." });
      }
    } catch {
      setView({ step: "error", message: "Hálózati hiba — próbáld újra." });
    }
  }

  return (
    <GameShell role="Te gondolsz valamire. Az AI fogja kitalálni.">
      <p className="text-sm text-[var(--ink-soft)]">
        Gondolj valamire, és rögzítsd. Az AI teljesen vakon indul, és{" "}
        {view.step === "valid" ? view.maxQuestions : 20} kérdése van, hogy kitalálja.
      </p>

      {(view.step === "entry" || view.step === "submitting") && (
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--ink)]">Amire gondolsz</span>
            <input
              className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--green)]"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="pl. fogantyú"
              disabled={view.step === "submitting"}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--ink)]">
              Pontosítás <span className="text-[var(--ink-soft)]">(nem kötelező)</span> — az AI sosem látja
            </span>
            <textarea
              className="h-24 w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--green)]"
              value={clarification}
              onChange={(e) => setClarification(e.target.value)}
              placeholder="Csak ha a szó többfélét is jelenthet — pl. a fűnyíróm indítózsinórjának fogantyúja"
              disabled={view.step === "submitting"}
            />
          </label>

          <button
            onClick={submit}
            disabled={view.step === "submitting" || !target}
            className="min-h-11 rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
          >
            {view.step === "submitting" ? "Ellenőrzés…" : "Titok rögzítése"}
          </button>
        </div>
      )}

      {view.step === "clarification_required" && (
        <div className="flex flex-col gap-4 rounded-md border border-[var(--red)]/30 bg-[var(--red)]/6 p-4">
          <p className="text-sm text-[var(--ink)]">{view.message}</p>
          <p className="text-xs text-[var(--ink-soft)]">
            Pontosítsd fent, majd küldd be újra.
          </p>
          <button
            onClick={() => setView({ step: "entry" })}
            className="min-h-11 self-start rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm"
          >
            Back to entry
          </button>
        </div>
      )}

      {view.step === "invalid" && (
        <div className="flex flex-col gap-4 rounded-md border border-[var(--red)]/35 bg-[var(--red)]/8 p-4">
          <p className="text-sm text-[var(--red)]">{view.message}</p>
          <button
            onClick={() => {
              setTarget("");
              setClarification("");
              setView({ step: "entry" });
            }}
            className="min-h-11 self-start rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm"
          >
            Try a different target
          </button>
        </div>
      )}

      {view.step === "error" && (
        <div className="flex flex-col gap-4 rounded-md border border-[var(--red)]/35 bg-[var(--red)]/8 p-4">
          <p className="text-sm text-[var(--red)]">{view.message}</p>
          <button
            onClick={() => setView({ step: "entry" })}
            className="min-h-11 self-start rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm"
          >
            Back
          </button>
        </div>
      )}

      {view.step === "valid" && (
        <div className="flex flex-col gap-3 rounded-md border border-[var(--green)]/30 bg-[var(--green)]/5 p-4">
          <p className="text-sm text-[var(--green)]">
            A titok rögzítve. Játékazonosító: <code className="break-all text-xs">{view.gameId}</code>
          </p>
          {view.difficultyWarning && (
            <p className="text-xs text-[var(--red)]">⚠ {view.difficultyWarning}</p>
          )}
          <button
            onClick={() => router.push(`/game/${view.gameId}`)}
            className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
          >
            Start the game
          </button>
        </div>
      )}
    </GameShell>
  );
}
