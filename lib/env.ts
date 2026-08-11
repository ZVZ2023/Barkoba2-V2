// ---------------------------------------------------------------------------
// Centralized, typed access to configuration. Nothing in game logic should
// read process.env directly — everything routes through here so model IDs,
// rate limits, and TTLs stay swappable without touching game code.
// ---------------------------------------------------------------------------

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  anthropicApiKey: () => required("ANTHROPIC_API_KEY"),

  // Fast/cheap model for the repeated per-turn Racer loop.
  modelRacer: () => process.env.ANTHROPIC_MODEL_RACER || "claude-haiku-4-5-20251001",

  // Stronger reasoning model for Validator, Adjudicator, Integrity Review —
  // each fires once per game, so cost is not the constraint there, quality is.
  modelStrong: () => process.env.ANTHROPIC_MODEL_STRONG || "claude-sonnet-5",

  // Rate limiting. RATE_LIMIT_DISABLED=true is meant for local dev/testing only.
  rateLimitDisabled: () => process.env.RATE_LIMIT_DISABLED === "true",
  rateLimitGamesPerHour: () => optionalInt("RATE_LIMIT_GAMES_PER_HOUR", 5),

  // Guest game TTL in the KV store.
  gameTtlSeconds: () => optionalInt("GAME_TTL_SECONDS", 24 * 60 * 60),

  maxQuestions: () => optionalInt("MAX_QUESTIONS", 20),

  // Global daily ceiling on Racer model calls, across ALL users and IPs.
  // This is deliberately separate from, and in addition to, the per-IP limit
  // on /api/game/create. Per-IP limiting caps one abuser; it does nothing
  // about aggregate organic traffic or a single actor spread across many IPs.
  // Enforced in lib/callBudget.ts, which FAILS CLOSED: if the counter cannot
  // be read or incremented, the call is denied rather than allowed through.
  racerDailyCallCeiling: () => optionalInt("RACER_DAILY_CALL_CEILING", 2000),

  // Separate ceiling for Adjudicator + Integrity Review. Strong-model calls,
  // at most 2 per completed game and often 1 (a correct guess skips the
  // Integrity Review entirely). Kept separate from the Racer counter so a busy
  // day of cheap turns cannot block adjudication of games already finished.
  resolveDailyCallCeiling: () => optionalInt("RESOLVE_DAILY_CALL_CEILING", 300),

  // Upstash Redis — if absent, kv.ts falls back to an in-memory store
  // suitable for local dev only (state does not survive a restart/redeploy).
  /**
   * Prefix applied to every KV key. Empty by default, which reproduces the
   * exact key shapes V1 has always written — an unset namespace is
   * byte-for-byte V1-compatible, so V1 never has to be redeployed.
   *
   * V2 sets "v2:" so the two lanes can share one Upstash database without
   * sharing game state, rate-limit counters, or daily AI spend ceilings.
   */
  kvNamespace: () => process.env.KV_NAMESPACE || "",

  upstashUrl: () => process.env.UPSTASH_REDIS_REST_URL || null,
  upstashToken: () => process.env.UPSTASH_REDIS_REST_TOKEN || null,

  // --- V2.2: durable game corpus (Neon / PostgreSQL) ----------------------
  //
  // PostgreSQL is durable memory. Redis stays operational state. These are two
  // stores with two jobs, and nothing here migrates an existing Redis
  // responsibility.
  databaseUrl: () => process.env.DATABASE_URL || null,

  /**
   * Master switch for durable corpus persistence. Default OFF, deliberately.
   *
   * The migration can therefore be applied and the code deployed before a
   * single row is written, and the switch is the fastest possible rollback if
   * corpus writes ever misbehave in production — no redeploy, no revert.
   */
  corpusEnabled: () => process.env.CORPUS_ENABLED === "true",

  /**
   * Provenance stamp on every corpus row. Not a legal consent basis: it records
   * WHICH collection regime a game was captured under, so a future public
   * corpus gathered under explicit consent stays distinguishable from the
   * present pre-public family/test research phase. Retrofitting this later is
   * impossible; recording it now costs one column.
   */
  collectionContext: () => process.env.COLLECTION_CONTEXT || "pre_public_research",

  /**
   * Ceiling on how many deferred games one opportunistic reconciliation pass
   * will replay. Bounded so a backlog can never turn a game-creation request
   * into a batch job.
   */
  corpusReconcileBatch: () => optionalInt("CORPUS_RECONCILE_BATCH", 3),
};
