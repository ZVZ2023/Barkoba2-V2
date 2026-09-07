import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { isAdminPlayer } from "@/lib/admin";
import { betaCommunityConfigured, listPendingApplications, listPendingProfileRevisions } from "@/lib/betaCommunity";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// V2.9.0 Slice 1 — GET /api/beta/admin/queue.
//
// ADMIN-ONLY, reusing app/api/admin/capacity/route.ts's EXACT authorization
// shape: a live account session (context.kind === "account") AND
// isAdminPlayer(). Not accounts.unlimited_play — see lib/admin.ts's own
// header on why that would conflate two unrelated privileges.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  if (!env.betaCommunityEnabled() || !betaCommunityConfigured()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const context = await resolveActingPlayer(req.headers);
  const authorized = context.kind === "account" && isAdminPlayer(context.playerId);
  if (!authorized) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: PRIVATE_NO_STORE });
  }

  const [applications, profileRevisions] = await Promise.all([
    listPendingApplications(),
    listPendingProfileRevisions(),
  ]);

  return NextResponse.json(
    {
      applications: applications.map((a) => ({
        application_id: a.application_id,
        player_id: a.player_id,
        note: a.note,
        submitted_at: a.submitted_at,
      })),
      profile_revisions: profileRevisions.map((r) => ({
        revision_id: r.revision_id,
        player_id: r.player_id,
        headline: r.headline,
        bio: r.bio,
        submitted_at: r.submitted_at,
      })),
    },
    { headers: PRIVATE_NO_STORE }
  );
}
