import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { FEEDBACK_MESSAGE_MAX_LENGTH, submitFeedback } from "@/lib/feedback";
import { checkFeedbackRateLimit, extractClientIp } from "@/lib/rateLimit";

// ---------------------------------------------------------------------------
// V2.9.0 Slice 1 — POST /api/feedback.
//
// NO ACCOUNT, NO VERIFICATION, NO BETA MEMBERSHIP REQUIRED — by product
// decision, restated in lib/feedback.ts's own header. `resolveActingPlayer`
// is still consulted, but ONLY to attach a player_id when one exists; its
// {kind:"none"} outcome does not refuse the request the way it does for
// e.g. game creation.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

interface FeedbackBody {
  message?: unknown;
  category?: unknown;
  game_id?: unknown;
  lang?: unknown;
}

export async function POST(req: NextRequest) {
  const ip = extractClientIp(req.headers);
  const context = await resolveActingPlayer(req.headers);
  const playerId = context.kind === "none" ? null : context.playerId;

  const rateLimit = await checkFeedbackRateLimit(ip, playerId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Túl sok visszajelzés érkezett. Próbáld újra később." },
      { status: 429 }
    );
  }

  let body: FeedbackBody;
  try {
    body = (await req.json()) as FeedbackBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (typeof body.message !== "string") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const outcome = await submitFeedback({
    playerId,
    message: body.message,
    category: typeof body.category === "string" ? body.category : null,
    operationalGameId: typeof body.game_id === "string" ? body.game_id : null,
    lang: typeof body.lang === "string" ? body.lang : null,
  });

  if (!outcome.ok) {
    if (outcome.reason === "empty") {
      return NextResponse.json(
        { error: "empty_message", message: "Írj néhány szót, mielőtt elküldöd." },
        { status: 400 }
      );
    }
    if (outcome.reason === "too_long") {
      return NextResponse.json(
        {
          error: "message_too_long",
          message: `A visszajelzés legfeljebb ${FEEDBACK_MESSAGE_MAX_LENGTH} karakter lehet.`,
        },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "feedback_unavailable", message: "Most nem sikerült elküldeni a visszajelzést. Próbáld újra hamarosan." },
      { status: 503 }
    );
  }

  return NextResponse.json({ ok: true });
}
