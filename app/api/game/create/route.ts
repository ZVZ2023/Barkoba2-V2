import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { playerIdFromHeaders } from "@/lib/playerIdentity";
import { runValidator } from "@/lib/prompts/validator";
import { createSecret, lockSecret } from "@/lib/secretStore";
import { createGame, getGame, saveGame } from "@/lib/gameStore";
import { createJoinCode } from "@/lib/joinCode";
import { reconcileOpportunistically } from "@/lib/corpus/gameCorpus";
import { checkGameCreationRateLimit, extractClientIp } from "@/lib/rateLimit";
import { isPersistentKvConfigured } from "@/lib/kv";
import { chooseComposerTarget } from "@/lib/prompts/composerTarget";
import { consumeModelCall } from "@/lib/callBudget";
import type { ClueMode, Difficulty } from "@/lib/types";
import { resolveQuestionBudget } from "@/lib/questionBudget";
import { env } from "@/lib/env";

interface CreateGameBody {
  /** 0.3.x — human Composer. */
  target?: string;
  private_clarification?: string;
  /** 0.6.x — AI Composer. When "ai_composer", the AI chooses the target. */
  mode?: "human_composer" | "ai_composer" | "human_human";
  /**
   * The Composer has seen the Validator's warning and chosen to play anyway.
   * The human decision is final: Barkóba's Composer owns the target.
   */
  force?: boolean;
  difficulty?: Difficulty;
  clue_mode?: ClueMode;
  max_questions?: number;
}

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const CLUE_MODES: ClueMode[] = ["none", "minimal", "progressive"];
// QUESTION_BUDGETS moved to lib/questionBudget.ts in 2.3.0.0 so the server that
// validates a budget and the screens that offer it share one definition.

export async function POST(req: NextRequest) {
  // V2.1.1 — who is acting. Null whenever identity is unconfigured; the game is
  // fully playable either way, which is why nothing below branches on it.
  const playerId = playerIdFromHeaders(req.headers);

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

  // -------------------------------------------------------------------------
  // V2.2 — opportunistic corpus reconciliation.
  //
  // Game creation is the natural trigger: it is the one request that is not
  // already waiting on a model call for a turn in progress, and someone
  // starting a game is exactly when a previous game's deferred write is worth
  // retrying. Bounded by CORPUS_RECONCILE_BATCH so a backlog can never turn
  // this request into a batch job, and it never throws.
  //
  // getGame is injected so lib/corpus/* stays a leaf of the dependency graph.
  // This is deliberately not Cron and deliberately not a queue.
  // -------------------------------------------------------------------------
  void reconcileOpportunistically(getGame).catch(() => undefined);

  const ip = extractClientIp(req.headers);
  const rateLimit = await checkGameCreationRateLimit(ip);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: `Elérted a vendégeknek szóló határt: óránként ${rateLimit.limit} játék. Próbáld újra később.`,
      },
      { status: 429 }
    );
  }

  let body: CreateGameBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "A kérés törzsének JSON formátumúnak kell lennie." },
      { status: 400 }
    );
  }

  // -------------------------------------------------------------------------
  // 0.6.x — AI Composer, human Racer.
  //
  // The AI picks the target and its definition, and both go straight into
  // secretStore and are locked, exactly as a human Composer's would. From this
  // point the two game modes share one engine: the same store, the same
  // adjudication, the same integrity review. Nothing downstream asks which
  // seat the AI occupied.
  // -------------------------------------------------------------------------
  if (body.mode === "ai_composer") {
    const difficulty: Difficulty = DIFFICULTIES.includes(body.difficulty as Difficulty)
      ? (body.difficulty as Difficulty)
      : "medium";

    // The clue selector is only offered on Hard; anything else is forced to
    // "none" here rather than trusted from the client.
    const clueMode: ClueMode =
      difficulty === "hard" && CLUE_MODES.includes(body.clue_mode as ClueMode)
        ? (body.clue_mode as ClueMode)
        : "none";

    // Unchanged behaviour: an unrecognised value falls back. The AI-Composer
    // screen has always defaulted to 20 regardless of difficulty, so it passes
    // "easy" as the fallback basis rather than adopting the new recommendation.
    const budgetChoice = resolveQuestionBudget("easy", body.max_questions);

    const callBudget = await consumeModelCall("resolve");
    if (!callBudget.allowed) {
      return NextResponse.json(
        {
          error: callBudget.failedClosed ? "budget_unavailable" : "budget_exhausted",
          message: callBudget.failedClosed
            ? "Most nem tudjuk ellenőrizni a keretet. Próbáld újra hamarosan."
            : "A Barkóba elérte a napi globális határát. Próbáld újra holnap.",
        },
        { status: callBudget.failedClosed ? 503 : 429 }
      );
    }

    let chosen;
    try {
      chosen = await chooseComposerTarget({
        difficulty,
        // The V1 interface is Hungarian, so the game is played in Hungarian.
        // This used to be hardcoded "en", which is why AI questions, guesses
        // and adjudication all came back in English under a Hungarian UI.
        gameLanguage: "hu",
        maxQuestions: budgetChoice,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[barkoba] Composer target selection failed:", err);
      return NextResponse.json(
        {
          error: "composer_unavailable",
          message: "Most nem sikerült elindítani a játékot. Próbáld újra.",
        },
        { status: 502 }
      );
    }

    if (!chosen.target || !chosen.definition) {
      return NextResponse.json(
        {
          error: "composer_invalid_target",
          message: "Nem született használható titok. Próbáld újra.",
        },
        { status: 502 }
      );
    }

    const aiGameId = randomUUID();
    await createSecret(
      aiGameId,
      chosen.target,
      chosen.definition,
      chosen.granularity,
      chosen.modifiers
    );
    await lockSecret(aiGameId);

    const aiGame = await createGame(aiGameId, {
      player_id: playerId,
      phase: "questioning",
      max_questions: budgetChoice,
      game_language: "hu",
      composer_kind: "ai",
      racer_kind: "human",
      difficulty,
      clue_mode: clueMode,
    });

    return NextResponse.json({
      status: "VALID",
      game_id: aiGame.game_id,
      phase: aiGame.phase,
      max_questions: aiGame.max_questions,
      difficulty,
      clue_mode: clueMode,
    });
  }

  const target = (body.target || "").trim();
  const clarification = (body.private_clarification || "").trim();

  if (!target) {
    return NextResponse.json(
      { error: "missing_target", message: "Meg kell adnod, mire gondolsz." },
      { status: 400 }
    );
  }
  // The clarification is OPTIONAL (0.3.1.1). The Validator still decides
  // case-by-case whether a target resolves without one, returning
  // CLARIFICATION_REQUIRED when it does not — so nothing ambiguous gets
  // through. That judgment belongs to the Validator, not to a null check here.

  // V2.3 — the Human↔Human Composer chooses the allowance. Barkóba recommends
  // one from the selected difficulty; the Composer may override it before the
  // target is locked, and whatever survives here becomes authoritative game
  // state. /hh/turn enforces it against question_count on every question, so
  // the choice governs play rather than merely being displayed.
  //
  // The 0.3.x human-Composer mode is untouched and keeps env.maxQuestions().
  //
  // Resolved BEFORE the Validator runs, because the Validator is told the
  // allowance — a target that is reasonable inside 50 questions may not be
  // inside 20, so it must judge against the budget the game will actually use.
  const humanVsHuman = body.mode === "human_human";
  const humanDifficulty: Difficulty = DIFFICULTIES.includes(body.difficulty as Difficulty)
    ? (body.difficulty as Difficulty)
    : "easy";
  const maxQuestions = humanVsHuman
    ? resolveQuestionBudget(humanDifficulty, body.max_questions)
    : env.maxQuestions();

  let validation;
  try {
    validation = await runValidator(target, clarification, maxQuestions);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] Validator call failed:", err);
    return NextResponse.json(
      {
        error: "validator_unavailable",
        message: "Most nem sikerült ellenőrizni, amire gondoltál. Próbáld újra.",
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

  // The Composer owns the target. A clarification request is a RECOMMENDATION,
  // and once the player has seen it and chosen to continue, it is overridden.
  // The Validator can still stop a structurally unusable submission on the
  // first attempt — it just cannot insist.
  if (validation.status === "CLARIFICATION_REQUIRED" && !body.force) {
    return NextResponse.json({
      status: "CLARIFICATION_REQUIRED",
      message: validation.message,
      private_knowledge: validation.private_knowledge,
      can_continue: true,
    });
  }

  // VALID — create the game.
  //
  // V2.3: "human_human" reuses this entire path — the same Validator, the same
  // secret creation, the same lock. Only the seats differ. The Composer sets
  // the target BEFORE inviting, which is a deliberate simplification of the
  // scoped flow: it removes a "waiting for the Composer to think" state that
  // the second player would otherwise sit in, and it means a join link is never
  // live for a game that has no secret yet.
  const gameId = randomUUID();
  await createSecret(gameId, target, clarification);
  // Immutable once questioning begins, per spec — locked at creation since
  // M1-M2 has no edit path between VALID and the first Racer question anyway.
  await lockSecret(gameId);
  const game = await createGame(gameId, {
    player_id: playerId,
    // The creator always takes the Composer seat. Recorded for BOTH modes so
    // the seat model has one meaning everywhere rather than a special case.
    composer_player_id: playerId,
    racer_kind: humanVsHuman ? "human" : "ai",
    // Recorded for Human↔Human so the corpus knows what the allowance was
    // chosen against. Null in 0.3.x, where difficulty is not a concept.
    difficulty: humanVsHuman ? humanDifficulty : null,
    // Left null until someone joins. awaitingRacer() reads exactly this.
    racer_player_id: null,
    phase: "questioning",
    max_questions: maxQuestions,
    private_target: validation.private_knowledge,
    // Detected by the Validator from the Composer's own wording — no extra
    // model call, no setup question. Fixed for the life of the game.
    // Detection decided the language from the Composer's own words, which meant
    // an English target ("My Friend Otto") produced an English game inside a
    // Hungarian product. V1 is Hungarian-first, so the interface language wins.
    game_language: "hu",
  });

  // The invitation exists only for Human↔Human. Separate from the game id on
  // purpose: it can be burned the moment the Racer seat fills, which is what
  // makes "no third player" enforceable rather than merely unlikely.
  const joinCode = humanVsHuman ? await createJoinCode(game.game_id) : null;
  if (joinCode) {
    // Held on the record so a refreshed Composer can retrieve the link.
    game.join_code = joinCode;
    await saveGame(game);
  }

  return NextResponse.json({
    status: "VALID",
    game_id: game.game_id,
    phase: game.phase,
    max_questions: game.max_questions,
    game_language: game.game_language,
    difficulty_warning: validation.difficulty_warning,
    private_knowledge: validation.private_knowledge,
    join_code: joinCode,
  });
}
