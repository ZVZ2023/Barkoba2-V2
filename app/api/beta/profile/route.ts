import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import {
  betaCommunityConfigured,
  getLatestOwnRevision,
  getPublicProfile,
  isBetaMember,
  submitProfileRevision,
} from "@/lib/betaCommunity";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// V2.9.0 Slice 1 — the Founding Tester community profile.
//
// MEMBERSHIP REQUIRED, NOT MERELY AN ACCOUNT: only an APPROVED applicant
// (isBetaMember) may hold or edit a public community profile in this slice.
//
// MODERATION INVARIANT: GET always returns the last APPROVED revision as
// `public_profile` (or null if none was ever approved) SEPARATELY from
// `pending`, which is this player's own latest not-yet-decided submission —
// the two are never merged into one "current" value, so a caller can never
// mistake an unreviewed edit for the live public content.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const MAX_HEADLINE_LENGTH = 80;
const MAX_BIO_LENGTH = 600;

export async function GET(req: NextRequest) {
  if (!env.betaCommunityEnabled() || !betaCommunityConfigured()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account") {
    return NextResponse.json({ error: "account_required" }, { status: 401 });
  }
  if (!(await isBetaMember(context.playerId))) {
    return NextResponse.json({ error: "membership_required" }, { status: 403 });
  }

  const [publicProfile, latest] = await Promise.all([
    getPublicProfile(context.playerId),
    getLatestOwnRevision(context.playerId),
  ]);

  return NextResponse.json({
    public_profile: publicProfile
      ? { headline: publicProfile.headline, bio: publicProfile.bio }
      : null,
    // Only surfaced when it is genuinely awaiting review — an approved or
    // rejected latest revision carries nothing new the caller does not
    // already see in public_profile / their own prior submission.
    pending:
      latest && latest.status === "pending"
        ? { headline: latest.headline, bio: latest.bio, submitted_at: latest.submitted_at }
        : null,
  });
}

export async function POST(req: NextRequest) {
  if (!env.betaCommunityEnabled() || !betaCommunityConfigured()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account") {
    return NextResponse.json({ error: "account_required" }, { status: 401 });
  }
  if (!(await isBetaMember(context.playerId))) {
    return NextResponse.json({ error: "membership_required" }, { status: 403 });
  }

  let body: { headline?: unknown; bio?: unknown };
  try {
    body = (await req.json()) as { headline?: unknown; bio?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const headline =
    typeof body.headline === "string" && body.headline.trim().length > 0
      ? body.headline.trim().slice(0, MAX_HEADLINE_LENGTH)
      : null;
  const bio =
    typeof body.bio === "string" && body.bio.trim().length > 0
      ? body.bio.trim().slice(0, MAX_BIO_LENGTH)
      : null;

  const outcome = await submitProfileRevision(context.playerId, headline, bio);
  if (!outcome.ok) {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  return NextResponse.json({ status: outcome.revision.status, submitted_at: outcome.revision.submitted_at });
}
