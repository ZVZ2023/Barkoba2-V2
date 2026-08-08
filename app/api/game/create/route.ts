import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { runValidator } from "@/lib/prompts/validator";
import { createSecret, lockSecret } from "@/lib/secretStore";
import { createGame } from "@/lib/gameStore";
import { checkGameCreationRateLimit, extractClientIp } from "@/lib/rateLimit";
import { isPersistentKvConfigured } from "@/lib/kv";
import { env } from "@/lib/env";

interface CreateGameBody {
  target: string;
  private_clarification: string;
}

export async function POST(req: NextRequest) {
  // Refuse to start a game that cannot survive its own second request. On a
  // serverless host without Upstash, creation succeeds and every turn then
  // 404s from a different instance — a symptom that points nowhere near its
  // cause. Fail here, loudly, with the actual fix in the message.
  if (process.env.NODE_ENV === "production" && !isPersistentKvConfigured()) {
    return NextResponse.json(
      {
        error: "storage_not_configured",
        message:
          "Barkóba is not fully configured: durable storage is missing, so games cannot persist between turns. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }

  const ip = extractClientIp(req.headers);
  const rateLimit = await checkGameCreationRateLimit(ip);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: `You've reached the guest limit of ${rateLimit.limit} games per hour. Try again later.`,
      },
      { status: 429 }
    );
  }

  let body: CreateGameBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body must be JSON." },
      { status: 400 }
    );
  }

  const target = (body.target || "").trim();
  const clarification = (body.private_clarification || "").trim();

  if (!target) {
    return NextResponse.json(
      { error: "missing_target", message: "Target is required." },
      { status: 400 }
    );
  }
  // The clarification is OPTIONAL (0.3.1.1). The Validator still decides
  // case-by-case whether a target resolves without one, returning
  // CLARIFICATION_REQUIRED when it does not — so nothing ambiguous gets
  // through. That judgment belongs to the Validator, not to a null check here.

  const maxQuestions = env.maxQuestions();

  let validation;
  try {
    validation = await runValidator(target, clarification, maxQuestions);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] Validator call failed:", err);
    return NextResponse.json(
      {
        error: "validator_unavailable",
        message: "Could not validate the target right now. Please try again.",
      },
      { status: 502 }
    );
  }

  if (validation.status === "INVALID") {
    return NextResponse.json({
      status: "INVALID",
      message: validation.message,
    });
  }

  if (validation.status === "CLARIFICATION_REQUIRED") {
    return NextResponse.json({
      status: "CLARIFICATION_REQUIRED",
      message: validation.message,
    });
  }

  // VALID — create the game.
  const gameId = randomUUID();
  await createSecret(gameId, target, clarification);
  // Immutable once questioning begins, per spec — locked at creation since
  // M1-M2 has no edit path between VALID and the first Racer question anyway.
  await lockSecret(gameId);
  const game = await createGame(gameId, {
    phase: "questioning",
    max_questions: maxQuestions,
    // Detected by the Validator from the Composer's own wording — no extra
    // model call, no setup question. Fixed for the life of the game.
    game_language: validation.game_language,
  });

  return NextResponse.json({
    status: "VALID",
    game_id: game.game_id,
    phase: game.phase,
    max_questions: game.max_questions,
    game_language: game.game_language,
    difficulty_warning: validation.difficulty_warning,
  });
}
