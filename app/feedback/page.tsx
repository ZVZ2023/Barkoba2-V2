import type { Metadata } from "next";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import FeedbackPageClient from "./FeedbackPageClient";

export const metadata: Metadata = { title: "Visszajelzés — Barkóba" };

// Same reasoning as every other player-state page: per-request, never
// statically rendered or cached.
export const dynamic = "force-dynamic";

/**
 * V2.9.1 — the standalone player-facing feedback page.
 *
 * NO GATE OF ANY KIND. Unlike /beta and /admin/feedback, this route carries
 * no flag check and no authorization check at all — available to anonymous
 * players, registered players, beta applicants, and approved Founding
 * Testers alike, exactly per the product decision. It works with no game
 * reference: FeedbackPageClient never supplies a gameId to FeedbackForm.
 */
export default function Page() {
  return <FeedbackPageClient versionLabel={formatVersionLabel(getAppVersion())} />;
}
