import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { getPlayerAccount } from "@/lib/playerAccounts";
import { betaCommunityConfigured, getApplication } from "@/lib/betaCommunity";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// V2.9.0 Slice 1 — GET /api/beta/status.
//
// APPLICANT STATUS ISOLATION: this endpoint has no parameter that could name
// a different player. The acting identity comes only from the server-side
// session/cookie resolver, exactly like /api/player/entitlement — there is
// no way for a request to read anyone else's application.
//
// enforced:false when the flag is off, mirroring /api/player/entitlement's
// own enforced:false shape for a disabled entitlement gate — a caller can
// tell the program does not exist right now without learning anything else.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!env.betaCommunityEnabled() || !betaCommunityConfigured()) {
    return NextResponse.json({ enabled: false });
  }

  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account") {
    // Not an error: an anonymous or merely-cookied visitor simply has no
    // application to report, and the page must still render.
    return NextResponse.json({ enabled: true, account: false, application: null });
  }

  const [account, application] = await Promise.all([
    getPlayerAccount(context.playerId),
    getApplication(context.playerId),
  ]);

  return NextResponse.json({
    enabled: true,
    account: true,
    email_verified: account?.email_verified_at != null,
    application: application
      ? {
          status: application.status,
          submitted_at: application.submitted_at,
          rejection_reason: application.rejection_reason,
        }
      : null,
  });
}
