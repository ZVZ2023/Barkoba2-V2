import type { Metadata } from "next";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import AdminFeedbackClient from "./AdminFeedbackClient";

export const metadata: Metadata = { title: "Feedback Inbox — Barkóba" };
export const dynamic = "force-dynamic";

/**
 * V2.9.0 SLICE 1 COMPLETION — the admin feedback inbox.
 *
 * NOT GATED BY BETA_COMMUNITY_ENABLED — see app/api/feedback/admin/
 * route.ts's own doc on why. The PAGE itself carries no authorization at
 * all; every actual guarantee is server-side, in the API route
 * (isAdminPlayer), which AdminFeedbackClient calls. A non-admin visitor
 * sees exactly that route's own 403, not a client-side illusion of access
 * control — the same posture app/beta/admin/page.tsx already established.
 */
export default function Page() {
  return <AdminFeedbackClient versionLabel={formatVersionLabel(getAppVersion())} />;
}
