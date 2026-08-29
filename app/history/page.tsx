import type { Metadata } from "next";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import HistoryClient from "./HistoryClient";

export const metadata: Metadata = { title: "Játékaim — Barkóba" };

// Same reasoning as every other player-state page in this app: history is
// per-request identity, not something to statically render or cache.
export const dynamic = "force-dynamic";

/**
 * V2.7 — the registered player's own game history.
 *
 * Server component's only job is the version label, matching the convention
 * every other page-level component here already follows (app/compose/page.tsx,
 * GameClient, RacerClient) — everything that depends on the caller's identity
 * happens client-side in HistoryClient, which is what lets GET
 * /api/player/history resolve it the ordinary way, from the request headers
 * middleware already populates.
 */
export default function Page() {
  return <HistoryClient versionLabel={formatVersionLabel(getAppVersion())} />;
}
