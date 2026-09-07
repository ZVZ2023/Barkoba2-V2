"use client";

import { useCallback, useEffect, useState } from "react";
import GameShell from "../../components/GameShell";

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 COMPLETION — admin-only feedback inbox.
//
// READ-ONLY BY DESIGN: no delete, edit, export, or bulk action exists here
// or in the API it calls, by explicit product decision — this is a reading
// tool, not a moderation workflow.
//
// TEXT IS RENDERED AS TEXT, NEVER HTML. Every submission's `message` is
// placed as a plain React child ({item.message}) — React escapes this
// automatically. dangerouslySetInnerHTML is never used anywhere in this
// file; a submission containing "<script>" or any other markup renders as
// the literal characters, never executes.
//
// SERVER-SIDE AUTHORIZATION ONLY: this component renders for anyone who can
// load the page; GET /api/feedback/admin independently re-checks
// isAdminPlayer() on every call, exactly like AdminReviewClient.tsx's own
// identical posture.
// ---------------------------------------------------------------------------

type Lang = "hu" | "en";

const COPY = {
  hu: {
    title: "Visszajelzés postaláda",
    loading: "Betöltés…",
    forbidden: "Nincs jogosultságod ehhez az oldalhoz.",
    error: "A visszajelzések most nem érhetők el. Próbáld újra hamarosan.",
    empty: "Egyelőre nincs visszajelzés.",
    loadMore: "Korábbiak betöltése",
    gameRefLabel: "Játék:",
  },
  en: {
    title: "Feedback inbox",
    loading: "Loading…",
    forbidden: "You are not authorized to view this page.",
    error: "Feedback is not available right now. Please try again soon.",
    empty: "No feedback yet.",
    loadMore: "Load older",
    gameRefLabel: "Game:",
  },
} as const;

interface FeedbackItem {
  created_at: string;
  language: "hu" | "en" | null;
  message: string;
  operational_game_id: string | null;
}

interface FeedbackListResponse {
  items: FeedbackItem[];
  /** Opaque. Echoed back verbatim to fetch the next page; null means there is none. */
  next_cursor: string | null;
}

export default function AdminFeedbackClient({ versionLabel }: { versionLabel: string }) {
  const [lang, setLang] = useState<Lang>("hu");
  const [state, setState] = useState<
    | { step: "loading" }
    | { step: "forbidden" }
    | { step: "error" }
    | { step: "loaded"; items: FeedbackItem[]; nextCursor: string | null }
  >({ step: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);

  const t = COPY[lang];

  const load = useCallback(async (cursor?: string) => {
    if (!cursor) setState({ step: "loading" });
    else setLoadingMore(true);
    try {
      const url = cursor
        ? `/api/feedback/admin?cursor=${encodeURIComponent(cursor)}`
        : "/api/feedback/admin";
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 403) {
        setState({ step: "forbidden" });
        return;
      }
      if (!res.ok) {
        setState({ step: "error" });
        return;
      }
      const data = (await res.json()) as FeedbackListResponse;
      setState((prev) => ({
        step: "loaded",
        items: cursor && prev.step === "loaded" ? [...prev.items, ...data.items] : data.items,
        nextCursor: data.next_cursor,
      }));
    } catch {
      setState({ step: "error" });
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

      {state.step === "loading" && <p className="text-sm text-[var(--ink-soft)]">{t.loading}</p>}
      {state.step === "forbidden" && <p className="text-sm text-[var(--red)]">{t.forbidden}</p>}
      {state.step === "error" && <p className="text-sm text-[var(--red)]">{t.error}</p>}

      {state.step === "loaded" && state.items.length === 0 && (
        <p className="text-sm text-[var(--ink-soft)]">{t.empty}</p>
      )}

      {state.step === "loaded" && state.items.length > 0 && (
        <div className="flex flex-col gap-2">
          {state.items.map((item, i) => (
            <div
              key={`${item.created_at}-${i}`}
              className="flex flex-col gap-1 rounded-md border border-[var(--ink)]/15 bg-white/60 p-3 text-sm"
            >
              <p className="text-xs text-[var(--ink-soft)]">
                {item.created_at} {item.language ? `· ${item.language.toUpperCase()}` : ""}
              </p>
              {/* Rendered as a plain text child — React escapes this, and
                  dangerouslySetInnerHTML is never used anywhere in this
                  component, so submitted markup can never execute. */}
              <p className="whitespace-pre-wrap text-[var(--ink)]">{item.message}</p>
              {item.operational_game_id && (
                <p className="text-xs text-[var(--ink-soft)]">
                  {t.gameRefLabel} {item.operational_game_id}
                </p>
              )}
            </div>
          ))}
          {state.nextCursor && (
            <button
              onClick={() => void load(state.nextCursor!)}
              disabled={loadingMore}
              className="min-h-11 self-start rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm text-[var(--ink)] disabled:opacity-40"
            >
              {t.loadMore}
            </button>
          )}
        </div>
      )}
    </GameShell>
  );
}
