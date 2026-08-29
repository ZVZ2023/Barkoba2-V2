import type { Metadata } from "next";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import RegisterClient from "./RegisterClient";

export const metadata: Metadata = { title: "Regisztráció — Barkóba" };

// Same reasoning as every other player-state page here: registration
// eligibility is per-request identity, not something to statically render or
// cache.
export const dynamic = "force-dynamic";

/**
 * V2.7.0 human-test fix — the dedicated newcomer registration/welcome page.
 *
 * Server component's only job is the version label, matching the convention
 * every other page-level component here follows (app/history/page.tsx,
 * app/purchase/page.tsx) — everything identity-dependent happens client-side
 * in RegisterClient, via the already-existing ClaimPrompt.
 */
export default function Page() {
  return <RegisterClient versionLabel={formatVersionLabel(getAppVersion())} />;
}
