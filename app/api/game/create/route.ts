import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { getPlayerAccount } from "@/lib/playerAccounts";
import { runValidator } from "@/lib/prompts/validator";
import { createSecret, lockSecret } from "@/lib/secretStore";
import { createGame, getGame, saveGame } from "@/lib/gameStore";
import { createJoinCode } from "@/lib/joinCode";
import { reconcileOpportunistically } from "@/lib/corpus/gameCorpus";
import {
  canStartGame,
  consumeForGame,
  ensureAnonymousComplimentary,
  ensureInitialComplimentary,
} from "@/lib/entitlements";
import type { ConsumeOutcome } from "@/lib/entitlements";

/**
 * V2.4 — the single entitlement refusal. Registered/account play fails closed:
 * an unverifiable entitlement denies creation rather than risking owned value.
 * TASK 6D adds one explicit exception before this helper: rate-limited guest
 * play may return a successful `guest_fallback` outcome.
 *
 * This posture exists at creation and nowhere else. No turn, answer, clue,
 * correction or resolution route consults entitlement, so neither exhaustion
 * nor an outage of the ledger can ever end a game already under way.
 */
function entitlementRefusal(outcome: ConsumeOutcome): NextResponse | null {
  if (outcome.ok) return null;
  if (outcome.reason === "insufficient_balance") {
    return NextResponse.json(
      {
        error: "no_play_credit",
        message: "Elfogyott a VERSENY-egyenleged. Szerezz további VERSENYT, és jöhet a következő futam.",
      },
      { status: 402 }
    );
  }
  return NextResponse.json(
    {
      error: "entitlement_unavailable",
      message: "Most nem tudjuk ellenőrizni a VERSENY-egyenlegedet. Próbáld újra hamarosan.",
    },
    { status: 503 }
  );
}
import { checkGameCreationRateLimit, extractClientIp } from "@/lib/rateLimit";
import { isPersistentKvConfigured } from "@/lib/kv";
import { chooseComposerTarget } from "@/lib/prompts/composerTarget";
import { consumeModelCall } from "@/lib/callBudget";
import type { ClueMode, Difficulty } from "@/lib/types";
import { resolveQuestionBudget } from "@/lib/questionBudget";
import { resolveGameLanguage } from "@/lib/gameLanguage";
import {
  DEFAULT_RACER_PROVIDER,
  isModelProviderId,
  isProviderAvailable,
} from "@/lib/providers";
import type { ModelProviderId } from "@/lib/providers/types";
import { env } from "@/lib/env";

/**
 * V2.5 — resolve whether this creation is a tagged benchmark run.
 *
 * WHY A SECRET-GATED HEADER AND NOT A BODY FIELD. `benchmark_case_id` is the
 * key that makes N games comparable as one case. A benchmark set that any
 * client can write into is not a benchmark set — one mistagged ordinary game
 * silently corrupts every comparison drawn from it, and because
 * `corpus.games` is immutable once finalized, a mistag can never be removed.
 *
 * FAILS CLOSED, exactly like /api/entitlement/grant: no configured secret means
 * no tagging, and a wrong secret is ignored rather than rejected. This is
 * deliberately NOT a 401 — an unauthenticated caller must not be able to probe
 * whether benchmark ingress is configured, and refusing to start their game
 * over a header they did not knowingly send would be the wrong trade. They get
 * an ordinary, untagged game, which is the correct default.
 *
 * `benchmark_run_id` is minted here and never accepted from the caller, so no
 * request can merge itself into an existing comparison set.
 */
function resolveBenchmark(req: NextRequest): {
  benchmark_case_id: string | null;
  benchmark_run_id: string | null;
} {
  const none = { benchmark_case_id: null, benchmark_run_id: null };

  const configured = env.benchmarkIngressSecret();
  if (!configured) return none;

  const presented = (req.headers.get("x-barkoba-benchmark-secret") ?? "").trim();
  if (!presented || presented.length !== configured.length) return none;
  let diff = 0;
  for (let i = 0; i < presented.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ configured.charCodeAt(i);
  }
  if (diff !== 0) return none;

  // Bounded and normalised: this becomes a join key across games, so a stray
  // newline or 4KB of text would either split a case in two or bloat the row.
  const caseId = (req.headers.get("x-barkoba-benchmark-case") ?? "").trim().slice(0, 120);
  if (!caseId) return none;

  return { benchmark_case_id: caseId, benchmark_run_id: randomUUID() };
}

/**
 * V2.5-B3 — which AI fills the Racer seat.
 *
 * The client PROPOSES; the server decides, exactly as it does for the question
 * budget and the Play Credit price. What the client may state is a provider
 * NAME. It may never state a model id — that stays in the environment, so no
 * request can put an arbitrary model on Barkóba's bill or into the corpus.
 *
 * TWO REFUSALS, NEVER A SUBSTITUTION:
 *
 *   unknown provider     -> 400. The name means nothing here.
 *   unavailable provider -> 503. Registered, but this runtime has no key.
 *
 * Falling back to Anthropic in either case would create a game the player
 * believes was played by Grok and the corpus records as Claude — or worse,
 * records honestly while the player reports the wrong result. Barkóba's whole
 * reason for adding a second provider is to compare them; a silent substitution
 * poisons exactly the evidence the feature exists to produce.
 */
/**
 * V2.8.0 — PUBLIC RELEASE: the ONE provider the server chooses for every
 * ordinary Human↔AI game. A product decision, not a provider-registry
 * default — DEFAULT_RACER_PROVIDER stays "anthropic" and is untouched by
 * this; that constant is a transport-layer fallback used when no provider
 * argument is supplied at all (diagnostic scripts, tests), not a policy
 * about what ordinary players get.
 *
 * WHY THIS EXISTS SEPARATELY FROM resolveRacerProvider's original
 * client-proposes/server-validates contract: that contract stays exactly as
 * it was — see the call site below, which still runs every candidate
 * through the same two refusals (unknown / unavailable), never a
 * substitution. What changed is WHICH VALUE reaches it: an ordinary public
 * caller's own `racer_provider` field is never read at all now, only a
 * validated internal/benchmark caller's is. See the call site for how that
 * boundary is drawn — reusing resolveBenchmark()'s existing secret-header
 * gate rather than inventing a second one.
 */
const PUBLIC_RACER_PROVIDER: ModelProviderId = "xai";

function resolveRacerProvider(
  requested: unknown
): { ok: true; provider: ModelProviderId } | { ok: false; response: NextResponse } {
  if (requested === undefined || requested === null || requested === "") {
    return { ok: true, provider: DEFAULT_RACER_PROVIDER };
  }

  if (!isModelProviderId(requested)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "unknown_provider",
          message: "Ismeretlen ellenfél. Válassz a felkínált lehetőségek közül.",
        },
        { status: 400 }
      ),
    };
  }

  if (!isProviderAvailable(requested)) {
    // eslint-disable-next-line no-console
    console.error(
      `[barkoba] racer provider "${requested}" was requested but is not ` +
        "configured in this runtime — refusing rather than substituting."
    );
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "provider_unavailable",
          message: "Ez az ellenfél most nem elérhető. Válassz másikat.",
        },
        { status: 503 }
      ),
    };
  }

  return { ok: true, provider: requested };
}

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
  /**
   * V2.5-B3 — which AI should race. A NAME only: "anthropic" or "xai". The
   * model id behind it is server-held and never client-authoritative.
   * Meaningful only when the Racer seat is the AI.
   *
   * V2.8.0 — IGNORED for an ordinary public caller. The server pins the
   * public path to PUBLIC_RACER_PROVIDER regardless of what this field
   * says; it is honored only for a caller that already passed
   * resolveBenchmark()'s secret-header gate. Kept in the body type so that
   * internal/benchmark tooling posting through this same route continues to
   * work unchanged.
   */
  racer_provider?: string;
  /**
   * V2.5 — the language the game is PLAYED in: "hu", "en", or absent/"auto"
   * to let Barkóba decide. The shell stays Hungarian either way; this governs
   * model-generated, player-visible output only.
   */
  game_language?: string;
}

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const CLUE_MODES: ClueMode[] = ["none", "minimal", "progressive"];
// QUESTION_BUDGETS moved to lib/questionBudget.ts in 2.3.0.0 so the server that
// validates a budget and the screens that offer it share one definition.

export async function POST(req: NextRequest) {
  // Account authority and guest continuity are deliberately separate. A guest
  // (or a request whose account authority cannot be resolved) may use the
  // existing rate-limited guest allowance. A registered cookie without a live
  // account session may not: it remains information, never account authority.
  const playerContext = await resolveActingPlayer(req.headers);
  const playerId =
    playerContext.kind === "account" || playerContext.kind === "guest"
      ? playerContext.playerId
      : null;
  const entitlementOptions = {
    allowGuestFallback: playerContext.kind === "guest" || playerContext.kind === "none",
  };

  // V2.5 — resolved once, applied to whichever branch creates the game below.
  const benchmark = resolveBenchmark(req);

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

  // V2.7 — the pre-registration allowance for a true anonymous guest, and
  // V2.4's post-verification allowance for a registered account. Mutually
  // exclusive by construction (see lib/entitlements.ts) and both optional:
  // neither throws, and if either does nothing the gate below simply sees
  // the real balance.
  await ensureAnonymousComplimentary(playerId);
  await ensureInitialComplimentary(playerId);

  // Advisory pre-check, so a player with no balance is refused before an
  // Anthropic call is spent telling them so. consumeForGame below remains the
  // authority — only the consumption is atomic.
  const preCheck = await canStartGame(playerId, entitlementOptions);
  const preRefusal = entitlementRefusal(preCheck);
  if (preRefusal) return preRefusal;

  // V2.7.0.13 PRODUCTION FIX — the visitor/IP hourly limit is an ANONYMOUS
  // abuse safeguard and must stay scoped to anonymous play, never to a
  // verified account spending its own held Play Credits.
  //
  // ROOT CAUSE THIS CLOSES: checkGameCreationRateLimit() is keyed purely on
  // client IP, with no identity awareness at all — it counts every game
  // creation from that IP within the hour, straight through the
  // anonymous-guest-to-registered-account transition, since the same device
  // keeps the same IP across both. A human test proved this concretely: one
  // anonymous complimentary game plus four of five post-verification credits
  // spent from the same IP hit the default 5/hour ceiling, and the player's
  // own fifth, legitimately-held credit was refused with the GUEST-limit
  // message — despite passing the entitlement gate above, which already
  // proved they hold real balance.
  //
  // The fix is narrow and identity-scoped, not a removal: an account
  // identity is exempted from this ONE anonymous-abuse check ONLY once its
  // email is actually verified — an unverified registration is not yet
  // trusted any more than a guest is, and must remain rate-limited exactly
  // like one. A true guest (or "none") identity is completely unaffected;
  // RATE_LIMIT_GAMES_PER_HOUR, RACER_DAILY_CALL_CEILING and every other
  // capacity safeguard are untouched.
  const accountForExemption =
    playerContext.kind === "account" ? await getPlayerAccount(playerContext.playerId) : null;
  const isVerifiedAccount = accountForExemption?.email_verified_at != null;

  if (!isVerifiedAccount) {
    const ip = extractClientIp(req.headers);
    // V2.7.0.16 — keyed on (ip, playerId), not ip alone; see
    // checkGameCreationRateLimit's own comment for the production evidence.
    // `playerId` is guaranteed non-null on every path that reaches here: an
    // unresolved identity (kind "registered"/"none") is refused earlier by
    // the entitlement pre-check above, never reaching this line.
    const rateLimit = await checkGameCreationRateLimit(ip, playerId);

    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `Elérted a vendégeknek szóló határt: óránként ${rateLimit.limit} játék. Próbáld újra később.`,
        },
        { status: 429 }
      );
    }
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

    // V2.5 — AI Composer: there is no human text to detect a language from,
    // because the AI picks the target only AFTER the language is fixed. So
    // detection is null and AUTO resolves to "hu" through the shared rule.
    // An explicit English choice makes the AI choose AND play in English.
    const aiGameLanguage = resolveGameLanguage(body.game_language, null);

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
        gameLanguage: aiGameLanguage,
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
      game_language: aiGameLanguage,
      composer_kind: "ai",
      racer_kind: "human",
      difficulty,
      clue_mode: clueMode,
      ...benchmark,
    });

    // Authoritative charge, once the game exists and its id is known. If it
    // fails here the game_id is never returned: the record is orphaned, takes
    // no turns, and therefore never crosses the V2.2 corpus threshold. It
    // expires with the ordinary 24h TTL.
    // The budget is read back off the CREATED RECORD, not from the request:
    // aiGame.max_questions is what the server resolved and persisted. The cost
    // table itself lives in lib/questionBudget.ts and is never held here.
    const aiCharge = await consumeForGame(
      playerId,
      aiGame.game_id,
      aiGame.max_questions,
      entitlementOptions
    );
    const aiRefusal = entitlementRefusal(aiCharge);
    if (aiRefusal) return aiRefusal;

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
  // Applies to BOTH human-Composer flows — this block is only reached when a
  // human set the target, whether the Racer is the AI (/compose) or another
  // person (/play/human). The rule belongs to "a human owns the target", not to
  // who is guessing, so it is resolved once here for both.
  const humanVsHuman = body.mode === "human_human";
  const composerChoseBudget =
    body.difficulty !== undefined || body.max_questions !== undefined;
  const humanDifficulty: Difficulty = DIFFICULTIES.includes(body.difficulty as Difficulty)
    ? (body.difficulty as Difficulty)
    : "easy";
  // No explicit choice keeps the historic behaviour exactly, including the
  // MAX_QUESTIONS deployment knob. A client that does not offer the control is
  // not silently switched onto a different default.
  const maxQuestions = composerChoseBudget
    ? resolveQuestionBudget(humanDifficulty, body.max_questions)
    : env.maxQuestions();

  // V2.5-B3 — resolved BEFORE the Validator runs, so a refusal costs no model
  // call. Only meaningful when the AI races; a Human↔Human game has no provider
  // and must not be refused because one was unavailable.
  //
  // V2.8.0 — SERVER-AUTHORITATIVE PUBLIC PROVIDER. An ordinary caller's own
  // `body.racer_provider` is never read: it is replaced with
  // PUBLIC_RACER_PROVIDER before resolveRacerProvider ever sees it, so no
  // client-controlled mechanism (request body, or anything a future client
  // build might add) can move an ordinary game onto a different provider.
  // Only a caller that already passed resolveBenchmark()'s secret-header gate
  // — a clearly internal/admin/benchmark surface, never reachable from the
  // ordinary player-facing client — may still propose one, preserving the
  // original client-proposes/server-validates contract for that surface only.
  const isBenchmarkCaller = benchmark.benchmark_case_id !== null;
  const racerProviderChoice = resolveRacerProvider(
    humanVsHuman ? undefined : isBenchmarkCaller ? body.racer_provider : PUBLIC_RACER_PROVIDER
  );
  if (!racerProviderChoice.ok) return racerProviderChoice.response;

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
    // Recorded only where an AI actually races. A Human↔Human game has no
    // provider, and writing one would claim a player that does not exist.
    racer_provider: humanVsHuman ? null : racerProviderChoice.provider,
    // Recorded whenever the Composer actually expressed one, in either human
    // flow, so the corpus knows what the allowance was chosen against. Stays
    // null when no choice was made, so games that never had a difficulty are
    // not retroactively given one.
    difficulty: composerChoseBudget ? humanDifficulty : null,
    // Left null until someone joins. awaitingRacer() reads exactly this.
    racer_player_id: null,
    phase: "questioning",
    max_questions: maxQuestions,
    private_target: validation.private_knowledge,
    // V2.5 — the language of PLAY, which is not the language of the shell.
    //
    // An explicit choice from the Composer wins. Absent one, this is the
    // Validator's reading of their own wording — already computed on every
    // game, and until now silently discarded because game_language was pinned
    // to "hu" to stop an English target turning the whole product English.
    //
    // Both earlier behaviours made the same mistake in opposite directions:
    // they treated shell language and game language as one setting. They are
    // separate. The buttons stay Hungarian; only model-generated, player-facing
    // output follows this value. See lib/gameLanguage.ts.
    game_language: resolveGameLanguage(body.game_language, validation.game_language),
    ...benchmark,
  });

  // The invitation exists only for Human↔Human. Separate from the game id on
  // purpose: it can be burned the moment the Racer seat fills, which is what
  // makes "no third player" enforceable rather than merely unlikely.
  // Authoritative charge. Same reasoning as the AI branch: a refusal here
  // leaves an orphaned, turn-less game that never enters the corpus.
  // Same rule: the persisted, server-resolved budget decides the cost.
  const charge = await consumeForGame(
    playerId,
    game.game_id,
    game.max_questions,
    entitlementOptions
  );
  const refusal = entitlementRefusal(charge);
  if (refusal) return refusal;

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
