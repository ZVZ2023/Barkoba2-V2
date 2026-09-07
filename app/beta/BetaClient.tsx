"use client";

import { useCallback, useEffect, useState } from "react";
import GameShell from "../components/GameShell";
import ClaimPrompt from "../components/ClaimPrompt";

// ---------------------------------------------------------------------------
// V2.9.0 Slice 1 — Limited Beta / Founding Tester information + application.
//
// Complete Hungarian and English copy (LOCALIZATION requirement), toggled by
// the reader — there is no "game language" context on this page the way
// ComposerEntry.tsx has one, so this is its own small, local choice.
// ---------------------------------------------------------------------------

type Lang = "hu" | "en";

const COPY = {
  hu: {
    title: "Korlátozott Béta — Alapító Tesztelők",
    intro:
      "A Barkóba jelenleg mindenki számára béta állapotban elérhető. Az Alapító " +
      "Tesztelő egy külön, jóváhagyáshoz kötött szerep: aki jelentkezik és " +
      "elfogadják, korai hozzáférést és beleszólást kap a közösségi funkciók " +
      "alakításába.",
    everyoneNote:
      "Fontos: ebben az időszakban MINDEN játékos béta állapotban játszik. Az " +
      "Alapító Tesztelő jelentkezés ehhez képest egy külön, opcionális szerep — " +
      "nem feltétele a játéknak.",
    needAccount: "A jelentkezéshez előbb regisztrálnod vagy be kell jelentkezned.",
    needVerification: "A jelentkezéshez meg kell erősítened az e-mail címedet.",
    formLabel: "Miért szeretnél Alapító Tesztelő lenni? (nem kötelező)",
    submit: "Jelentkezés elküldése",
    submitting: "Küldés…",
    statusPending: "A jelentkezésed elbírálás alatt áll.",
    statusApproved: "Gratulálunk! Alapító Tesztelő lettél.",
    statusRejected: "A jelentkezésed jelenleg nem lett elfogadva.",
    rejectionReasonLabel: "Indoklás:",
    noCreditChange:
      "A jelentkezés vagy az elfogadás nem ad és nem von el VERSENY-egyenleget.",
    loading: "Betöltés…",
    error: "Most nem érhető el ez az oldal. Próbáld újra hamarosan.",
  },
  en: {
    title: "Limited Beta — Founding Testers",
    intro:
      "Barkóba is currently in beta for everyone. Founding Tester is a " +
      "separate, approval-based role: applicants who are accepted get early " +
      "access and a voice in shaping community features.",
    everyoneNote:
      "Important: during this period EVERY player is in beta. Applying to " +
      "become a Founding Tester is a separate, optional role on top of that — " +
      "not a requirement to play.",
    needAccount: "You need to register or log in before applying.",
    needVerification: "You need to verify your email address before applying.",
    formLabel: "Why would you like to be a Founding Tester? (optional)",
    submit: "Submit application",
    submitting: "Submitting…",
    statusPending: "Your application is awaiting review.",
    statusApproved: "Congratulations! You are a Founding Tester.",
    statusRejected: "Your application was not accepted at this time.",
    rejectionReasonLabel: "Reason:",
    noCreditChange: "Applying or being accepted never grants or removes VERSENY balance.",
    loading: "Loading…",
    error: "This page is not available right now. Please try again soon.",
  },
} as const;

interface StatusResponse {
  enabled: boolean;
  account?: boolean;
  email_verified?: boolean;
  application?: { status: "pending" | "approved" | "rejected"; submitted_at: string; rejection_reason: string | null } | null;
}

export default function BetaClient({ versionLabel }: { versionLabel: string }) {
  const [lang, setLang] = useState<Lang>("hu");
  const [state, setState] = useState<
    | { step: "loading" }
    | { step: "error" }
    | { step: "loaded"; data: StatusResponse }
  >({ step: "loading" });
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const t = COPY[lang];

  const load = useCallback(async () => {
    setState({ step: "loading" });
    try {
      const res = await fetch("/api/beta/status", { cache: "no-store" });
      if (!res.ok) {
        setState({ step: "error" });
        return;
      }
      const data = (await res.json()) as StatusResponse;
      setState({ step: "loaded", data });
    } catch {
      setState({ step: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    setSubmitting(true);
    try {
      await fetch("/api/beta/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
    } finally {
      setSubmitting(false);
      void load();
    }
  }

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
      <p className="rounded-md border border-[var(--ink)]/15 bg-white/60 p-3 text-xs text-[var(--ink-soft)]">
        {t.everyoneNote}
      </p>
      <p className="text-xs text-[var(--ink-soft)]">{t.noCreditChange}</p>

      {state.step === "loading" && <p className="text-sm text-[var(--ink-soft)]">{t.loading}</p>}
      {state.step === "error" && <p className="text-sm text-[var(--red)]">{t.error}</p>}

      {state.step === "loaded" && state.data.account !== true && (
        <div className="flex flex-col gap-3 rounded-md border border-[var(--ink)]/15 bg-white/60 p-4">
          <p className="text-sm text-[var(--ink)]">{t.needAccount}</p>
          <ClaimPrompt />
        </div>
      )}

      {state.step === "loaded" && state.data.account === true && !state.data.email_verified && (
        <p className="rounded-md border border-[var(--red)]/30 bg-[var(--red)]/6 p-3 text-sm text-[var(--red)]">
          {t.needVerification}
        </p>
      )}

      {state.step === "loaded" &&
        state.data.account === true &&
        state.data.email_verified === true &&
        !state.data.application && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--ink)]">{t.formLabel}</span>
              <textarea
                className="h-24 w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--green)]"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
              />
            </label>
            <button
              onClick={() => void submit()}
              disabled={submitting}
              className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
            >
              {submitting ? t.submitting : t.submit}
            </button>
          </div>
        )}

      {state.step === "loaded" && state.data.application && (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/60 p-4">
          {state.data.application.status === "pending" && (
            <p className="text-sm text-[var(--ink)]">{t.statusPending}</p>
          )}
          {state.data.application.status === "approved" && (
            <p className="text-sm font-medium text-[var(--green)]">{t.statusApproved}</p>
          )}
          {state.data.application.status === "rejected" && (
            <>
              <p className="text-sm text-[var(--red)]">{t.statusRejected}</p>
              {state.data.application.rejection_reason && (
                <p className="text-xs text-[var(--ink-soft)]">
                  {t.rejectionReasonLabel} {state.data.application.rejection_reason}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </GameShell>
  );
}
