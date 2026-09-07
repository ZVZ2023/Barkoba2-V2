import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { isAdminPlayer } from "@/lib/admin";
import {
  getAccountTotals,
  getGameLifecycleSummary,
  getPurchaseSummary,
  listRecentSignups,
  rangeSince,
  type AdminOverviewRange,
} from "@/lib/adminOverview";
import { listRecentFeedback } from "@/lib/feedback";

// ---------------------------------------------------------------------------
// V2.9.2 — GET /api/admin/overview.
//
// ADMIN-ONLY, reusing app/api/feedback/admin/route.ts's EXACT authorization
// shape: a live account session (context.kind === "account") AND
// isAdminPlayer() — never accounts.unlimited_play, a different privilege
// entirely (see lib/admin.ts's own header).
//
// NO READ-SIDE AUTHORIZATION CAN EVER COME FROM THE CLIENT: identity is
// resolved exclusively from the signed session cookie via
// resolveActingPlayer, never from a request body/query parameter.
//
// BOUNDED, AGGREGATE DATA ONLY — no target, no transcript, no card/email/
// name payment data. See lib/adminOverview.ts's own header for exactly
// what each section reads and why.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

function parseRange(raw: string | null): AdminOverviewRange {
  return raw === "today" || raw === "7d" ? raw : "all";
}

export async function GET(req: NextRequest) {
  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account" || !isAdminPlayer(context.playerId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: PRIVATE_NO_STORE });
  }

  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("range"));
  const signupsCursor = url.searchParams.get("signups_cursor");
  const since = rangeSince(range);

  const [accountTotals, signupsOutcome, games, purchases, feedbackOutcome] = await Promise.all([
    getAccountTotals(),
    listRecentSignups(signupsCursor),
    getGameLifecycleSummary(since),
    getPurchaseSummary(since),
    listRecentFeedback(),
  ]);

  if (!signupsOutcome.ok && signupsOutcome.reason === "invalid_cursor") {
    return NextResponse.json({ error: "invalid_cursor" }, { status: 400, headers: PRIVATE_NO_STORE });
  }

  return NextResponse.json(
    {
      range,
      generated_at: new Date().toISOString(),
      // Every section is independently nullable: a database outage takes
      // down some or all of them without ever turning into a 5xx for the
      // whole page — the client renders "nem érhető el" per missing
      // section instead (see AdminOverviewClient.tsx).
      account_totals: accountTotals,
      recent_signups: signupsOutcome.ok ? signupsOutcome.result : null,
      games,
      purchases,
      // A short preview only — the full, paginated inbox already exists at
      // /admin/feedback (and its own API); this overview links to it
      // rather than reimplementing its pagination.
      recent_feedback: feedbackOutcome.ok ? feedbackOutcome.result.items.slice(0, 10) : null,
    },
    { headers: PRIVATE_NO_STORE }
  );
}
