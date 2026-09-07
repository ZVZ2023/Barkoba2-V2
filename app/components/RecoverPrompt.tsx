"use client";

import { useState } from "react";

/**
 * "I have played before" — restores an existing Player onto this browser.
 *
 * Collapsed by default. A returning player on a new device is the rare case;
 * putting an input box in front of everyone else would be its own kind of wall.
 *
 * V2.7.x — gained a second, independent path alongside the recovery code:
 * a verified account can always get a fresh login link by email
 * (POST /api/account/recovery-request → app/recover-account/), for a player
 * who never saved/generated a code. The code path below is completely
 * unchanged; this only adds a toggle to an alternative, not a replacement.
 *
 * V2.9.2.3 PRODUCTION FIX — a report of "clicked the email-recovery link
 * three times, no visible change, no email received". Traced: the "Nincs
 * meg a kódod? Kérj linket e-mailben" control's onClick only ever calls
 * setMode("email") — it has never sent a network request; POST
 * /api/account/recovery-request is only reached from the SEPARATE "Link
 * küldése" button below, one more step later. So "no email" was correctly
 * explained by "no request was ever sent" (confirmed by reading this file,
 * not assumed as an email-delivery problem) -- the click target reported
 * never calls fetch at all. That step-toggle itself was, and remains,
 * functionally correct (mode does change), but nothing signalled it: the
 * email-mode form is a different but similarly-shaped box with no strong
 * visual cue, and the actual submit button gave no busy-state feedback
 * (just `disabled`, indistinguishable at a glance from "did nothing"). Two
 * fixes below make the transition and the submission itself unmistakable:
 * the email input autofocuses the moment this step appears (moves the
 * caret, and browsers scroll a newly-focused field into view on their
 * own), and the submit button's own label changes while the request is in
 * flight. Neither touches app/api/account/recovery-request/route.ts's
 * response shape, rate limits, or its deliberate "always the same generic
 * message" contract -- see that route's own header for why every outcome
 * (no account, unverified, verified, either rate limit) must stay
 * indistinguishable.
 */
export default function RecoverPrompt({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [mode, setMode] = useState<"code" | "email">("code");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  async function recover() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.message || "Ez a kód nem érvényes.");
      else {
        setDone(data.display_name || "");
        window.location.reload();
      }
    } catch {
      setError("Hálózati hiba — próbáld újra.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * ALWAYS resolves to the same visible outcome (emailSent=true), whatever
   * the server actually did. app/api/account/recovery-request/route.ts
   * returns byte-identical 200 responses for every case it distinguishes
   * internally — no account, unverified, verified, IP rate-limited, or
   * target-email rate-limited — specifically so this component has no
   * observable branch to react to beyond a genuine network failure.
   */
  async function requestEmailLink() {
    setEmailBusy(true);
    setError(null);
    try {
      await fetch("/api/account/recovery-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setEmailSent(true);
    } catch {
      setError("Hálózati hiba — próbáld újra.");
    } finally {
      setEmailBusy(false);
    }
  }

  if (done !== null) {
    return (
      <p className="rounded-md border border-[var(--green)]/30 bg-[var(--green)]/6 px-3 py-2 text-sm text-[var(--green)]">
        {done ? `Szia, ${done}! Bejelentkeztél.` : "Bejelentkeztél."}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="min-h-11 self-start text-sm text-[var(--ink-soft)] underline underline-offset-2"
      >
        Bejelentkezés meglévő fiókba
      </button>
    );
  }

  if (mode === "email") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
        {emailSent ? (
          <p className="text-sm text-[var(--ink)]">
            Ha ehhez az e-mail címhez tartozik megerősített Barkóba fiók, elküldtük a
            visszaállítási linket. Nézd meg a postaládád.
          </p>
        ) : (
          <>
            <p className="text-sm text-[var(--ink)]">
              Nincs meg a kódod? Kérj egy belépő linket a megerősített e-mail címedre.
            </p>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="te@pelda.hu"
              disabled={emailBusy}
            />
            <button
              onClick={() => void requestEmailLink()}
              disabled={emailBusy || !email.trim()}
              className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
            >
              {emailBusy ? "Küldés…" : "Link küldése"}
            </button>
            {error && <p className="text-sm text-[var(--red)]">{error}</p>}
          </>
        )}
        <button
          onClick={() => {
            setMode("code");
            setError(null);
          }}
          className="self-start text-xs text-[var(--ink-soft)] underline underline-offset-2"
        >
          Mégis a kóddal jelentkezem be
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
      <p className="text-sm text-[var(--ink)]">Írd be a belépési/helyreállító kódodat.</p>
      <input
        spellCheck={false}
        autoCapitalize="characters"
        autoCorrect="off"
        className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 font-mono text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="BARKOBA-..."
        disabled={busy}
      />
      <button
        onClick={() => void recover()}
        disabled={busy || !code.trim()}
        className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
      >
        Bejelentkezés
      </button>
      {error && <p className="text-sm text-[var(--red)]">{error}</p>}
      <button
        onClick={() => {
          setMode("email");
          setError(null);
        }}
        className="self-start text-xs text-[var(--ink-soft)] underline underline-offset-2"
      >
        Nincs meg a kódod? Kérj linket e-mailben
      </button>
    </div>
  );
}
