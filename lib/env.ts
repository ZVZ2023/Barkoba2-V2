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

/**
 * Parse a boolean-ish environment variable.
 *
 * WHY THIS IS NOT `=== "true"`: a value typed into a hosting dashboard picks up
 * whatever the person's clipboard or keyboard produced — `True`, `TRUE`,
 * `"true"` with the quotes kept, or a trailing space or newline. A strict
 * comparison silently reads every one of those as `false`, and a feature that
 * silently does nothing is the hardest kind of failure to diagnose. It cost a
 * full production test cycle on 2.2.0.0.
 *
 * Being permissive here loses nothing: there is no value that should mean
 * "true" but must be rejected.
 */
function booleanFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase().replace(/^["']|["']$/g, "").trim();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  anthropicApiKey: () => required("ANTHROPIC_API_KEY"),

  // Ordinary DICS storefront. Kept for §41.7's own deployment checklist and
  // as the non-Barkóba entry point DICS itself still serves; the V2.7
  // purchase intent route no longer sends a player's browser here — see
  // dicsManifestUrl() below and docs/DESIGN-NOTES.md §51.8.
  dicsStorefrontUrl: () =>
    process.env.DICS_STOREFRONT_URL ||
    "https://zvz2023.github.io/Lighthouse/digital-ice-cream/",

  /**
   * DICS's own machine-readable product catalogue (its "Agent Capability
   * Manifest"). Published BY DICS, FOR exactly this kind of programmatic
   * consumption — its own `recommend_flavor` capability says in so many
   * words: "Present the match and the Payment Link URL; do not complete
   * checkout." Reading it is not scraping a page DICS built for humans; it is
   * using the interface DICS built for callers that are not a browser.
   *
   * lib/dicsCatalog.ts fetches this at request time rather than storing a
   * snapshot in this repo, on purpose: DICS's own manifest explicitly warns
   * against exactly that kind of drift elsewhere in the same document ("not
   * republished here to avoid drift between two copies of the same
   * contract"). A stale local copy of Stripe Payment Links is a
   * purchase-path correctness bug waiting to happen; a live, fail-closed
   * fetch is not.
   */
  dicsManifestUrl: () =>
    process.env.DICS_MANIFEST_URL ||
    "https://zvz2023.github.io/Lighthouse/digital-ice-cream/agent-capability-manifest.json",

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
  corpusEnabled: () => booleanFlag("CORPUS_ENABLED"),

  /** Is the variable present at all, whatever its value? Diagnostics only. */
  corpusEnabledIsSet: () => typeof process.env.CORPUS_ENABLED === "string"
    && process.env.CORPUS_ENABLED.trim().length > 0,

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

  // --- V2.4: Play Credit entitlement --------------------------------------
  //
  // Play Credit is an internal entitlement unit. It is NOT a game, a model
  // call, a token, a currency, or the SÚGÓ/clue credit — that one is derived
  // per game in lib/clueCredits.ts and shares nothing with this.

  /**
   * Master switch for the game-creation entitlement gate. Default OFF.
   *
   * The same deployment order the corpus flag exists for: migrate, deploy,
   * verify nothing changed, then switch gating on. Also the fastest rollback,
   * with no redeploy.
   *
   * NOTE: enabling this with no complimentary grant configured and no purchased
   * balance will block game creation for everyone. That is the honest
   * consequence of a gate with nothing behind it, not a bug.
   */
  entitlementsEnabled: () => booleanFlag("ENTITLEMENTS_ENABLED"),

  /**
   * Is the variable present at all, whatever its value? Diagnostics only.
   *
   * Mirrors corpusEnabledIsSet. It is what separates "never configured" from
   * "configured but unreadable as true" — a distinction that took a round trip
   * through inference to establish when only the parsed boolean was visible.
   */
  entitlementsEnabledIsSet: () => typeof process.env.ENTITLEMENTS_ENABLED === "string"
    && process.env.ENTITLEMENTS_ENABLED.trim().length > 0,

  /**
   * First-contact complimentary allowance, granted at most once per player.
   *
   * V2.4.1 sets this to 10. Spendable on any tier including budget-100 (cost
   * 5) — there is deliberately no complimentary-specific restriction, because
   * RACER_DAILY_CALL_CEILING is the systemwide backstop at this scale.
   *
   * The per-game cost is NOT configured here: it is derived from the resolved
   * question budget in lib/questionBudget.ts, so no deployment setting can put
   * a price in a caller's hands.
   */
  entitlementComplimentaryGrant: () => optionalInt("ENTITLEMENT_COMPLIMENTARY_GRANT", 10),

  /**
   * V2.7 — the pre-registration allowance. Granted at most once per GUEST
   * player_id, before any account exists — separate from, and in addition
   * to, entitlementComplimentaryGrant above, which requires a verified
   * account and never fires for a guest. See lib/entitlements.ts's
   * ensureAnonymousComplimentary.
   *
   * Defaults to 1: one complimentary AI-involved game for an anonymous
   * visitor, matching the V2.7 newcomer journey. Device-bound via the
   * existing signed bk_player cookie — the same abuse-resistance every
   * other guest-scoped mechanism in this codebase already relies on, not a
   * new one invented for this.
   */
  entitlementAnonymousGrant: () => optionalInt("ENTITLEMENT_ANONYMOUS_GRANT", 1),

  /**
   * Shared secret for the server-to-server grant endpoint.
   *
   * SERVER SIDE ONLY. No client-facing code path may read this, and no browser
   * can obtain it — which is precisely what stops a player self-granting
   * credits. A session cookie is deliberately not sufficient authorisation on
   * /api/entitlement/grant.
   *
   * Null means the endpoint is out of service and rejects everything. It must
   * never fall open: an unconfigured grant endpoint that accepted anything
   * would be worse than one that did not exist.
   */
  entitlementGrantSecret: () => process.env.ENTITLEMENT_GRANT_SECRET || null,

  // --- V2.5: Game Intelligence benchmark ingress ---------------------------

  /**
   * Shared secret authorising a game to be TAGGED as a benchmark run at
   * creation.
   *
   * SERVER SIDE ONLY, and deliberately NOT a reuse of ENTITLEMENT_GRANT_SECRET.
   * Those are two unrelated authorities — one hands out money-adjacent value,
   * one labels research evidence — and giving them one secret would mean a
   * rotation or a leak in either blast-radiuses into the other.
   *
   * Null means benchmark tagging is out of service and every attempt is
   * refused. It must never fall open: an unguarded tag would let any client
   * mark its own game as `red-citroen-c4`, and a benchmark set anyone can write
   * into is not a benchmark set. An untagged game is ordinary play, which is
   * the correct and harmless default.
   */
  benchmarkIngressSecret: () => process.env.BENCHMARK_INGRESS_SECRET || null,

  // --- V2.7: admin/operator authorization ----------------------------------

  /**
   * The smallest possible admin allowlist: a comma-separated set of
   * player_ids, hand-maintained here rather than in a database row.
   *
   * DELIBERATELY NOT accounts.unlimited_play. That grant means "may play
   * free forever" — a completely different privilege that happened, so far,
   * to be held by the same two people. Reusing it for "may read capacity
   * telemetry" would mean a future unlimited-play grant to someone who
   * should never see operational data silently also grants that, and
   * revoking telemetry access would require touching a table whose actual
   * job is entitlement exemption. See lib/admin.ts.
   *
   * DELIBERATELY NOT a new accounts.* role column or table either — an env
   * var comparison, matching how rare and how operator-driven this check
   * is, the same posture ENTITLEMENT_GRANT_SECRET and
   * BENCHMARK_INGRESS_SECRET already take for their own rare, unrelated
   * authorities. Unset means no admin access to anything gated on this,
   * for anyone — it must never fall open.
   */
  adminPlayerIds: (): ReadonlySet<string> =>
    new Set(
      (process.env.ADMIN_PLAYER_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    ),

  // --- V2.5-B3: xAI / Grok as a selectable Racer --------------------------
  //
  // Racer seat only. The Validator, Adjudicator, Integrity Review and AI
  // Composer stay on Anthropic permanently — they are the measuring instrument,
  // and the Composer path additionally reads the locked target, which is what
  // keeps the secret from ever reaching a second vendor.

  /**
   * SERVER SIDE ONLY. Never NEXT_PUBLIC_, never returned by any route.
   *
   * OPTIONAL, NOT `required()`. A deployment without this key must keep playing
   * Anthropic games normally; only the xAI path may fail. `required()` throws
   * at call time, which would turn a missing optional key into a broken product.
   *
   * Null means Grok is not selectable in this runtime, and game creation
   * REFUSES a Grok game rather than quietly starting a Claude one.
   */
  xaiApiKey: () => process.env.XAI_API_KEY || null,

  /**
   * The Grok model that fills the Racer seat. Server-controlled: no request may
   * state it, exactly as no request may state a Play Credit price.
   *
   * Default is the plain alias while the account's actual entitlements are
   * unverified. A benchmark corpus should eventually PIN a dated snapshot —
   * xAI aliases `<model>` to whatever is newest, and a benchmark whose player
   * silently changes is not a benchmark. The recorded model_id proves which was
   * really used either way, so this is a sharpening step, not a correctness one.
   */
  xaiModelRacer: () => process.env.XAI_MODEL_RACER || "grok-4.6",

  /**
   * Minimum output allowance for a Grok Racer turn.
   *
   * Grok 4.6 is a reasoning model and reasoning tokens count against the output
   * cap. Barkóba asks for 512, sized for Haiku emitting a question plus a
   * two-sentence rationale; the same cap can truncate a reasoning model before
   * it reaches the tool call, which would look like bad play rather than a cut
   * -off response. This is a TRANSPORT parameter — prompt, schema, transcript
   * and question budget stay byte-identical across providers.
   */
  xaiMaxTokensRacer: () => optionalInt("XAI_MAX_TOKENS_RACER", 2048),

  // --- V2.6.x: registration email verification (Resend) --------------------
  //
  // OPTIONAL, NOT required() — mirrors xaiApiKey. An unconfigured deployment
  // must keep registering accounts normally: sendVerificationEmail() reports
  // sent:false and registration proceeds regardless; see the caller in
  // app/api/account/register/route.ts.
  resendApiKey: () => process.env.RESEND_API_KEY || null,

  /**
   * The From header for the verification email. Defaults to Resend's own
   * sandbox sender, which only reaches the Resend account's own verified
   * address — enough to prove the wiring works end to end, not enough for
   * real players until a verified sending domain is configured here.
   */
  resendFromEmail: () => process.env.RESEND_FROM_EMAIL || "Barkóba <onboarding@resend.dev>",

  // --- V2.6.x: profile photo upload (Vercel Blob) ---------------------------
  blobReadWriteToken: () => process.env.BLOB_READ_WRITE_TOKEN || null,

  /**
   * The absolute origin this deployment is reachable at. Needed only for a
   * link that leaves the browser entirely (an email) — unlike the DICS
   * return_url in app/api/entitlement/intent/route.ts, which stays relative
   * on purpose because the browser is already on this site when it's used.
   *
   * Falls back to Vercel's own deployment-URL variables, which need no
   * manual setup on Vercel. SITE_URL only needs to be set explicitly to
   * override them — e.g. to prefer a custom domain over the raw
   * *.vercel.app one.
   */
  siteUrl: (): string | null => {
    const explicit = process.env.SITE_URL;
    if (explicit) return explicit.replace(/\/+$/, "");
    const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (productionUrl) return `https://${productionUrl}`;
    const deploymentUrl = process.env.VERCEL_URL;
    if (deploymentUrl) return `https://${deploymentUrl}`;
    return null;
  },
};
