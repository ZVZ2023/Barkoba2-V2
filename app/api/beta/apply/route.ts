import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { getPlayerAccount } from "@/lib/playerAccounts";
import { betaCommunityConfigured, submitApplication } from "@/lib/betaCommunity";
import { checkBetaApplicationRateLimit, extractClientIp } from "@/lib/rateLimit";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// V2.9.0 Slice 1 — POST /api/beta/apply.
//
// VERIFIED ACCOUNT REQUIRED, ENFORCED HERE, NOT MERELY IN THE UI. A guest or
// registered-but-unverified caller is refused with a distinct, actionable
// error — the same "account before X, verified before X" posture
// CreditGateway already established for purchases (app/components/
// Entitlement.tsx), reused rather than inventing a second convention.
//
// DUPLICATE-SAFE BY CONSTRUCTION: submitApplication() itself is idempotent
// per player_id (migration 0015, beta.applications' UNIQUE constraint), so
// a retried or double-clicked submission always returns the SAME row,
// never a second application.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const MAX_NOTE_LENGTH = 500;

export async function POST(req: NextRequest) {
  if (!env.betaCommunityEnabled() || !betaCommunityConfigured()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const ip = extractClientIp(req.headers);
  const rateLimit = await checkBetaApplicationRateLimit(ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Túl sok próbálkozás. Próbáld újra később." },
      { status: 429 }
    );
  }

  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account") {
    return NextResponse.json(
      {
        error: "account_required",
        message: "A jelentkezéshez regisztrált, bejelentkezett fiók szükséges.",
      },
      { status: 401 }
    );
  }

  const account = await getPlayerAccount(context.playerId);
  if (!account || account.email_verified_at == null) {
    return NextResponse.json(
      {
        error: "verification_required",
        message: "A jelentkezéshez megerősített e-mail cím szükséges.",
      },
      { status: 403 }
    );
  }

  let note: string | null = null;
  try {
    const body = (await req.json()) as { note?: unknown };
    if (typeof body.note === "string" && body.note.trim().length > 0) {
      note = body.note.trim().slice(0, MAX_NOTE_LENGTH);
    }
  } catch {
    // No body, or an unparseable one — a note is optional, so proceed with none.
  }

  const outcome = await submitApplication(context.playerId, note);
  if (!outcome.ok) {
    return NextResponse.json(
      {
        error: "application_unavailable",
        message: "Most nem tudjuk fogadni a jelentkezést. Próbáld újra hamarosan.",
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    status: outcome.application.status,
    submitted_at: outcome.application.submitted_at,
  });
}
