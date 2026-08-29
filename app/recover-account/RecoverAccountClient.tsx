"use client";

import { useEffect, useState } from "react";

type State =
  | { step: "loading" }
  | { step: "pending"; token: string }
  | { step: "recovering"; token: string }
  | { step: "success"; displayName: string | null }
  | { step: "failed"; message: string };

/**
 * V2.7.x — the human-facing account-recovery landing page.
 *
 * PAGE LOAD IS READ-ONLY, same scanner-safe reasoning as
 * app/verify-email/VerifyEmailClient.tsx: GET /api/account/recovery-confirm
 * only checks status. The session is issued only from an explicit
 * "Fiókom visszaállítása" click below, which POSTs.
 *
 * Reads `token` from the URL in an effect rather than useSearchParams(), the
 * same choice PurchaseReturn.tsx and VerifyEmailClient.tsx already made.
 */
export default function RecoverAccountClient() {
  const [state, setState] = useState<State>({ step: "loading" });

  useEffect(() => {
    let live = true;
    void (async () => {
      const token = new URL(window.location.href).searchParams.get("token") ?? "";
      if (!token) {
        if (live) setState({ step: "failed", message: "Hiányzik a visszaállítási kód." });
        return;
      }
      try {
        const res = await fetch(
          `/api/account/recovery-confirm?token=${encodeURIComponent(token)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!live) return;
        if (data.status === "pending") {
          setState({ step: "pending", token });
        } else {
          setState({
            step: "failed",
            message: "Ez a link érvénytelen, lejárt, vagy már felhasznált.",
          });
        }
      } catch {
        if (live) setState({ step: "failed", message: "Hálózati hiba — próbáld újra." });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function confirmRecovery(token: string) {
    setState({ step: "recovering", token });
    try {
      const res = await fetch("/api/account/recovery-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok || !data.recovered) {
        setState({
          step: "failed",
          message: data.message || "Ez a link érvénytelen, lejárt, vagy már felhasznált.",
        });
        return;
      }
      setState({ step: "success", displayName: data.display_name ?? null });
    } catch {
      setState({ step: "failed", message: "Hálózati hiba — próbáld újra." });
    }
  }

  const shell = (children: React.ReactNode) => (
    <main className="mx-auto flex w-full min-h-screen max-w-md flex-col items-center justify-center gap-6 px-4 py-8 text-center sm:px-6">
      {children}
    </main>
  );

  if (state.step === "loading") {
    return shell(<p className="text-sm text-[var(--ink-soft)]">Egy pillanat…</p>);
  }

  if (state.step === "failed") {
    return shell(
      <div className="flex w-full flex-col gap-3 rounded-md border border-[var(--red)]/30 bg-[var(--red)]/6 p-5">
        <p className="text-sm font-medium text-[var(--ink)]">{state.message}</p>
        <a
          href="/"
          className="min-h-11 inline-flex w-fit self-center items-center rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm font-medium text-[var(--ink)]"
        >
          Vissza a Barkóbához
        </a>
      </div>
    );
  }

  if (state.step === "pending" || state.step === "recovering") {
    return shell(
      <div className="flex w-full flex-col gap-3 rounded-md border border-[var(--ink)]/15 bg-white/50 p-5">
        <p className="text-base font-semibold text-[var(--ink)]">Fiók visszaállítása</p>
        <p className="text-sm text-[var(--ink-soft)]">
          Kattints a gombra, hogy visszaállítsd a hozzáférésed ehhez a fiókhoz.
        </p>
        <button
          onClick={() => void confirmRecovery(state.token)}
          disabled={state.step === "recovering"}
          className="min-h-11 inline-flex w-fit self-center items-center rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
        >
          {state.step === "recovering" ? "Egy pillanat…" : "Fiókom visszaállítása"}
        </button>
      </div>
    );
  }

  // success
  return shell(
    <div className="flex w-full flex-col gap-3 rounded-md border border-[var(--green)]/25 bg-white/50 p-5">
      <p className="text-base font-semibold text-[var(--ink)]">
        {state.displayName ? `Szia, ${state.displayName}! Visszaálltál a fiókodba.` : "Visszaálltál a fiókodba."}
      </p>
      <a
        href="/"
        className="min-h-11 inline-flex w-fit self-center items-center rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
      >
        Tovább a Barkóbához
      </a>
    </div>
  );
}
