"use client";

import { useCallback, useEffect, useState } from "react";
import ClaimPrompt from "../components/ClaimPrompt";
import RecoverPrompt from "../components/RecoverPrompt";

interface Props {
  versionLabel: string;
}

interface Flavor {
  key: string;
  name: string;
}

interface Catalog {
  scoop: { flavors: Flavor[]; credits_by_scoops: Record<string, number | null> };
  custom: { available: boolean; credits_first_step: number | null };
}

type Step =
  | "loading"
  | "need_account"
  | "need_verification"
  | "ready"
  | "redirecting"
  | "error";

/**
 * V2.7.x — Barkóba's own purchase page.
 *
 * Presentation-layer supersession of the old "redirect straight to DICS's
 * storefront" journey (docs/DESIGN-NOTES.md §41, qualified by §51.8): the
 * player picks a package HERE, in Barkóba's own screen, and the only place
 * they leave Barkóba for is Stripe's hosted checkout itself — never DICS's
 * storefront page. See app/api/entitlement/intent/route.ts and
 * lib/dicsCatalog.ts for how purchase_url is resolved.
 *
 * Account and verification gating is enforced by the server on every
 * /api/entitlement/intent call; the checks here are the same courteous
 * pre-check CreditGateway already does in app/components/Entitlement.tsx, not
 * a second authority.
 */
export default function PurchaseClient({ versionLabel }: Props) {
  const [step, setStep] = useState<Step>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selectedFlavor, setSelectedFlavor] = useState<string | null>(null);
  const [busyPackage, setBusyPackage] = useState<"dics_scoop" | "dics_custom" | null>(null);

  const checkAccount = useCallback(async () => {
    setStep("loading");
    try {
      const res = await fetch("/api/account/profile", { cache: "no-store" });
      if (res.status === 401) {
        setStep("need_account");
        return;
      }
      if (!res.ok) {
        setStep("error");
        setMessage("Most nem érjük el a játékosodat. Próbáld újra.");
        return;
      }
      const data = await res.json();
      if (!data.email_verified) {
        setPendingEmail(typeof data.email === "string" ? data.email : null);
        setStep("need_verification");
        return;
      }
      setStep("ready");
    } catch {
      setStep("error");
      setMessage("Most nem érjük el a játékosodat. Próbáld újra.");
    }
  }, []);

  useEffect(() => {
    void checkAccount();
  }, [checkAccount]);

  useEffect(() => {
    if (step !== "ready") return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/entitlement/catalog", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Catalog;
        if (!live) return;
        setCatalog(data);
        const firstFlavor = data.scoop.flavors[0];
        if (firstFlavor) setSelectedFlavor(firstFlavor.key);
      } catch {
        // The purchase buttons still work without a flavor picker — flavor is
        // cosmetic; see lib/dicsCatalog.ts.
      }
    })();
    return () => {
      live = false;
    };
  }, [step]);

  const buy = useCallback(
    async (packageId: "dics_scoop" | "dics_custom") => {
      setBusyPackage(packageId);
      setMessage(null);
      try {
        const res = await fetch("/api/entitlement/intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            package_id: packageId,
            ...(packageId === "dics_scoop" && selectedFlavor ? { flavor_key: selectedFlavor } : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data?.error === "account_required") setStep("need_account");
          else if (data?.error === "email_verification_required") setStep("need_verification");
          setMessage(data?.message ?? "Most nem sikerült elindítani a vásárlást.");
          setBusyPackage(null);
          return;
        }
        if (typeof data.purchase_url !== "string" || !data.purchase_url.startsWith("https://")) {
          setMessage("A vásárlási oldal most nem érhető el.");
          setBusyPackage(null);
          return;
        }
        setStep("redirecting");
        window.location.assign(data.purchase_url);
      } catch {
        setMessage("Hálózati hiba — próbáld újra.");
        setBusyPackage(null);
      }
    },
    [selectedFlavor]
  );

  return (
    <main className="mx-auto flex w-full min-h-screen max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--ink)]/10 pb-3">
        <a href="/" className="flex min-w-0 items-center gap-2" aria-label="Barkóba főoldal">
          <span
            aria-hidden="true"
            className="inline-block h-6 w-6 shrink-0 rounded-full border-[3px] border-[var(--ink)]/80"
            style={{ borderRightColor: "transparent" }}
          />
          <span className="truncate text-base font-semibold tracking-tight">Barkóba</span>
        </a>
        <h1 className="text-sm font-semibold text-[var(--ink)]">További VERSENY</h1>
      </header>

      {step === "loading" && <p className="text-sm text-[var(--ink-soft)]">Egy pillanat…</p>}

      {step === "need_account" && (
        <div className="flex flex-col gap-3 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
          <p className="text-sm font-medium text-[var(--ink)]">Előbb regisztrálj vagy jelentkezz be</p>
          <p className="text-sm text-[var(--ink-soft)]">
            A megvásárolt VERSENY a játékosfiókodhoz tartozik, nem ehhez az eszközhöz.
          </p>
          <ClaimPrompt />
          <RecoverPrompt />
          <button
            onClick={() => void checkAccount()}
            className="min-h-11 self-start rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm text-[var(--ink)]"
          >
            Bejelentkeztem — tovább
          </button>
        </div>
      )}

      {step === "need_verification" && (
        <div className="flex flex-col gap-3 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
          <p className="text-sm font-medium text-[var(--ink)]">Erősítsd meg az e-mail címed</p>
          <p className="text-sm text-[var(--ink-soft)]">
            {pendingEmail
              ? `Küldtünk egy megerősítő linket ide: ${pendingEmail}. Kattints rá, majd gyere vissza ide.`
              : "Küldtünk egy megerősítő linket a regisztrációkor megadott címre. Kattints rá, majd gyere vissza ide."}
            {" "}A vásárolt VERSENY csak megerősített címhez köthető biztonságosan.
          </p>
          <button
            onClick={() => void checkAccount()}
            className="min-h-11 self-start rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm text-[var(--ink)]"
          >
            Megerősítettem — tovább
          </button>
        </div>
      )}

      {step === "redirecting" && (
        <div className="rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
          <p className="text-sm font-medium text-[var(--ink)]">Tovább a biztonságos fizetéshez…</p>
          <p className="text-sm text-[var(--ink-soft)]">A vásárlási azonosítód biztonságosan elkészült.</p>
        </div>
      )}

      {step === "ready" && (
        <div className="flex flex-col gap-6">
          <p className="text-sm text-[var(--ink-soft)]">
            Válassz csomagot. A fizetés Stripe biztonságos, hosztolt oldalán történik; a
            pontos mennyiséget (1–3) ott állíthatod be.
          </p>

          <div className="flex flex-col gap-3 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
            <p className="text-sm font-medium text-[var(--ink)]">Digital Ice Cream — 1 gombóc</p>
            <p className="text-xs text-[var(--ink-soft)]">
              {catalog
                ? `1 gombóc: ${catalog.scoop.credits_by_scoops["1"] ?? "?"} VERSENY · 2 gombóc: ${
                    catalog.scoop.credits_by_scoops["2"] ?? "?"
                  } VERSENY · 3 gombóc: ${catalog.scoop.credits_by_scoops["3"] ?? "?"} VERSENY`
                : "VERSENY-jóváírás betöltése…"}
            </p>
            {catalog && catalog.scoop.flavors.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {catalog.scoop.flavors.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setSelectedFlavor(f.key)}
                    className={`min-h-9 rounded-md border px-3 py-1.5 text-xs ${
                      selectedFlavor === f.key
                        ? "border-[var(--green)] bg-[var(--green)]/10 text-[var(--green)]"
                        : "border-[var(--ink)]/20 text-[var(--ink)]"
                    }`}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => void buy("dics_scoop")}
              disabled={busyPackage !== null}
              className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
            >
              {busyPackage === "dics_scoop" ? "Egy pillanat…" : "Tovább a fizetéshez"}
            </button>
          </div>

          <div className="flex flex-col gap-3 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
            <p className="text-sm font-medium text-[var(--ink)]">Custom Flavor</p>
            <p className="text-xs text-[var(--ink-soft)]">
              Egyedi, kézzel készített substanciálás.
              {catalog?.custom.credits_first_step
                ? ` Kezdő VERSENY-jóváírás: ${catalog.custom.credits_first_step}.`
                : ""}
            </p>
            <button
              onClick={() => void buy("dics_custom")}
              disabled={busyPackage !== null || catalog?.custom.available === false}
              className="min-h-11 self-start rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm font-medium text-[var(--ink)] disabled:opacity-40"
            >
              {busyPackage === "dics_custom" ? "Egy pillanat…" : "Tovább a fizetéshez"}
            </button>
          </div>
        </div>
      )}

      {message && <p className="text-sm text-[var(--red)]">{message}</p>}

      {step === "error" && !message && (
        <p className="text-sm text-[var(--red)]">Ez most nem érhető el. Próbáld újra.</p>
      )}

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
