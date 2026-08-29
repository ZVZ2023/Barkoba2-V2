import type { Metadata } from "next";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import PurchaseClient from "./PurchaseClient";

export const metadata: Metadata = { title: "További VERSENY — Barkóba" };

// Same reasoning as every other player-state page here: purchase eligibility
// is per-request identity, not something to statically render or cache.
export const dynamic = "force-dynamic";

/**
 * V2.7.x — Barkóba's own purchase page (docs/DESIGN-NOTES.md §51.8).
 *
 * Server component's only job is the version label, matching the convention
 * every other page-level component here follows (app/history/page.tsx,
 * app/compose/page.tsx) — everything identity-dependent happens client-side
 * in PurchaseClient.
 */
export default function Page() {
  return <PurchaseClient versionLabel={formatVersionLabel(getAppVersion())} />;
}
