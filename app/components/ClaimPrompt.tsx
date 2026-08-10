"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * "Protect this player" — offered after a completed game, never before.
 *
 * A newcomer has nothing worth keeping and no reason to trust us with anything.
 * A player who has just finished a game does. That ordering is the reason there
 * is still no registration wall anywhere in Barkoba.
 */
type State =
  | { step: "loading" }
  | { step: "offer" }
  | { step: "code"; code: string }
  | { step: "protected" }
  | { step: "confirm_delete" };

export default function ClaimPrompt() {
  const [state, setState] = useState<State>({ step: "loading" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/player/claim");
        const data = await res.json();
        if (live) setState({ step: data.protected ? "protected" : "offer" });
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

  const claim = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/player/claim", { method: "POST" });
      const data = await res.json();
      setState(data.recovery_code ? { step: "code", code: data.recovery_code } : { step: "protected" });
    } catch {
      setState({ step: "offer" });
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/player/claim", { method: "DELETE" });
    } catch {
      // fall through — the reload below reflects whatever actually happened
    } finally {
      setBusy(false);
      window.location.reload();
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
            onClick={() => setState({ step: "protected" })}
            className="min-h-11 flex-1 rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm font-medium text-[var(--ink)]"
          >
            Elmentettem
          </button>
        </div>
      </div>
    );
  }

  if (state.step === "confirm_delete") {
    return (
      <div className={`${box} border-[var(--red)]/40 bg-[var(--red)]/6`}>
        <p className="text-sm text-[var(--ink)]">
          Ezzel véglegesen töröljük ezt a játékost: a nevét és a helyreállító kódját is.
          A kódod ezután nem működik többé, és ez nem vonható vissza.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => void remove()}
            disabled={busy}
            className="min-h-11 flex-1 rounded-md bg-[var(--red)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
          >
            Törlöm
          </button>
          <button
            onClick={() => setState({ step: "protected" })}
            disabled={busy}
            className="min-h-11 flex-1 rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm font-medium text-[var(--ink)]"
          >
            Mégsem
          </button>
        </div>
      </div>
    );
  }

  if (state.step === "protected") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--ink)]/15 bg-white/50 px-3 py-2">
        <p className="text-xs text-[var(--ink-soft)]">Ez a játékos védve van.</p>
        <button
          onClick={() => setState({ step: "confirm_delete" })}
          className="min-h-11 text-xs text-[var(--red)] underline underline-offset-2"
        >
          Játékos törlése
        </button>
      </div>
    );
  }

  return (
    <div className={`${box} border-[var(--ink)]/15 bg-white/50`}>
      <p className="text-sm font-medium text-[var(--ink)]">Megvédjem ezt a játékost?</p>
      <p className="text-xs text-[var(--ink-soft)]">
        Kapsz egy helyreállító kódot, amivel másik eszközön is ugyanez a játékos leszel.
        Nem kell regisztrálni, nem kérünk e-mail címet és jelszót sem.
      </p>
      <button
        onClick={() => void claim()}
        disabled={busy}
        className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
      >
        Megvédem
      </button>
    </div>
  );
}
