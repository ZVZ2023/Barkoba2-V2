"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
        setView({ step: "error", message: data.message || "Something went wrong." });
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
        setView({ step: "error", message: "Unexpected response from server." });
      }
    } catch {
      setView({ step: "error", message: "Network error — please try again." });
    }
  }

  return (
    <main className="mx-auto flex w-full min-h-screen max-w-xl flex-col gap-6 px-4 py-10 sm:justify-center sm:px-6 sm:py-16">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Barkóba</h1>
          <span className="shrink-0 text-xs font-normal text-neutral-600">{versionLabel}</span>
        </div>
        <p className="mt-1 text-sm text-neutral-400">
          Set a secret. The AI Racer starts completely blind and has {}
          {view.step === "valid" ? view.maxQuestions : 20} questions to find it.
        </p>
      </div>

      {(view.step === "entry" || view.step === "submitting") && (
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-300">Target</span>
            <input
              className="w-full min-w-0 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-500"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="e.g. handle"
              disabled={view.step === "submitting"}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-300">
              Private clarification <span className="text-neutral-500">(optional)</span> — never shown to the Racer
            </span>
            <textarea
              className="h-24 w-full min-w-0 resize-none rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-500"
              value={clarification}
              onChange={(e) => setClarification(e.target.value)}
              placeholder="Only if the target could mean more than one thing — e.g. the starting handle on the pull cord of my lawnmower"
              disabled={view.step === "submitting"}
            />
          </label>

          <button
            onClick={submit}
            disabled={view.step === "submitting" || !target}
            className="min-h-11 rounded-md bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-900 disabled:opacity-40"
          >
            {view.step === "submitting" ? "Validating…" : "Lock target"}
          </button>
        </div>
      )}

      {view.step === "clarification_required" && (
        <div className="flex flex-col gap-4 rounded-md border border-amber-900/50 bg-amber-950/30 p-4">
          <p className="text-sm text-amber-200">{view.message}</p>
          <p className="text-xs text-neutral-500">
            Refine your private clarification above and submit again.
          </p>
          <button
            onClick={() => setView({ step: "entry" })}
            className="min-h-11 self-start rounded-md border border-neutral-700 px-4 py-2.5 text-sm"
          >
            Back to entry
          </button>
        </div>
      )}

      {view.step === "invalid" && (
        <div className="flex flex-col gap-4 rounded-md border border-red-900/50 bg-red-950/30 p-4">
          <p className="text-sm text-red-200">{view.message}</p>
          <button
            onClick={() => {
              setTarget("");
              setClarification("");
              setView({ step: "entry" });
            }}
            className="min-h-11 self-start rounded-md border border-neutral-700 px-4 py-2.5 text-sm"
          >
            Try a different target
          </button>
        </div>
      )}

      {view.step === "error" && (
        <div className="flex flex-col gap-4 rounded-md border border-red-900/50 bg-red-950/30 p-4">
          <p className="text-sm text-red-200">{view.message}</p>
          <button
            onClick={() => setView({ step: "entry" })}
            className="min-h-11 self-start rounded-md border border-neutral-700 px-4 py-2.5 text-sm"
          >
            Back
          </button>
        </div>
      )}

      {view.step === "valid" && (
        <div className="flex flex-col gap-3 rounded-md border border-emerald-900/50 bg-emerald-950/30 p-4">
          <p className="text-sm text-emerald-200">
            Target locked. Game ID: <code className="break-all text-xs">{view.gameId}</code>
          </p>
          {view.difficultyWarning && (
            <p className="text-xs text-amber-300">⚠ {view.difficultyWarning}</p>
          )}
          <button
            onClick={() => router.push(`/game/${view.gameId}`)}
            className="min-h-11 self-start rounded-md bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-900"
          >
            Start the game
          </button>
        </div>
      )}
    </main>
  );
}
