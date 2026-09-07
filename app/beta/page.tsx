import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import { betaCommunityConfigured } from "@/lib/betaCommunity";
import { env } from "@/lib/env";
import BetaClient from "./BetaClient";

export const metadata: Metadata = { title: "Limited Beta — Barkóba" };

// Same reasoning as every other player-state page: per-request, never
// statically rendered or cached.
export const dynamic = "force-dynamic";

/**
 * V2.9.0 Slice 1 — the Limited Beta / Founding Tester information and
 * application page.
 *
 * WHILE BETA_COMMUNITY_ENABLED IS OFF, THIS ROUTE DOES NOT EXIST — notFound()
 * renders the app's ordinary 404, exactly like app/game/[id]/page.tsx's own
 * precedent for "this identity/state combination is not reachable." No
 * description of an unreleased program is served either, which is the
 * strictest reading of "entry points... must remain unavailable."
 *
 * barkobak.com's root landing/play surface (app/page.tsx) is completely
 * untouched by this feature — this is a new, separate route, not a
 * replacement for or redirect from anything gameplay-related.
 */
export default function Page() {
  if (!env.betaCommunityEnabled() || !betaCommunityConfigured()) {
    notFound();
  }
  return <BetaClient versionLabel={formatVersionLabel(getAppVersion())} />;
}
