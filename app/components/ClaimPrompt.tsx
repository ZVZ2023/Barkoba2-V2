"use client";

import { useCallback, useEffect, useState } from "react";
import RecoverPrompt from "./RecoverPrompt";
import ProfilePhotoPrompt from "./ProfilePhotoPrompt";
import AccountProfile from "./AccountProfile";

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

interface Props {
  /**
   * V2.6.x — suppress the already-authenticated view (recovery-code rotation
   * + AccountProfile's email/photo editor) on the game-result screen. An
   * authenticated player has nothing to DO here — registration is already
   * done, recovery is already done — so this branch is standing "Profil"
   * management with no connection to the game that just ended, and it
   * duplicates the header's own "Profil" button (AccountControl.tsx) exactly.
   * The offer/existing/code branches are unaffected: those are things a
   * player who just finished a game legitimately has to do right here.
   */
  hideAccountManagement?: boolean;
}

export default function ClaimPrompt({ hideAccountManagement = false }: Props = {}) {
  const [state, setState] = useState<State>({ step: "loading" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotatedCode, setRotatedCode] = useState<string | null>(null);
  const [rotateCopied, setRotateCopied] = useState(false);

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
    setRegisterError(null);
    try {
      const res = await fetch("/api/account/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRegisterError(data.message || "A regisztráció most nem sikerült.");
        return;
      }
      if (data.recovery_code) setState({ step: "code", code: data.recovery_code });
      else if (data.authenticated) window.location.reload();
      else setState({ step: "offer" });
    } catch {
      setRegisterError("Hálózati hiba — próbáld újra.");
    } finally {
      setBusy(false);
    }
  }, [email]);

  const resetIdentity = useCallback(async () => {
    setResetBusy(true);
    setResetError(null);
    try {
      const res = await fetch("/api/account/reset-identity", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setResetError(data.message || "Ez most nem sikerült.");
        return;
      }
      window.location.reload();
    } catch {
      setResetError("Hálózati hiba — próbáld újra.");
    } finally {
      setResetBusy(false);
    }
  }, []);

  const rotateRecoveryCode = useCallback(async () => {
    setRotateBusy(true);
    setRotateError(null);
    try {
      const res = await fetch("/api/account/rotate-recovery-code", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setRotateError(data.message || "A kód cseréje most nem sikerült.");
        return;
      }
      setRotatedCode(data.recovery_code);
      setRotateCopied(false);
    } catch {
      setRotateError("Hálózati hiba — próbáld újra.");
    } finally {
      setRotateBusy(false);
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
        <div className="border-t border-[var(--ink)]/10 pt-3">
          <ProfilePhotoPrompt />
        </div>
      </div>
    );
  }

  if (state.step === "protected") {
    if (hideAccountManagement) return null;

    if (rotatedCode) {
      return (
        <div className={`${box} border-[var(--blue)]/40 bg-[var(--blue)]/6`}>
          <p className="text-sm font-semibold text-[var(--blue)]">Mentsd el ezt az új kódot.</p>
          <p className="break-all rounded-md border border-[var(--blue)]/30 bg-white/80 px-3 py-2 font-mono text-sm tracking-wide text-[var(--ink)]">
            {rotatedCode}
          </p>
          <p className="text-xs text-[var(--ink-soft)]">
            A régi kód mostantól nem működik. Csak most mutatjuk meg: nálunk nem marad
            meg, és később nem tudjuk újra megmutatni.
          </p>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(rotatedCode);
              setRotateCopied(true);
            }}
            className="min-h-11 self-start rounded-md bg-[var(--blue)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
          >
            {rotateCopied ? "Másolva" : "Másolom"}
          </button>
        </div>
      );
    }

    return (
      <div className={`${box} border-[var(--green)]/25 bg-white/50`}>
        <p className="text-sm text-[var(--green)]">Be vagy jelentkezve.</p>
        <button
          onClick={() => void rotateRecoveryCode()}
          disabled={rotateBusy}
          className="min-h-11 self-start rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm font-medium text-[var(--ink)] disabled:opacity-40"
        >
          Új helyreállító kód generálása
        </button>
        {rotateError && <p className="text-sm text-[var(--red)]">{rotateError}</p>}
        <AccountProfile />
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
        <div className="flex flex-col gap-2 border-t border-[var(--ink)]/10 pt-3">
          <p className="text-xs text-[var(--ink-soft)]">
            A régi fiók nem törlődik. Ez a böngésző új játékosként indul tovább.
          </p>
          <button
            onClick={() => void resetIdentity()}
            disabled={resetBusy}
            className="min-h-11 self-start rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm font-medium text-[var(--ink)] disabled:opacity-40"
          >
            Új fiók létrehozása
          </button>
          {resetError && <p className="text-sm text-[var(--red)]">{resetError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={`${box} border-[var(--ink)]/15 bg-white/50`}>
      <p className="text-sm font-medium text-[var(--ink)]">
        Regisztrálsz játékosfiókot?
      </p>
      <p className="text-xs text-[var(--ink-soft)]">
        Ugyanez a játékos és VERSENY-egyenleg marad meg. A belépési kóddal másik
        eszközön is bejelentkezhetsz. Jelszó nem kell, de egy megerősített
        e-mail cím igen.
      </p>
      <input
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="te@pelda.hu"
        disabled={busy}
        className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
      />
      <button
        onClick={() => void register()}
        disabled={busy || !email.trim()}
        className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
      >
        Regisztráció
      </button>
      {registerError && <p className="text-xs text-[var(--red)]">{registerError}</p>}
    </div>
  );
}
