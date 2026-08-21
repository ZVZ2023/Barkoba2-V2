"use client";

import { useState } from "react";
import ClaimPrompt from "./ClaimPrompt";
import RecoverPrompt from "./RecoverPrompt";

/**
 * V2.6.x — was two return paths: authenticated meant an immediate logout
 * button with no way to reach the account modal at all, so a logged-in
 * player's only route to their own profile was finishing a game and using
 * the ClaimPrompt embedded in the result screen. Now the modal opens either
 * way — its content differs (login/registration vs. profile + logout), not
 * its reachability. This component renders in SiteHeader on every page that
 * includes it (home, /play, every content page), so "Profil" is now visible
 * and reachable any time the player is logged in, independent of gameplay.
 */
export default function AccountControl({ authenticated }: { authenticated: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    try {
      const res = await fetch("/api/account/logout", { method: "POST" });
      if (res.ok) window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-neutral-900/20 px-2.5 py-2 text-sm text-neutral-800 sm:min-h-11 sm:px-3"
      >
        <span aria-hidden="true" className="shrink-0">👤</span>
        <span className="truncate">{authenticated ? "Profil" : "Regisztráció / Belépés"}</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Játékosfiók"
            className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-xl bg-[var(--parchment)] p-5 text-left shadow-xl"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Játékosfiók</h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Bezárás"
                className="min-h-11 min-w-11 rounded-md border border-neutral-900/20 text-lg"
              >
                ×
              </button>
            </div>
            <ClaimPrompt />
            {authenticated ? (
              <div className="border-t border-neutral-900/10 pt-3">
                <button
                  onClick={() => void logout()}
                  disabled={busy}
                  className="min-h-11 self-start rounded-md border border-neutral-900/20 px-4 py-2.5 text-sm text-neutral-800 disabled:opacity-40"
                >
                  Kijelentkezés
                </button>
              </div>
            ) : (
              <div className="border-t border-neutral-900/10 pt-3">
                <RecoverPrompt initiallyOpen />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
