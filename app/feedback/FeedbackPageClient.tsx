"use client";

import { useState } from "react";
import GameShell from "../components/GameShell";
import FeedbackForm from "../components/FeedbackForm";

// ---------------------------------------------------------------------------
// V2.9.1 — the standalone /feedback page's shell: bilingual toggle + intro
// copy, matching the exact HU/EN switcher pattern app/beta/BetaClient.tsx
// and app/admin/feedback/AdminFeedbackClient.tsx already established.
//
// NO game reference is ever passed to FeedbackForm here — this call site is
// the "no game context" case the form must support on its own.
// ---------------------------------------------------------------------------

const COPY = {
  hu: {
    title: "Visszajelzés",
    intro:
      "Bármit megoszthatsz — hibát, javaslatot, vagy csak azt, mit gondolsz a " +
      "Barkóbáról. Nem kell hozzá regisztráció, és nem kell Alapító Tesztelőnek " +
      "lenned.",
  },
  en: {
    title: "Feedback",
    intro:
      "Share anything — a bug, a suggestion, or just what you think about " +
      "Barkóba. No registration or Founding Tester approval needed.",
  },
} as const;

export default function FeedbackPageClient({ versionLabel }: { versionLabel: string }) {
  const [lang, setLang] = useState<"hu" | "en">("hu");
  const t = COPY[lang];

  return (
    <GameShell role={t.title} version={versionLabel}>
      <div className="flex items-center justify-end gap-2 text-xs">
        <button
          type="button"
          onClick={() => setLang("hu")}
          className={`min-h-8 rounded-md border px-2 ${lang === "hu" ? "border-[var(--green)] bg-[var(--green)] text-[var(--parchment)]" : "border-[var(--ink)]/15"}`}
        >
          Magyar
        </button>
        <button
          type="button"
          onClick={() => setLang("en")}
          className={`min-h-8 rounded-md border px-2 ${lang === "en" ? "border-[var(--green)] bg-[var(--green)] text-[var(--parchment)]" : "border-[var(--ink)]/15"}`}
        >
          English
        </button>
      </div>

      <h1 className="text-lg font-semibold text-[var(--ink)]">{t.title}</h1>
      <p className="text-sm text-[var(--ink)]">{t.intro}</p>

      <FeedbackForm lang={lang} />
    </GameShell>
  );
}
