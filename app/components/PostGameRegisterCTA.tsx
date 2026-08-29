"use client";

import { useEffect, useState } from "react";

type State = "loading" | "offer" | "hidden";

/**
 * V2.7.0 human-test fix — the game-result screen's ENTIRE registration
 * footprint, replacing the full <ClaimPrompt /> that used to render there.
 *
 * Human testing found the adjudicated result page carrying account/recovery
 * mechanics (login codes, other-device access, no-password framing) at the
 * exact moment a newcomer needs only the benefit of registering. The fix
 * moves the actual registration experience off this page entirely: this
 * component is a teaser only — one line of benefit copy and a link to the
 * dedicated /register page (app/register/), which owns the real form.
 *
 * STILL CHECKS REGISTRATION STATE, unlike a static link, so an already-
 * registered player playing a later game does not see a "register" CTA on
 * their own result screen — reuses the same GET /api/account/register
 * ClaimPrompt itself already reads, no new endpoint.
 */
export default function PostGameRegisterCTA() {
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/account/register");
        const data = await res.json();
        if (live) setState(data.registered ? "hidden" : "offer");
      } catch {
        // Identity unavailable or offline — offering a CTA that cannot work
        // is worse than offering nothing.
        if (live) setState("hidden");
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (state !== "offer") return null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
      <p className="text-sm font-medium text-[var(--ink)]">Szeretnél még 5 játékot?</p>
      <a
        href="/register"
        className="min-h-11 inline-flex w-fit items-center rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
      >
        Regisztráció
      </a>
    </div>
  );
}
