"use client";

import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// V2.6 — the purchase return leg.
//
// THE PROBLEM THIS EXISTS TO SOLVE, stated plainly: Stripe's success redirect
// races its own webhook. The player's browser can arrive back here before the
// payment provider has told the payment-side Vercel adapter anything, so a
// naive refresh shows the
// OLD balance to someone who has just paid. That is the single most likely way
// a working bridge looks broken.
//
// THE SHAPE OF THE ANSWER — one immediate read, ONE delayed re-check, then
// stop.
//
// A polling loop was considered and rejected. It would keep an unbounded
// number of returned tabs hitting an entitlement query indefinitely, and it
// would still have to give up eventually — a loop only moves the moment of
// honesty later while multiplying the load that gets it there.
//
// WHAT IT MUST NEVER DO: report failure. This component cannot see the
// payment. It sees a balance that has or has not moved yet, and those are
// different facts. A webhook delayed by thirty seconds is not a failed
// payment, and telling a player their money did not arrive — when it did — is
// worse than telling them nothing at all. The unresolved state is therefore
// deliberately NEUTRAL: it says the credit has not appeared YET.
//
// CREDIT IS NEVER GRANTED HERE. This is display only. The browser's return
// trip is cosmetic — value moves on the Stripe → payment adapter → grant path and
// nowhere else. Nothing in this file can change a balance, and nothing in it
// should ever be able to.
// ---------------------------------------------------------------------------

/** How long to wait before the single re-check. */
const RECHECK_DELAY_MS = 4000;

type Phase = "checking" | "credited" | "pending";

interface EntitlementSnapshot {
  enforced: boolean;
  balance: number | null;
  unlimited?: boolean;
}

async function readBalance(): Promise<EntitlementSnapshot | null> {
  try {
    const res = await fetch("/api/player/entitlement", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as EntitlementSnapshot;
  } catch {
    // A balance we cannot read is not a balance of zero, and it is certainly
    // not a failed payment. Treated as "not yet", like every other unresolved
    // case here.
    return null;
  }
}

/** Has the purchase visibly landed? */
function credited(snapshot: EntitlementSnapshot | null): boolean {
  if (!snapshot) return false;
  if (snapshot.unlimited) return true;
  return typeof snapshot.balance === "number" && snapshot.balance > 0;
}

/**
 * Detects the return, renders the panel once, and cleans the URL.
 *
 * READS `window.location.search` IN AN EFFECT rather than useSearchParams().
 * The hook forces a Suspense boundary and opts the route out of static
 * rendering in Next 14; this needs neither, and /play is otherwise an
 * ordinary server-rendered page that should stay one.
 *
 * THE PARAMETER IS STRIPPED IMMEDIATELY, not after the checks resolve. A
 * player who refreshes during the delayed re-check would otherwise replay the
 * whole return sequence — and, worse, would keep replaying it every time they
 * returned to that URL from history days later. `replaceState` leaves no back-
 * button trap: there is no extra entry to step back into.
 *
 * Losing the confirmation panel on a mid-check refresh is the accepted cost.
 * The balance badge is authoritative and will show the truth either way.
 */
export function PurchaseReturnSlot({ onResolved }: { onResolved?: () => void }) {
  const [returning, setReturning] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("purchase") !== "return") return;

    setReturning(true);
    url.searchParams.delete("purchase");
    const clean = url.pathname + (url.search || "") + url.hash;
    window.history.replaceState(null, "", clean);
  }, []);

  if (!returning) return null;
  return <PurchaseReturn onResolved={onResolved} />;
}

export default function PurchaseReturn({ onResolved }: { onResolved?: () => void }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (snapshot: EntitlementSnapshot | null, next: Phase) => {
      if (!live) return;
      setBalance(snapshot?.balance ?? null);
      setPhase(next);
      onResolved?.();
    };

    void (async () => {
      // 1. Immediate authoritative read.
      const first = await readBalance();
      if (!live) return;
      if (credited(first)) {
        settle(first, "credited");
        return;
      }

      // 2. Exactly ONE delayed re-check. Not a loop, and not retried on
      //    failure — a second failure tells us nothing the first did not.
      timer = setTimeout(async () => {
        const second = await readBalance();
        settle(second, credited(second) ? "credited" : "pending");
      }, RECHECK_DELAY_MS);
    })();

    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // Deliberately runs once. A dependency on `onResolved` would re-run the
    // whole sequence whenever the parent re-rendered with a new closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "checking") {
    return (
      <div className="rounded-xl border border-white/60 bg-white/75 p-5 shadow-sm backdrop-blur-sm">
        <p className="text-sm text-neutral-700">Vásárlás ellenőrzése…</p>
      </div>
    );
  }

  if (phase === "credited") {
    return (
      <div className="rounded-xl border border-[var(--green)]/30 bg-[var(--green)]/8 p-5 shadow-sm backdrop-blur-sm">
        <p className="text-base font-semibold">Köszönjük! A RACES megérkezett.</p>
        <p className="mt-1 text-sm text-neutral-800">
          {typeof balance === "number"
            ? `Jelenlegi RACES-egyenleged: ${balance}.`
            : "A RACES-egyenlegedet a fenti jelzés mutatja."}
        </p>
      </div>
    );
  }

  // PENDING. Note what this does not say: it does not say the payment failed,
  // because this screen has no way of knowing that.
  return (
    <div className="rounded-xl border border-white/60 bg-white/75 p-5 shadow-sm backdrop-blur-sm">
      <p className="text-base font-semibold">A vásárlás feldolgozás alatt van.</p>
      <p className="mt-1 text-sm text-neutral-800">
        A RACES néha néhány másodperccel később érkezik meg. Frissítsd az
        oldalt egy pillanat múlva.
      </p>
      <p className="mt-2 text-sm text-neutral-600">
        Ha a fizetés sikeres volt, a RACES meg fog érkezni — nem kell újra
        fizetned.
      </p>
    </div>
  );
}
