import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { isAdminPlayer } from "@/lib/admin";
import {
  betaCommunityConfigured,
  reviewApplication,
  reviewProfileRevision,
} from "@/lib/betaCommunity";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// V2.9.0 Slice 1 — POST /api/beta/admin/review.
//
// ADMIN-ONLY (isAdminPlayer, see queue/route.ts's identical doc), AND
// self-review is refused by lib/betaCommunity.ts's reviewApplication/
// reviewProfileRevision THEMSELVES — not merely by this route trusting the
// caller is never also the applicant. Both checks exist independently: an
// ordinary (non-admin) caller is refused here before either function is
// even called; an admin reviewing THEIR OWN application/revision is refused
// inside the function regardless of their admin status.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

interface ReviewBody {
  target?: unknown;
  id?: unknown;
  decision?: unknown;
  rejection_reason?: unknown;
}

const MAX_REJECTION_REASON_LENGTH = 500;

function errorFor(reason: string): { status: number; error: string; message: string } {
  switch (reason) {
    case "not_found":
      return { status: 404, error: "not_found", message: "Ismeretlen tétel." };
    case "self_review":
      return { status: 403, error: "self_review", message: "Saját jelentkezés/profil nem bírálható el." };
    case "already_reviewed":
      return { status: 409, error: "already_reviewed", message: "Ezt már elbírálták." };
    default:
      return { status: 503, error: "unavailable", message: "Most nem sikerült elmenteni a döntést." };
  }
}

export async function POST(req: NextRequest) {
  if (!env.betaCommunityEnabled() || !betaCommunityConfigured()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account" || !isAdminPlayer(context.playerId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: ReviewBody;
  try {
    body = (await req.json()) as ReviewBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { target, id, decision } = body;
  if (target !== "application" && target !== "profile_revision") {
    return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }
  const numericId = typeof id === "number" && Number.isSafeInteger(id) ? id : null;
  if (numericId === null) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const rejectionReason =
    typeof body.rejection_reason === "string" && body.rejection_reason.trim().length > 0
      ? body.rejection_reason.trim().slice(0, MAX_REJECTION_REASON_LENGTH)
      : null;

  const outcome =
    target === "application"
      ? await reviewApplication(numericId, context.playerId, decision, rejectionReason)
      : await reviewProfileRevision(numericId, context.playerId, decision);

  if (!outcome.ok) {
    const { status, error, message } = errorFor(outcome.reason);
    return NextResponse.json({ error, message }, { status });
  }

  return NextResponse.json({ ok: true });
}
