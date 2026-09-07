"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import GameShell from "../../components/GameShell";

// ---------------------------------------------------------------------------
// V2.9.0 Slice 1 — admin-only Founding Tester / profile-revision review
// queue. Utilitarian by design: this is an operator tool, not a
// player-facing surface, and does not need bilingual copy or polish.
//
// SERVER-SIDE AUTHORIZATION IS THE ONLY GATE THAT MATTERS. This component
// renders for anyone who can load the page; every action it offers goes
// through GET/POST /api/beta/admin/*, which independently re-checks
// isAdminPlayer() on every single call. A non-admin visitor sees exactly the
// API's 403 here — there is no separate, weaker client-side check to bypass.
// ---------------------------------------------------------------------------

interface QueueApplication {
  application_id: number;
  player_id: string;
  note: string | null;
  submitted_at: string;
}

interface QueueProfileRevision {
  revision_id: number;
  player_id: string;
  headline: string | null;
  bio: string | null;
  submitted_at: string;
}

interface QueueResponse {
  applications: QueueApplication[];
  profile_revisions: QueueProfileRevision[];
}

export default function AdminReviewClient({ versionLabel }: { versionLabel: string }) {
  const [state, setState] = useState<
    | { step: "loading" }
    | { step: "forbidden" }
    | { step: "error" }
    | { step: "loaded"; data: QueueResponse }
  >({ step: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ step: "loading" });
    try {
      const res = await fetch("/api/beta/admin/queue", { cache: "no-store" });
      if (res.status === 403) {
        setState({ step: "forbidden" });
        return;
      }
      if (!res.ok) {
        setState({ step: "error" });
        return;
      }
      const data = (await res.json()) as QueueResponse;
      setState({ step: "loaded", data });
    } catch {
      setState({ step: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function review(
    target: "application" | "profile_revision",
    id: number,
    decision: "approved" | "rejected"
  ) {
    const key = `${target}:${id}`;
    setBusyId(key);
    try {
      await fetch("/api/beta/admin/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, id, decision }),
      });
    } finally {
      setBusyId(null);
      void load();
    }
  }

  return (
    <GameShell role="Founding Tester review queue" version={versionLabel}>
      <h1 className="text-lg font-semibold text-[var(--ink)]">Beta review queue</h1>

      {state.step === "loading" && <p className="text-sm text-[var(--ink-soft)]">Loading…</p>}
      {state.step === "forbidden" && (
        <p className="text-sm text-[var(--red)]">You are not authorized to view this page.</p>
      )}
      {state.step === "error" && (
        <p className="text-sm text-[var(--red)]">This queue is not available right now.</p>
      )}

      {state.step === "loaded" && (
        <>
          {/*
            V2.9.0 Slice 1 FINAL CORRECTION — the only discoverability path
            to /admin/feedback: rendered ONLY inside this already
            server-confirmed "loaded" branch, which is reached exclusively
            after GET /api/beta/admin/queue itself returned 200 (i.e. this
            caller already passed isAdminPlayer()). An anonymous, merely
            registered, or beta-member visitor never reaches this branch —
            they see "forbidden" above instead — so this link is never
            rendered for them. No new navigation system, no change to any
            other page.
          */}
          <Link
            href="/admin/feedback"
            className="self-start text-sm text-[var(--ink-soft)] underline-offset-2 hover:underline"
          >
            Visszajelzések / Feedback →
          </Link>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              Applications ({state.data.applications.length})
            </h2>
            {state.data.applications.length === 0 && (
              <p className="text-sm text-[var(--ink-soft)]">Nothing pending.</p>
            )}
            {state.data.applications.map((a) => (
              <div
                key={a.application_id}
                className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/60 p-3 text-sm"
              >
                <p className="text-xs text-[var(--ink-soft)]">
                  #{a.application_id} · {a.player_id.slice(0, 8)}… · {a.submitted_at}
                </p>
                {a.note && <p className="text-[var(--ink)]">{a.note}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={() => void review("application", a.application_id, "approved")}
                    disabled={busyId === `application:${a.application_id}`}
                    className="min-h-9 rounded-md bg-[var(--green)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => void review("application", a.application_id, "rejected")}
                    disabled={busyId === `application:${a.application_id}`}
                    className="min-h-9 rounded-md border border-[var(--red)]/40 px-3 py-1.5 text-xs font-medium text-[var(--red)] disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              Profile revisions ({state.data.profile_revisions.length})
            </h2>
            {state.data.profile_revisions.length === 0 && (
              <p className="text-sm text-[var(--ink-soft)]">Nothing pending.</p>
            )}
            {state.data.profile_revisions.map((r) => (
              <div
                key={r.revision_id}
                className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/60 p-3 text-sm"
              >
                <p className="text-xs text-[var(--ink-soft)]">
                  #{r.revision_id} · {r.player_id.slice(0, 8)}… · {r.submitted_at}
                </p>
                {r.headline && <p className="font-medium text-[var(--ink)]">{r.headline}</p>}
                {r.bio && <p className="text-[var(--ink)]">{r.bio}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={() => void review("profile_revision", r.revision_id, "approved")}
                    disabled={busyId === `profile_revision:${r.revision_id}`}
                    className="min-h-9 rounded-md bg-[var(--green)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => void review("profile_revision", r.revision_id, "rejected")}
                    disabled={busyId === `profile_revision:${r.revision_id}`}
                    className="min-h-9 rounded-md border border-[var(--red)]/40 px-3 py-1.5 text-xs font-medium text-[var(--red)] disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </section>
        </>
      )}
    </GameShell>
  );
}
