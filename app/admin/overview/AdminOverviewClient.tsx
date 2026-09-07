"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import GameShell from "../../components/GameShell";

// ---------------------------------------------------------------------------
// V2.9.2 — owner-monitoring admin overview.
//
// READ-ONLY BY DESIGN, same posture as AdminFeedbackClient.tsx: no delete,
// edit, export, or bulk action exists here or in the API it calls.
//
// TEXT IS RENDERED AS TEXT, NEVER HTML — every value below is placed as a
// plain React child; dangerouslySetInnerHTML is never used anywhere in this
// file.
//
// SERVER-SIDE AUTHORIZATION ONLY: GET /api/admin/overview independently
// re-checks isAdminPlayer() on every call, exactly like
// AdminFeedbackClient.tsx's own identical posture.
//
// UNAVAILABLE METRICS ARE LABELLED HONESTLY, NEVER SILENTLY ZEROED — each
// section renders its own "nem érhető el" state when the corresponding
// field in the API response is null, rather than showing a 0 that could be
// read as "there were none".
// ---------------------------------------------------------------------------

type Lang = "hu" | "en";
type Range = "today" | "7d" | "all";

const COPY = {
  hu: {
    title: "Admin áttekintés",
    loading: "Betöltés…",
    forbidden: "Nincs jogosultságod ehhez az oldalhoz.",
    error: "Az áttekintés most nem érhető el. Próbáld újra hamarosan.",
    unavailable: "nem érhető el",
    refresh: "Frissítés",
    lastUpdated: "Utoljára frissítve:",
    rangeToday: "Ma",
    range7d: "Utolsó 7 nap",
    rangeAll: "Összesen",
    accountsHeading: "Fiókok",
    registered: "Regisztrált",
    verified: "Megerősített",
    pending: "Megerősítésre vár",
    signupsHeading: "Legutóbbi regisztrációk",
    signupsEmpty: "Nincs regisztráció ebben az időszakban.",
    loadMore: "Korábbiak betöltése",
    verifiedBadge: "megerősítve",
    pendingBadge: "vár",
    gamesHeading: "Játékok",
    started: "Elindult",
    completed: "Befejezett",
    byOutcome: "Kimenetel szerint",
    stalledOrExpired: "Félbeszakadt/lejárt játékok",
    stalledNote: "(nem általános hibanapló — csak a játék-életciklus egy jele)",
    purchasesHeading: "Vásárlások",
    purchaseCount: "Vásárlás",
    creditsGranted: "Jóváírt VERSENY",
    recentPurchases: "Legutóbbi vásárlások",
    purchasesEmpty: "Nincs vásárlás ebben az időszakban.",
    feedbackHeading: "Legutóbbi visszajelzések",
    feedbackEmpty: "Egyelőre nincs visszajelzés.",
    feedbackLink: "Teljes postaláda megnyitása →",
  },
  en: {
    title: "Admin overview",
    loading: "Loading…",
    forbidden: "You are not authorized to view this page.",
    error: "The overview is not available right now. Please try again soon.",
    unavailable: "unavailable",
    refresh: "Refresh",
    lastUpdated: "Last updated:",
    rangeToday: "Today",
    range7d: "Last 7 days",
    rangeAll: "All time",
    accountsHeading: "Accounts",
    registered: "Registered",
    verified: "Verified",
    pending: "Pending verification",
    signupsHeading: "Recent signups",
    signupsEmpty: "No signups in this period.",
    loadMore: "Load older",
    verifiedBadge: "verified",
    pendingBadge: "pending",
    gamesHeading: "Games",
    started: "Started",
    completed: "Completed",
    byOutcome: "By outcome",
    stalledOrExpired: "Stalled/expired games",
    stalledNote: "(not a general failure log — a game-lifecycle signal only)",
    purchasesHeading: "Purchases",
    purchaseCount: "Purchases",
    creditsGranted: "Credits granted",
    recentPurchases: "Recent purchases",
    purchasesEmpty: "No purchases in this period.",
    feedbackHeading: "Recent feedback",
    feedbackEmpty: "No feedback yet.",
    feedbackLink: "Open full inbox →",
  },
} as const;

interface AccountTotals {
  registered: number;
  verified: number;
  pending_verification: number;
}
interface RecentSignup {
  player_id: string;
  display_name: string | null;
  email: string | null;
  verified: boolean;
  registered_at: string;
}
interface RecentSignupsResult {
  items: RecentSignup[];
  next_cursor: string | null;
}
interface GameLifecycleSummary {
  started: number;
  completed: number;
  by_outcome: { outcome: string; count: number }[];
  stalled_or_expired: number;
}
interface RecentPurchase {
  created_at: string;
  amount: number;
  product: string | null;
  flavour: string | null;
  quantity: number | null;
  currency: string | null;
  amount_total: number | null;
  livemode: boolean | null;
}
interface PurchaseSummary {
  purchase_count: number;
  credits_granted: number;
  recent: RecentPurchase[];
}
interface FeedbackPreviewItem {
  created_at: string;
  language: "hu" | "en" | null;
  message: string;
  operational_game_id: string | null;
}
interface OverviewResponse {
  range: Range;
  generated_at: string;
  account_totals: AccountTotals | null;
  recent_signups: RecentSignupsResult | null;
  games: GameLifecycleSummary | null;
  purchases: PurchaseSummary | null;
  recent_feedback: FeedbackPreviewItem[] | null;
}

export default function AdminOverviewClient({ versionLabel }: { versionLabel: string }) {
  const [lang, setLang] = useState<Lang>("hu");
  const [range, setRange] = useState<Range>("today");
  const [state, setState] = useState<
    | { step: "loading" }
    | { step: "forbidden" }
    | { step: "error" }
    | { step: "loaded"; data: OverviewResponse; fetchedAt: number }
  >({ step: "loading" });
  const [loadingMoreSignups, setLoadingMoreSignups] = useState(false);

  const t = COPY[lang];

  const load = useCallback(async (forRange: Range, signupsCursor?: string) => {
    if (!signupsCursor) setState({ step: "loading" });
    else setLoadingMoreSignups(true);
    try {
      const params = new URLSearchParams({ range: forRange });
      if (signupsCursor) params.set("signups_cursor", signupsCursor);
      const res = await fetch(`/api/admin/overview?${params.toString()}`, { cache: "no-store" });
      if (res.status === 403) {
        setState({ step: "forbidden" });
        return;
      }
      if (!res.ok) {
        setState({ step: "error" });
        return;
      }
      const data = (await res.json()) as OverviewResponse;
      setState((prev) => {
        if (signupsCursor && prev.step === "loaded" && prev.data.recent_signups && data.recent_signups) {
          return {
            step: "loaded",
            data: {
              ...data,
              recent_signups: {
                items: [...prev.data.recent_signups.items, ...data.recent_signups.items],
                next_cursor: data.recent_signups.next_cursor,
              },
            },
            fetchedAt: Date.now(),
          };
        }
        return { step: "loaded", data, fetchedAt: Date.now() };
      });
    } catch {
      setState({ step: "error" });
    } finally {
      setLoadingMoreSignups(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  return (
    <GameShell role={t.title} version={versionLabel}>
      <div className="flex items-center justify-end gap-2 text-xs">
        <button
          type="button"
          onClick={() => setLang("hu")}
          className={`min-h-8 rounded-md border px-2 ${lang === "hu" ? "border-[var(--green)] bg-[var(--green)] text-[var(--parchment)]" : "border-[var(--ink)]/15"}`}
        >
          Magyar
        </button>
        <button
          type="button"
          onClick={() => setLang("en")}
          className={`min-h-8 rounded-md border px-2 ${lang === "en" ? "border-[var(--green)] bg-[var(--green)] text-[var(--parchment)]" : "border-[var(--ink)]/15"}`}
        >
          English
        </button>
      </div>

      <h1 className="text-lg font-semibold text-[var(--ink)]">{t.title}</h1>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {(["today", "7d", "all"] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            className={`min-h-8 rounded-md border px-3 ${range === r ? "border-[var(--green)] bg-[var(--green)] text-[var(--parchment)]" : "border-[var(--ink)]/15 text-[var(--ink)]"}`}
          >
            {r === "today" ? t.rangeToday : r === "7d" ? t.range7d : t.rangeAll}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void load(range)}
          className="min-h-8 rounded-md border border-[var(--ink)]/15 px-3 text-[var(--ink)]"
        >
          {t.refresh}
        </button>
        {state.step === "loaded" && (
          <span className="text-[var(--ink-soft)]">
            {t.lastUpdated} {new Date(state.fetchedAt).toLocaleTimeString(lang === "hu" ? "hu-HU" : "en-US")}
          </span>
        )}
      </div>

      {state.step === "loading" && <p className="text-sm text-[var(--ink-soft)]">{t.loading}</p>}
      {state.step === "forbidden" && <p className="text-sm text-[var(--red)]">{t.forbidden}</p>}
      {state.step === "error" && <p className="text-sm text-[var(--red)]">{t.error}</p>}

      {state.step === "loaded" && (
        <div className="flex flex-col gap-6">
          {/* Accounts — always all-time, unaffected by the range picker above. */}
          <section className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/60 p-3">
            <h2 className="text-sm font-semibold text-[var(--ink)]">{t.accountsHeading}</h2>
            {state.data.account_totals ? (
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-[var(--ink-soft)]">{t.registered}</dt>
                  <dd className="font-semibold">{state.data.account_totals.registered}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--ink-soft)]">{t.verified}</dt>
                  <dd className="font-semibold">{state.data.account_totals.verified}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--ink-soft)]">{t.pending}</dt>
                  <dd className="font-semibold">{state.data.account_totals.pending_verification}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-[var(--ink-soft)]">{t.unavailable}</p>
            )}
          </section>

          {/* Recent signups */}
          <section className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/60 p-3">
            <h2 className="text-sm font-semibold text-[var(--ink)]">{t.signupsHeading}</h2>
            {state.data.recent_signups ? (
              state.data.recent_signups.items.length === 0 ? (
                <p className="text-sm text-[var(--ink-soft)]">{t.signupsEmpty}</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {state.data.recent_signups.items.map((s) => (
                    <div key={s.player_id} className="flex flex-wrap items-baseline gap-2 text-sm">
                      <span className="text-xs text-[var(--ink-soft)]">{s.registered_at}</span>
                      <span className="font-medium">{s.display_name ?? "—"}</span>
                      <span className="text-[var(--ink-soft)]">{s.email ?? "—"}</span>
                      <span className={s.verified ? "text-[var(--green)]" : "text-[var(--red)]"}>
                        {s.verified ? t.verifiedBadge : t.pendingBadge}
                      </span>
                    </div>
                  ))}
                  {state.data.recent_signups.next_cursor && (
                    <button
                      type="button"
                      onClick={() => void load(range, state.data.recent_signups!.next_cursor!)}
                      disabled={loadingMoreSignups}
                      className="min-h-11 mt-1 self-start rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm text-[var(--ink)] disabled:opacity-40"
                    >
                      {t.loadMore}
                    </button>
                  )}
                </div>
              )
            ) : (
              <p className="text-sm text-[var(--ink-soft)]">{t.unavailable}</p>
            )}
          </section>

          {/* Games */}
          <section className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/60 p-3">
            <h2 className="text-sm font-semibold text-[var(--ink)]">{t.gamesHeading}</h2>
            {state.data.games ? (
              <>
                <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-[var(--ink-soft)]">{t.started}</dt>
                    <dd className="font-semibold">{state.data.games.started}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[var(--ink-soft)]">{t.completed}</dt>
                    <dd className="font-semibold">{state.data.games.completed}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[var(--ink-soft)]">{t.stalledOrExpired}</dt>
                    <dd className="font-semibold">{state.data.games.stalled_or_expired}</dd>
                  </div>
                </dl>
                <p className="text-xs text-[var(--ink-soft)]">{t.stalledNote}</p>
                {state.data.games.by_outcome.length > 0 && (
                  <div className="text-sm">
                    <p className="text-xs text-[var(--ink-soft)]">{t.byOutcome}</p>
                    {state.data.games.by_outcome.map((o) => (
                      <p key={o.outcome}>
                        {o.outcome}: <span className="font-medium">{o.count}</span>
                      </p>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-[var(--ink-soft)]">{t.unavailable}</p>
            )}
          </section>

          {/* Purchases */}
          <section className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/60 p-3">
            <h2 className="text-sm font-semibold text-[var(--ink)]">{t.purchasesHeading}</h2>
            {state.data.purchases ? (
              <>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-[var(--ink-soft)]">{t.purchaseCount}</dt>
                    <dd className="font-semibold">{state.data.purchases.purchase_count}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[var(--ink-soft)]">{t.creditsGranted}</dt>
                    <dd className="font-semibold">{state.data.purchases.credits_granted}</dd>
                  </div>
                </dl>
                {state.data.purchases.recent.length === 0 ? (
                  <p className="text-sm text-[var(--ink-soft)]">{t.purchasesEmpty}</p>
                ) : (
                  <div className="flex flex-col gap-1 text-sm">
                    <p className="text-xs text-[var(--ink-soft)]">{t.recentPurchases}</p>
                    {state.data.purchases.recent.map((p, i) => (
                      <p key={`${p.created_at}-${i}`} className="text-xs text-[var(--ink-soft)]">
                        {p.created_at} · {p.product ?? "—"} {p.flavour ? `(${p.flavour})` : ""} ×
                        {p.quantity ?? "?"} · {p.amount_total ?? "?"} {p.currency ?? ""} ·{" "}
                        {p.livemode === false ? "TEST" : p.livemode === true ? "LIVE" : "?"} · +{p.amount} VERSENY
                      </p>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-[var(--ink-soft)]">{t.unavailable}</p>
            )}
          </section>

          {/* Feedback preview */}
          <section className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/60 p-3">
            <h2 className="text-sm font-semibold text-[var(--ink)]">{t.feedbackHeading}</h2>
            {state.data.recent_feedback ? (
              state.data.recent_feedback.length === 0 ? (
                <p className="text-sm text-[var(--ink-soft)]">{t.feedbackEmpty}</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {state.data.recent_feedback.map((f, i) => (
                    <div key={`${f.created_at}-${i}`} className="text-sm">
                      <p className="text-xs text-[var(--ink-soft)]">
                        {f.created_at} {f.language ? `· ${f.language.toUpperCase()}` : ""}
                      </p>
                      {/* Plain text child — React escapes this; no markup can execute. */}
                      <p className="whitespace-pre-wrap text-[var(--ink)]">{f.message}</p>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <p className="text-sm text-[var(--ink-soft)]">{t.unavailable}</p>
            )}
            <Link href="/admin/feedback" className="text-xs text-[var(--ink-soft)] underline underline-offset-2">
              {t.feedbackLink}
            </Link>
          </section>
        </div>
      )}
    </GameShell>
  );
}
