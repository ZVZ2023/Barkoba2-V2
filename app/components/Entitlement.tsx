"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlayState } from "@/lib/entitlements";
import ClaimPrompt from "./ClaimPrompt";

// ---------------------------------------------------------------------------
// V2.4 — what the player can see about their own entitlement, and where they
// go when it runs out.
//
// Until now a refused player was told "top up" and given nowhere to do it: the
// product named an action it could not perform, which reads as a bug rather
// than a boundary. These two pieces close that.
//
// All values come from GET /api/player/entitlement, which is itself only
// exposure of getStatus() and playCreditCostForBudget(). No balance or price is
// computed on the client — the server stays the sole authority, and the
// affordability marking below is a courtesy, never a decision.
// ---------------------------------------------------------------------------

export interface EntitlementView {
  enforced: boolean;
  balance: number | null;
  costs: Record<string, number>;
  /** Server-resolved. UI code must never infer this from balance or provenance. */
  play_state?: PlayState | null;
  /**
   * V2.6 — this identity holds a developer/tester unlimited-play grant.
   *
   * Optional because a client may briefly be running against an older
   * deployment that does not send the field. Absent is read as false, which is
   * the safe default: the badge falls back to showing the real balance rather
   * than claiming a privilege it cannot confirm.
   */
  unlimited?: boolean;
}

/** Shared fetch. Returns null when entitlement cannot be read at all. */
export function useEntitlement(
  enabled = true
): { view: EntitlementView | null; refresh: () => void } {
  const [view, setView] = useState<EntitlementView | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // Global headers render for anonymous traffic and crawlers too. Do not
    // turn those page views into ledger aggregates: the server wrapper enables
    // this only after it verifies an existing signed Player cookie.
    if (!enabled) return;

    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/player/entitlement", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as EntitlementView;
        if (live) setView(data);
      } catch {
        // A balance we cannot read is not zero. Render nothing rather than a
        // number that would be wrong.
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, nonce]);

  return { view, refresh: useCallback(() => setNonce((n) => n + 1), []) };
}

/**
 * The player's balance, shown wherever a game is started.
 *
 * Renders nothing when entitlement is not enforcing — there is no balance to
 * speak of, and a "0 credits" badge on an ungated deployment would be a lie.
 */
export function BalanceBadge({ view }: { view: EntitlementView | null }) {
  if (!view?.enforced) return null;

  if (view.play_state === "unlimited") {
    return (
      <div className="flex items-baseline gap-2 text-sm">
        <span className="text-neutral-600">Játékkereted</span>
        <span className="font-semibold text-[#1e3a24]">korlátlan</span>
        <span className="text-neutral-500">— fejlesztői hozzáférés</span>
      </div>
    );
  }

  if (view.play_state === "introductory_available") {
    return (
      <div className="text-sm font-medium text-[#1e3a24]">
        Kezdő játékkeret vár rád
      </div>
    );
  }

  if (view.play_state === "has_balance" && view.balance !== null) {
    return (
      <div className="flex items-baseline gap-2 text-sm">
        <span className="text-neutral-600">Játékkereted</span>
        <span className="font-semibold text-[#1e3a24]">{view.balance}</span>
      </div>
    );
  }

  if (view.play_state !== "exhausted") return null;

  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-neutral-600">Játékkereted</span>
      <span className="font-semibold text-[#1e3a24]">0</span>
      <span className="text-[#8b2f2f]">— elfogyott</span>
    </div>
  );
}

type Step = "closed" | "checking" | "need_claim" | "ready" | "intent" | "error";

/**
 * The gateway a refused player is offered.
 *
 * CLAIM BEFORE PURCHASE. If the player has no recovery credential they are sent
 * to the existing claim flow first, reusing ClaimPrompt unchanged. That
 * ordering is what lets purchased credits attach to an identity the player can
 * recover, without Barkóba ever holding a raw credential.
 *
 * The server enforces the same rule independently: /api/entitlement/intent
 * refuses to mint a reference for an unclaimed player. This screen is the
 * courteous path to it, not the guarantee.
 */
export function CreditGateway({ onBalanceMayHaveChanged }: { onBalanceMayHaveChanged?: () => void }) {
  const [step, setStep] = useState<Step>("closed");
  const [ref, setRef] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const checkClaimed = useCallback(async () => {
    setStep("checking");
    try {
      const res = await fetch("/api/player/claim", { cache: "no-store" });
      const data = await res.json();
      setStep(data?.protected ? "ready" : "need_claim");
    } catch {
      setStep("error");
      setMessage("Most nem érjük el a játékosodat. Próbáld újra.");
    }
  }, []);

  const createIntent = useCallback(async () => {
    try {
      const res = await fetch("/api/entitlement/intent", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        // Most likely claim_required — the server's own guard firing.
        setStep(data?.error === "claim_required" ? "need_claim" : "error");
        setMessage(data?.message ?? "Most nem sikerült elindítani a vásárlást.");
        return;
      }
      setRef(data.purchase_ref);
      setStep("intent");
      onBalanceMayHaveChanged?.();
    } catch {
      setStep("error");
      setMessage("Hálózati hiba — próbáld újra.");
    }
  }, [onBalanceMayHaveChanged]);

  if (step === "closed") {
    return (
      <button
        onClick={() => void checkClaimed()}
        className="min-h-11 self-start rounded-md bg-[#1e3a24] px-4 py-2 text-sm font-medium text-[#f6ece0]"
      >
        Kérek még játékkeretet
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-900/15 bg-white/70 p-4">
      {step === "checking" && <p className="text-sm text-neutral-700">Egy pillanat…</p>}

      {step === "need_claim" && (
        <>
          <p className="text-sm font-medium">Előbb mentsd el a játékosodat</p>
          <p className="text-sm text-neutral-700">
            Így a keret, amit szerzel, akkor is a tiéd marad, ha böngészőt vagy
            eszközt váltasz. Kapsz egy helyreállító kódot — tedd el jól.
          </p>
          <ClaimPrompt />
          <button
            onClick={() => void checkClaimed()}
            className="min-h-11 self-start rounded-md border border-neutral-900/25 px-4 py-2 text-sm"
          >
            Kész, mentettem — tovább
          </button>
        </>
      )}

      {step === "ready" && (
        <>
          <p className="text-sm font-medium">A játékosod mentve van.</p>
          <p className="text-sm text-neutral-700">
            Most már biztonságosan szerezhetsz további játékkeretet.
          </p>
          <button
            onClick={() => void createIntent()}
            className="min-h-11 self-start rounded-md bg-[#1e3a24] px-4 py-2 text-sm font-medium text-[#f6ece0]"
          >
            Tovább a vásárláshoz
          </button>
        </>
      )}

      {step === "intent" && (
        <>
          <p className="text-sm font-medium">Vásárlási azonosító</p>
          <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs">{ref}</code>
          <p className="text-sm text-neutral-700">
            A vásárlási lépés még nem élesedett. Amint elérhető, ezzel az
            azonosítóval kerül a keret a te játékosodhoz.
          </p>
        </>
      )}

      {step === "error" && <p className="text-sm text-[#8b2f2f]">{message}</p>}
    </div>
  );
}
