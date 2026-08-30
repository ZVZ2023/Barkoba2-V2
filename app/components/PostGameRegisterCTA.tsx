"use client";

import { useEffect, useState } from "react";

type State = "loading" | "offer" | "purchase" | "hidden";

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
 *
 * V2.7.0.16 PRODUCTION FIX — a verified account that spends its final Play
 * Credit used to see NOTHING here (not "hidden" as a considered choice, a
 * genuine gap: this component only ever had "offer" or "hidden", and the
 * result screen renders no other purchase entry point at all). The
 * newcomer's actual next step — buy more — had no CTA anywhere on the one
 * screen where they had just discovered they were out.
 *
 * DELIBERATELY NOT balance-alone. /api/player/entitlement's play_state
 * collapses to "exhausted" for BOTH a verified account that used all 5 AND
 * an unverified/never-registered guest that used their one anonymous game —
 * resolvePlayState() has no verification concept, by design (see its own
 * doc comment). Distinguishing "should this be a purchase offer" from
 * "should this be a registration offer" requires the account's CURRENT
 * verification state specifically — /api/account/profile's email_verified,
 * the same signal CreditGateway/PurchaseClient already gate purchase on —
 * not an inference from the credit count alone.
 *
 * Never offers purchase to an unverified account: an unverified identity
 * cannot purchase either (see /api/entitlement/intent's own gate), and
 * re-showing "register" to someone who already has an account would be
 * wrong too — so that case, like before this fix, shows nothing.
 */
export default function PostGameRegisterCTA() {
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const profileRes = await fetch("/api/account/profile", { cache: "no-store" });

        if (profileRes.status === 401) {
          // Not an authenticated account session — the exact case the
          // original registration-teaser check already handled correctly
          // (a true guest sees "offer"; a registered-but-session-less
          // device, which cannot purchase either, sees "hidden").
          const registerRes = await fetch("/api/account/register");
          const registerData = await registerRes.json();
          if (live) setState(registerData.registered ? "hidden" : "offer");
          return;
        }
        if (!profileRes.ok) {
          if (live) setState("hidden");
          return;
        }

        const profile = await profileRes.json();
        if (!profile.email_verified) {
          // Registered but not yet verified: cannot purchase, and already
          // has an account, so neither CTA applies.
          if (live) setState("hidden");
          return;
        }

        const entitlementRes = await fetch("/api/player/entitlement", { cache: "no-store" });
        const entitlement = await entitlementRes.json();
        if (live) {
          setState(entitlement.play_state === "exhausted" ? "purchase" : "hidden");
        }
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

  if (state === "purchase") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
        <p className="text-sm font-medium text-[var(--ink)]">Elfogyott a VERSENY-egyenleged.</p>
        <a
          href="/purchase"
          className="min-h-11 inline-flex w-fit items-center rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
        >
          További VERSENY
        </a>
      </div>
    );
  }

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
