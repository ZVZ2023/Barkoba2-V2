import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import { betaCommunityConfigured } from "@/lib/betaCommunity";
import { env } from "@/lib/env";
import AdminReviewClient from "./AdminReviewClient";

export const metadata: Metadata = { title: "Beta Review — Barkóba" };
export const dynamic = "force-dynamic";

/**
 * V2.9.0 Slice 1 — the Founding Tester application/profile review queue.
 *
 * The PAGE gates only on the feature flag, matching /beta's own posture —
 * actual admin authorization is enforced server-side by
 * GET/POST /api/beta/admin/* (isAdminPlayer), which AdminReviewClient calls;
 * a non-admin visitor sees the API's own 403, not a client-side illusion of
 * access control.
 */
export default function Page() {
  if (!env.betaCommunityEnabled() || !betaCommunityConfigured()) {
    notFound();
  }
  return <AdminReviewClient versionLabel={formatVersionLabel(getAppVersion())} />;
}
