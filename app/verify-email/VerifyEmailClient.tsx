"use client";

import { useEffect, useState } from "react";

type State =
  | { step: "loading" }
  | { step: "pending"; token: string }
  | { step: "verifying"; token: string }
  | { step: "success"; email: string | null; recoveryCode: string }
  | { step: "already_verified"; email: string | null }
  | { step: "failed"; message: string };

/**
 * V2.7.x — the human-facing verification landing page.
 *
 * PAGE LOAD IS READ-ONLY. It calls GET /api/account/verify-email, which only
 * checks status — it never verifies an email or rotates a recovery key. This
 * matters: email security scanners and link-prefetch systems fetch a link's
 * URL automatically, and would otherwise become the first "caller",
 * consuming the newcomer's one-time recovery code before they ever saw the
 * page. Verification only happens from an explicit "Fiókom megerősítése"
 * click below, which POSTs — never from this effect, a mount, a preload, or
 * navigation.
 *
 * Reads `token` from the URL in an effect rather than useSearchParams(), the
 * same choice PurchaseReturn.tsx already made and explains in its own header
 * comment: the hook forces a Suspense boundary this page does not otherwise
 * need.
 */
export default function VerifyEmailClient() {
  const [state, setState] = useState<State>({ step: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const token = new URL(window.location.href).searchParams.get("token") ?? "";
      if (!token) {
        if (live) setState({ step: "failed", message: "Hiányzik a megerősítő kód." });
        return;
      }
      try {
        const res = await fetch(
          `/api/account/verify-email?token=${encodeURIComponent(token)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!live) return;
        if (data.status === "already_verified") {
          setState({ step: "already_verified", email: data.email ?? null });
        } else if (data.status === "pending") {
          setState({ step: "pending", token });
        } else {
          setState({ step: "failed", message: data.message || "A megerősítés most nem sikerült." });
        }
      } catch {
        if (live) setState({ step: "failed", message: "Hálózati hiba — próbáld újra." });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function confirmVerification(token: string) {
    setState({ step: "verifying", token });
    try {
      const res = await fetch("/api/account/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok || !data.verified) {
        setState({ step: "failed", message: data.message || "A megerősítés most nem sikerült." });
        return;
      }
      if (data.already_verified) {
        setState({ step: "already_verified", email: data.email ?? null });
      } else {
        setState({ step: "success", email: data.email ?? null, recoveryCode: data.recovery_code });
      }
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

  if (state.step === "pending" || state.step === "verifying") {
    return shell(
      <div className="flex w-full flex-col gap-3 rounded-md border border-[var(--ink)]/15 bg-white/50 p-5">
        <p className="text-base font-semibold text-[var(--ink)]">Már majdnem kész!</p>
        <p className="text-sm text-[var(--ink-soft)]">
          Kattints a gombra a fiókod megerősítéséhez.
        </p>
        <button
          onClick={() => void confirmVerification(state.token)}
          disabled={state.step === "verifying"}
          className="min-h-11 inline-flex w-fit self-center items-center rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
        >
          {state.step === "verifying" ? "Egy pillanat…" : "Fiókom megerősítése"}
        </button>
      </div>
    );
  }

  if (state.step === "already_verified") {
    return shell(
      <div className="flex w-full flex-col gap-3 rounded-md border border-[var(--green)]/25 bg-white/50 p-5">
        <p className="text-base font-semibold text-[var(--ink)]">
          Ezt a címet már megerősítetted.
        </p>
        <p className="text-sm text-[var(--ink-soft)]">A fiókod készen áll — folytasd a Barkóbában.</p>
        <a
          href="/"
          className="min-h-11 inline-flex w-fit self-center items-center rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
        >
          Tovább a Barkóbához
        </a>
      </div>
    );
  }

  // success
  return shell(
    <div className="flex w-full flex-col gap-4 rounded-md border border-[var(--green)]/25 bg-white/50 p-5">
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-[var(--ink)]">
          Sikeres megerősítés! Üdv a Barkóbában.
        </p>
        <p className="text-sm text-[var(--ink-soft)]">Megkaptad az 5 további VERSENYT.</p>
      </div>

      <div className="flex flex-col gap-2 rounded-md border border-[var(--blue)]/40 bg-[var(--blue)]/6 p-4 text-left">
        <p className="text-sm font-semibold text-[var(--blue)]">Mentsd el ezt a kódot.</p>
        <p className="break-all rounded-md border border-[var(--blue)]/30 bg-white/80 px-3 py-2 font-mono text-sm tracking-wide text-[var(--ink)]">
          {state.recoveryCode}
        </p>
        <p className="text-xs text-[var(--ink-soft)]">
          Ezzel a kóddal jutsz vissza a játékosodhoz, ha elveszik a bejelentkezésed.
          Csak most mutatjuk meg — később nem tudjuk újra megjeleníteni.
        </p>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(state.recoveryCode);
            setCopied(true);
          }}
          className="min-h-11 self-start rounded-md bg-[var(--blue)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
        >
          {copied ? "Másolva" : "Másolom"}
        </button>
      </div>

      <a
        href="/"
        className="min-h-11 inline-flex w-fit self-center items-center rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
      >
        Tovább a Barkóbához
      </a>
    </div>
  );
}
