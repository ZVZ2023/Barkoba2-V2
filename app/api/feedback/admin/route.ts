import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { isAdminPlayer } from "@/lib/admin";
import { listRecentFeedback } from "@/lib/feedback";

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 COMPLETION — GET /api/feedback/admin.
//
// ADMIN-ONLY, reusing app/api/admin/capacity/route.ts's EXACT authorization
// shape: a live account session (context.kind === "account") AND
// isAdminPlayer() — not accounts.unlimited_play, which is a different
// privilege entirely (see lib/admin.ts's own header).
//
// DELIBERATELY NOT GATED BY BETA_COMMUNITY_ENABLED. Feedback exists, and
// must remain readable by an operator, independent of the beta program's
// on/off state — the flag gates beta/community entry points, and this is
// neither.
//
// NO READ-SIDE AUTHORIZATION CAN EVER COME FROM THE CLIENT: the caller's
// identity is resolved exclusively from the signed session cookie via
// resolveActingPlayer, never from a request body/query parameter.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account" || !isAdminPlayer(context.playerId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: PRIVATE_NO_STORE });
  }

  const cursor = new URL(req.url).searchParams.get("cursor");
  const outcome = await listRecentFeedback(cursor);
  if (!outcome.ok) {
    // A malformed cursor is rejected safely with a generic 400 — no detail
    // about the expected encoding, decoding failure, or internal shape is
    // ever included in the response.
    if (outcome.reason === "invalid_cursor") {
      return NextResponse.json({ error: "invalid_cursor" }, { status: 400, headers: PRIVATE_NO_STORE });
    }
    return NextResponse.json(
      { error: "unavailable" },
      { status: 503, headers: PRIVATE_NO_STORE }
    );
  }

  return NextResponse.json(outcome.result, { headers: PRIVATE_NO_STORE });
}
