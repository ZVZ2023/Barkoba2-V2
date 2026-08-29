"use client";

import ClaimPrompt from "../components/ClaimPrompt";

interface Props {
  versionLabel: string;
}

/**
 * V2.7.0 human-test fix — the dedicated newcomer registration/welcome page.
 *
 * Human testing found two connected problems with the previous embedded
 * flow: the registration form living inside the adjudicated game-result
 * page, and — immediately after submitting name + email — a recovery-code
 * and profile-photo screen shown to a newcomer who hasn't even verified
 * their email yet. This page is PART of the fix: it gives registration its
 * own place, reached via app/components/PostGameRegisterCTA.tsx's simple
 * "Szeretnél még 5 játékot?" link from the result screen (and reachable
 * directly, e.g. a bookmark or a shared link).
 *
 * The actual form, its benefit-led copy, validation, the registration call,
 * and the new pending-verification screen are ALL the existing ClaimPrompt
 * (postGameOffer=true selects the benefit-led copy already approved in
 * human testing) — this page is a thin shell around it, reused rather than
 * rebuilt, matching every other dedicated page in this app.
 */
export default function RegisterClient({ versionLabel }: Props) {
  return (
    <main className="mx-auto flex w-full min-h-screen max-w-md flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--ink)]/10 pb-3">
        <a href="/" className="flex min-w-0 items-center gap-2" aria-label="Barkóba főoldal">
          <span
            aria-hidden="true"
            className="inline-block h-6 w-6 shrink-0 rounded-full border-[3px] border-[var(--ink)]/80"
            style={{ borderRightColor: "transparent" }}
          />
          <span className="truncate text-base font-semibold tracking-tight">Barkóba</span>
        </a>
      </header>

      <ClaimPrompt postGameOffer />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <a
          href="/"
          className="inline-flex min-h-11 items-center text-sm text-[var(--ink-soft)] underline-offset-2 hover:underline"
        >
          ← Vissza a Barkóba főoldalra
        </a>
        <span className="text-xs text-[var(--ink-soft)]" title="Telepített Barkóba verzió">
          {versionLabel}
        </span>
      </div>
    </main>
  );
}
