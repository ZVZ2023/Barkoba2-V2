"use client";

import { useCallback, useEffect, useState } from "react";
import RecoverPrompt from "./RecoverPrompt";
import AccountProfile from "./AccountProfile";
import WelcomeVideoSlot from "./WelcomeVideoSlot";
import { MAX_PLAYER_NAME_LENGTH } from "@/lib/playerIdentity";

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
  | { step: "pending_verification" }
  | { step: "protected" };

interface Props {
  /**
   * V2.6.x — suppress the already-authenticated view (recovery-code rotation
   * + AccountProfile's email/photo editor) on the game-result screen. An
   * authenticated player has nothing to DO here — registration is already
   * done, recovery is already done — so this branch is standing "Profil"
   * management with no connection to the game that just ended, and it
   * duplicates the header's own "Profil" button (AccountControl.tsx) exactly.
   * The offer/existing/pending_verification branches are unaffected: those
   * are things a player who just finished a game legitimately has to do
   * right here.
   */
  hideAccountManagement?: boolean;
  /**
   * V2.7.0 human-test fix — the "offer" step's copy, ONLY. True on the
   * dedicated /register page (app/register/RegisterClient.tsx), which is
   * where every post-game "Szeretnél még 5 játékot?" CTA now sends a
   * newcomer (see app/components/PostGameRegisterCTA.tsx) — "you just played
   * for the first time" is always true in that normal flow: a
   * never-registered guest gets exactly one complimentary game
   * (ENTITLEMENT_ANONYMOUS_GRANT), so arriving at registration at all means
   * this was it.
   *
   * Left false (default) everywhere else ClaimPrompt is reused —
   * Entitlement.tsx's CreditGateway, AccountControl.tsx, PurchaseClient.tsx —
   * because those are reachable from account/purchase menus at ANY time, not
   * only right after a first game. Only the offer step's TEXT branches on
   * this; the name/email fields, validation, and registration call are
   * unchanged and shared either way.
   */
  postGameOffer?: boolean;
}

export default function ClaimPrompt({ hideAccountManagement = false, postGameOffer = false }: Props = {}) {
  const [state, setState] = useState<State>({ step: "loading" });
  const [busy, setBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  // V2.7 — required at registration, unlike NamePrompt's separate, freely
  // skippable pre-game nicety. See the register route's own doc comment.
  const [name, setName] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotatedCode, setRotatedCode] = useState<string | null>(null);
  const [rotateCopied, setRotateCopied] = useState(false);
  // V2.7.x — "wrong email address" correction, pending_verification ONLY.
  // See the correctEmail() callback below for why this reuses
  // POST /api/account/email rather than a new endpoint.
  const [correctEmailOpen, setCorrectEmailOpen] = useState(false);
  const [correctedEmail, setCorrectedEmail] = useState("");
  const [correctBusy, setCorrectBusy] = useState(false);
  const [correctError, setCorrectError] = useState<string | null>(null);
  const [correctSent, setCorrectSent] = useState(false);

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
          // Prefill from a name already given to NamePrompt, so registration
          // does not make the player retype it. Still just a starting value —
          // the field stays editable and empty is still possible to clear.
          if (typeof data.name === "string" && data.name) setName(data.name);
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
        body: JSON.stringify({ email: email.trim(), name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRegisterError(data.message || "A regisztráció most nem sikerült.");
        return;
      }
      // V2.7.0 human-test fix — a fresh registration NEVER lands on the
      // recovery-code/profile-photo screen any more, here or anywhere else
      // ClaimPrompt is reused. Both capabilities already have a home on the
      // "protected" (Profil) branch below — "Új helyreállító kód
      // generálása" and AccountProfile's photo upload — reachable once the
      // player is verified and logged in, which is exactly what this screen
      // exists to get them to next.
      setState({ step: "pending_verification" });
    } catch {
      setRegisterError("Hálózati hiba — próbáld újra.");
    } finally {
      setBusy(false);
    }
  }, [email, name]);

  /**
   * V2.7.x — "Rossz e-mail-cím?" correction, reachable only while pending
   * verification. Calls the SAME POST /api/account/email that
   * AccountProfile.tsx's (verified-account) Profil form already uses — no
   * new endpoint, no new mechanism. That route already: resets
   * email_verified_at to null (the +5 grant stays gated exactly as before —
   * unaffected either way, since it was already null), overwrites the OLD
   * verification token's hash (the OLD link stops resolving), leaves
   * player_id/recovery_key/ledger/history untouched, and now (per this same
   * review) refuses a colliding address with no account-existence wording
   * and is rate-limited on two independent buckets.
   *
   * Stays on THIS screen on success — no navigation into Profil, no
   * exposure of anything beyond "we sent a new link".
   */
  const correctEmail = useCallback(async () => {
    setCorrectBusy(true);
    setCorrectError(null);
    try {
      const res = await fetch("/api/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: correctedEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCorrectError(data.message || "Ez most nem sikerült.");
        return;
      }
      setCorrectSent(true);
    } catch {
      setCorrectError("Hálózati hiba — próbáld újra.");
    } finally {
      setCorrectBusy(false);
    }
  }, [correctedEmail]);

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

  if (state.step === "pending_verification") {
    return (
      <div className={`${box} border-[var(--green)]/25 bg-white/50`}>
        <p className="text-sm font-semibold text-[var(--ink)]">Már majdnem kész!</p>
        <p className="text-sm text-[var(--ink)]">Elküldtük a megerősítő e-mailt.</p>
        <p className="text-xs text-[var(--ink-soft)]">
          Kattints a linkre az e-mailben, majd gyere vissza ide — utána azonnal
          megkapod az 5 további VERSENYT.
        </p>
        <p className="text-xs text-[var(--ink-soft)]">
          Amíg megérkezik, nézd meg ezt a kb. 30 másodperces videót arról, mi is
          a Barkóba.
        </p>
        <WelcomeVideoSlot />

        {correctSent ? (
          <p className="text-xs text-[var(--green)]">
            Új megerősítő e-mailt küldtünk a megadott címre.
          </p>
        ) : correctEmailOpen ? (
          <div className="flex flex-col gap-2 border-t border-[var(--ink)]/10 pt-3">
            <p className="text-xs text-[var(--ink)]">Add meg a helyes e-mail címet.</p>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              value={correctedEmail}
              onChange={(e) => setCorrectedEmail(e.target.value)}
              placeholder="te@pelda.hu"
              disabled={correctBusy}
              className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
            />
            <button
              onClick={() => void correctEmail()}
              disabled={correctBusy || !correctedEmail.trim()}
              className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
            >
              {correctBusy ? "Egy pillanat…" : "Módosítás"}
            </button>
            {correctError && <p className="text-xs text-[var(--red)]">{correctError}</p>}
          </div>
        ) : (
          <button
            onClick={() => setCorrectEmailOpen(true)}
            className="self-start border-t border-[var(--ink)]/10 pt-3 text-xs text-[var(--ink-soft)] underline underline-offset-2"
          >
            Rossz e-mail-cím? Módosítás
          </button>
        )}
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
      {postGameOffer ? (
        <>
          <p className="text-sm font-medium text-[var(--ink)]">
            Gratulálunk! Most játszottál először Barkóbát.
          </p>
          <p className="text-sm text-[var(--ink)]">Szeretnél még 5 játékot?</p>
          <p className="text-xs text-[var(--ink-soft)]">
            Regisztrálj egy általad választott játékosnévvel és egy megerősített
            e-mail-címmel.
          </p>
          <p className="text-xs text-[var(--ink-soft)]">
            Regisztrált játékosként további funkciók is elérhetővé válnak számodra
            — például versenyek és játékelőzmények — ahogy ezek megjelennek.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-[var(--ink)]">
            Regisztrálsz játékosfiókot?
          </p>
          <p className="text-xs text-[var(--ink-soft)]">
            Ugyanez a játékos és VERSENY-egyenleg marad meg. A belépési kóddal másik
            eszközön is bejelentkezhetsz. Jelszó nem kell, de egy név és egy
            megerősített e-mail cím igen.
          </p>
        </>
      )}
      <input
        type="text"
        autoComplete="nickname"
        maxLength={MAX_PLAYER_NAME_LENGTH}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Hogy szólítsunk?"
        disabled={busy}
        className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
      />
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
        disabled={busy || !email.trim() || !name.trim()}
        className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
      >
        Regisztráció
      </button>
      {registerError && <p className="text-xs text-[var(--red)]">{registerError}</p>}
    </div>
  );
}
