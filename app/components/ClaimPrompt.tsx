"use client";

import { useCallback, useEffect, useState } from "react";
import RecoverPrompt from "./RecoverPrompt";

/**
 * Register the current guest in place, preserving its player_id and ownership.
 *
 * A newcomer has nothing worth keeping and no reason to trust us with anything.
 * A player who has just finished a game does. That ordering is the reason there
 * is still no registration wall anywhere in Barkoba.
 */
type State =
  | { step: "loading" }
  | { step: "offer" }
  | { step: "existing" }
  | { step: "code"; code: string }
  | { step: "protected" };

export default function ClaimPrompt() {
  const [state, setState] = useState<State>({ step: "loading" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/account/register");
        const data = await res.json();
        if (live) {
          setState({
            step: data.authenticated ? "protected" : data.registered ? "existing" : "offer",
          });
        }
      } catch {
        // Identity unavailable or offline. Offering something that cannot work
        // is worse than offering nothing.
        if (live) setState({ step: "protected" });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const register = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/account/register", { method: "POST" });
      const data = await res.json();
      if (data.recovery_code) setState({ step: "code", code: data.recovery_code });
      else if (data.authenticated) window.location.reload();
      else setState({ step: "offer" });
    } catch {
      setState({ step: "offer" });
    } finally {
      setBusy(false);
    }
  }, []);

  if (state.step === "loading") return null;

  const box = "flex flex-col gap-3 rounded-md border p-4";

  if (state.step === "code") {
    return (
      <div className={`${box} border-[var(--blue)]/40 bg-[var(--blue)]/6`}>
        <p className="text-sm font-semibold text-[var(--blue)]">Mentsd el ezt a kódot.</p>
        <p className="break-all rounded-md border border-[var(--blue)]/30 bg-white/80 px-3 py-2 font-mono text-sm tracking-wide text-[var(--ink)]">
          {state.code}
        </p>
        <p className="text-xs text-[var(--ink-soft)]">
          Ezzel a kóddal tudod visszaszerezni ezt a játékost másik böngészőben vagy
          eszközön. Csak most mutatjuk meg: nálunk nem marad meg, és később nem tudjuk
          újra megmutatni. Ha elveszik, ez a játékos nem szerezhető vissza.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(state.code);
              setCopied(true);
            }}
            className="min-h-11 flex-1 rounded-md bg-[var(--blue)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
          >
            {copied ? "Másolva" : "Másolom"}
          </button>
          <button
            onClick={() => window.location.reload()}
            className="min-h-11 flex-1 rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm font-medium text-[var(--ink)]"
          >
            Elmentettem
          </button>
        </div>
      </div>
    );
  }

  if (state.step === "protected") {
    return (
      <div className="rounded-md border border-[var(--green)]/25 bg-white/50 px-3 py-2">
        <p className="text-sm text-[var(--green)]">Be vagy jelentkezve.</p>
      </div>
    );
  }

  if (state.step === "existing") {
    return (
      <div className={`${box} border-[var(--ink)]/15 bg-white/50`}>
        <p className="text-sm font-medium text-[var(--ink)]">Ez a játékos már regisztrált.</p>
        <p className="text-xs text-[var(--ink-soft)]">
          A régi eszközazonosító nem léptet be a fiókba. Használd a meglévő
          helyreállító kódodat.
        </p>
        <RecoverPrompt initiallyOpen />
      </div>
    );
  }

  return (
    <div className={`${box} border-[var(--ink)]/15 bg-white/50`}>
      <p className="text-sm font-medium text-[var(--ink)]">
        Regisztrálsz játékosfiókot?
      </p>
      <p className="text-xs text-[var(--ink-soft)]">
        Ugyanez a játékos és RACES-egyenleg marad meg. A belépési kóddal másik
        eszközön is bejelentkezhetsz; e-mail cím és jelszó nem kell.
      </p>
      <button
        onClick={() => void register()}
        disabled={busy}
        className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
      >
        Regisztráció
      </button>
    </div>
  );
}
