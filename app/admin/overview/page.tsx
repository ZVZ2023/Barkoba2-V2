import type { Metadata } from "next";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import AdminOverviewClient from "./AdminOverviewClient";

export const metadata: Metadata = { title: "Admin áttekintés — Barkóba" };
export const dynamic = "force-dynamic";

/**
 * V2.9.2 — the owner-monitoring admin overview.
 *
 * Same posture as app/admin/feedback/page.tsx: the PAGE itself carries no
 * authorization at all. Every actual guarantee is server-side, in
 * GET /api/admin/overview (isAdminPlayer), which AdminOverviewClient calls.
 * A non-admin visitor sees exactly that route's own 403, not a client-side
 * illusion of access control.
 */
export default function Page() {
  return <AdminOverviewClient versionLabel={formatVersionLabel(getAppVersion())} />;
}
