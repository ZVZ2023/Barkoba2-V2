import { getSql, isCorpusConfigured, type SqlClient } from "./corpus/db";
import { env } from "./env";
import { getDurablePlayer, claimPlayer } from "./playerStore";
import { generateRecoveryCode } from "./recoveryCode";
import { playCreditCostForBudget } from "./questionBudget";

// ---------------------------------------------------------------------------
// V2.4 — PLAY CREDIT. The only module permitted to read or write accounts.*,
// mirroring playerStore and gameCorpus.
//
// WHAT A PLAY CREDIT IS NOT: one game, one model call, one token, a monetary
// denomination, or the SÚGÓ/clue credit. lib/clueCredits.ts is a different
// mechanism entirely — derived per game from the transcript, never stored, and
// it does not touch this table. The two share no naming, storage or code path.
//
// WHAT IT IS: an internal entitlement unit attached to the signed player_id
// that exists from first contact. Attach, never replace — the V2.1 invariant
// that lets a player register later without any game, seat or corpus row
// changing.
//
// THIS MODULE MUST NEVER IMPORT secretStore, gameStore, gameView OR seats.
// Entitlement is a pre-game gate; it has no business near game state, seat
// authorization or the secret. scripts/check-isolation.mjs lists it as
// QUARANTINED so that is mechanically enforced.
//
// BALANCE IS ALWAYS SUM(amount). There is no counter to drift.
// ---------------------------------------------------------------------------

export type EntitlementKind =
  | "complimentary_grant"
  | "purchase"
  | "consumption"
  | "expiry"
  | "adjustment";

export interface EntitlementStatus {
  /** Total spendable play_credit. */
  balance: number;
  /** Provenance, preserved: these must never collapse into one number. */
  complimentary_granted: number;
  purchased: number;
  consumed: number;
  expired: number;
}

export type ConsumeOutcome =
  | { ok: true; reason: "consumed" | "already_consumed" | "disabled" | "unlimited" }
  | { ok: false; reason: "insufficient_balance" | "unavailable" | "no_player" };

/**
 * Is the entitlement gate switched on AND its store reachable?
 *
 * Two conditions, like the corpus. Default OFF, so the migration can be applied
 * and this code deployed before a single game is gated — and so the flag is the
 * fastest rollback if gating misbehaves, with no redeploy.
 */
export function isEntitlementEnabled(): boolean {
  return entitlementStatus().enforced;
}

/**
 * Why entitlement is, or is not, enforcing in THIS runtime.
 *
 * WHY THIS EXISTS: on 2.4.1.0 the flag was set in Vercel, the deployment was
 * correct, and no ledger row appeared. `isEntitlementEnabled()` returned a bare
 * boolean, so the state had to be INFERRED from an absence of rows rather than
 * read. That is the same gap the corpus block closed in 2.2.0.1, left open here.
 *
 * `enforced` is a CONJUNCTION, which is exactly why the two halves are reported
 * separately: a bare `false` cannot say whether the flag is off or the store is
 * unreachable, and those have different fixes.
 *
 * CONFIGURATION ONLY. No player id, no balance, no ledger content, no
 * connection string — entitlement has none of its own, it reuses the corpus
 * client. Safe to serve from the public, cacheable /api/version.
 */
export type EntitlementReason =
  /** Enforcing: the gate is live and charging. */
  | "enforcing"
  /** ENTITLEMENTS_ENABLED is not set at all. This is the shipped default. */
  | "flag_unset"
  /** Set, but does not read as true — a typo, a stray quote, a wrong scope. */
  | "flag_not_enabled"
  /** The flag is on, but the ledger's database is not usable. */
  | "store_unavailable";

export interface EntitlementRuntimeStatus {
  enforced: boolean;
  flagEnabled: boolean;
  storeReady: boolean;
  complimentaryGrant: number;
  reason: EntitlementReason;
}

export function entitlementStatus(): EntitlementRuntimeStatus {
  const flagEnabled = env.entitlementsEnabled();
  const flagIsSet = env.entitlementsEnabledIsSet();
  const storeReady = isCorpusConfigured();

  // Store first, mirroring corpusConfigStatus and matching the dependency
  // order: there is nothing to enforce against without a usable ledger.
  let reason: EntitlementReason = "enforcing";
  if (!storeReady) reason = "store_unavailable";
  else if (!flagEnabled) reason = flagIsSet ? "flag_not_enabled" : "flag_unset";

  return {
    enforced: flagEnabled && storeReady,
    flagEnabled,
    storeReady,
    // Reported because "gate on, nothing behind it" blocks every player, and
    // was otherwise invisible from outside.
    complimentaryGrant: env.entitlementComplimentaryGrant(),
    reason,
  };
}

function requireSql(): SqlClient {
  const sql = getSql();
  if (!sql) throw new Error("entitlements: no database client");
  return sql;
}

// ---------------------------------------------------------------------------
// V2.6 — DEVELOPER / TESTER UNLIMITED PLAY.
//
// A designated identity may start games without a balance and without spending
// one. Two people, granted by hand in the database, so that development and
// field testing are never blocked by credits.
//
// WHAT THIS IS NOT, AND THE DISTINCTION IS THE WHOLE DESIGN:
//
//   NOT a large balance. An artificial grant of 100000 credits would be
//   indistinguishable from a real one in every provenance query, and would
//   decay — it is a bigger number, not a different kind of thing.
//
//   NOT a ledger row of any kind. Balance is SUM(amount) and getStatus()
//   buckets that sum into complimentary_granted / purchased / consumed. Any
//   ledger expression of this lands in a bucket and corrupts the Play Credit
//   curve, which is a live workstream awaiting token-level telemetry.
//
//   NOT an exemption from anything except entitlement. Game-creation rate
//   limiting and the daily model-call ceiling remain fully in force. Unlimited
//   PLAY must never become unlimited SPEND: a field-testing loop on an exempt
//   identity could otherwise exhaust the provider budget and take production
//   down for ordinary players, turning a convenience into an availability
//   incident.
//
// It bypasses exactly two things — the balance test in canStartGame() and the
// charge in consumeForGame() — and writes nothing anywhere.
// ---------------------------------------------------------------------------

/**
 * Does this player hold an ACTIVE unlimited-play grant?
 *
 * FAILS CLOSED, INTO ORDINARY ENFORCEMENT. Every failure mode — no client, a
 * throwing query, a missing table on a runtime whose migration has not been
 * applied — returns false, which means the caller proceeds to the normal
 * balance check. That is the safe direction in both senses: an outage of this
 * table cannot hand out free play, and it cannot lock the two developers out of
 * a system they still hold ordinary credits in.
 *
 * Note the ordering constraint this creates for callers: the result must be
 * used to SKIP the balance check, never to gate it. `false` has to mean
 * "carry on as normal", not "refuse".
 *
 * Cheap by construction — a partial index over a table with two rows.
 */
export async function hasUnlimitedPlay(playerId: string | null): Promise<boolean> {
  if (!playerId) return false;
  if (!isCorpusConfigured()) return false;

  try {
    const sql = getSql();
    if (!sql) return false;
    const rows = await sql`
      SELECT 1
        FROM accounts.unlimited_play
       WHERE player_id = ${playerId}
         AND revoked_at IS NULL
       LIMIT 1
    `;
    return rows.length > 0;
  } catch (err) {
    // Deliberately NOT re-thrown and deliberately not treated as a grant. A
    // player who should be exempt and is not merely sees the ordinary gate.
    // eslint-disable-next-line no-console
    console.error(`[barkoba] unlimited-play lookup failed for ${playerId}:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Spendable balance. Derived every time; never cached, never stored. */
export async function getBalance(playerId: string): Promise<number> {
  const sql = requireSql();
  const rows = await sql`
    SELECT COALESCE(SUM(amount), 0) AS balance
      FROM accounts.entitlement_ledger
     WHERE player_id = ${playerId}
  `;
  return Number(rows[0]?.balance ?? 0);
}

/**
 * Balance plus provenance.
 *
 * Complimentary and purchased value spend identically but must remain
 * distinguishable after the fact — "how much of this was paid for?" cannot be
 * reconstructed from a single number once it has been collapsed.
 */
export async function getStatus(playerId: string): Promise<EntitlementStatus> {
  const sql = requireSql();
  const rows = await sql`
    SELECT
      COALESCE(SUM(amount), 0)                                                   AS balance,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'complimentary_grant'), 0)       AS complimentary_granted,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'purchase'), 0)                  AS purchased,
      COALESCE(-SUM(amount) FILTER (WHERE kind = 'consumption'), 0)              AS consumed,
      COALESCE(-SUM(amount) FILTER (WHERE kind = 'expiry'), 0)                   AS expired
    FROM accounts.entitlement_ledger
    WHERE player_id = ${playerId}
  `;
  const r = rows[0] ?? {};
  return {
    balance: Number(r.balance ?? 0),
    complimentary_granted: Number(r.complimentary_granted ?? 0),
    purchased: Number(r.purchased ?? 0),
    consumed: Number(r.consumed ?? 0),
    expired: Number(r.expired ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Granting
// ---------------------------------------------------------------------------

export interface GrantOptions {
  /** At-most-once key. A repeated grant with the same key is silently ignored. */
  grantKey?: string | null;
  expiresAt?: string | null;
  note?: string | null;
}

/**
 * Complimentary play credit. May be granted to an ANONYMOUS, unclaimed player:
 * complimentary value carries no obligation, so it needs no recoverable
 * identity behind it.
 *
 * Accepted consequence for this experimental stage: a player who loses their
 * cookie before claiming loses any unused complimentary balance. That is the
 * documented trade, not an oversight.
 */
export async function grantComplimentary(
  playerId: string,
  amount: number,
  options: GrantOptions = {}
): Promise<boolean> {
  if (amount <= 0) return false;
  const sql = requireSql();

  const rows = await sql`
    INSERT INTO accounts.entitlement_ledger
      (player_id, kind, amount, grant_key, expires_at, note)
    VALUES
      (${playerId}, 'complimentary_grant', ${amount},
       ${options.grantKey ?? null}, ${options.expiresAt ?? null}, ${options.note ?? null})
    ON CONFLICT DO NOTHING
    RETURNING entry_id
  `;
  return rows.length > 0;
}

export interface PurchaseGrantResult {
  granted: boolean;
  /**
   * Set only when this grant triggered a silent claim. THE ONLY TIME THIS CODE
   * IS EVER RETURNED — it is not stored anywhere in recoverable form, exactly
   * like a normal claim. A caller that discards it leaves the player unable to
   * recover the identity holding their purchased value.
   */
  recoveryCode?: string;
}

/**
 * Purchased play credit. REQUIRES A RECOVERABLE IDENTITY.
 *
 * Real-money value must never sit on an identity that exists only as a cookie:
 * clearing the browser would destroy something the player paid for. So this
 * function refuses to write the ledger row until the player has a recovery
 * credential, performing a SILENT CLAIM if they do not.
 *
 * Silent claim attaches a credential to the EXISTING player_id via
 * claimPlayer(), whose contract is explicit that it "never mints a new
 * identity". Nothing about the player's games, seats or history changes.
 *
 * The precondition lives HERE, in the grant function, rather than in a caller.
 * There is no purchase flow yet; when one arrives it cannot forget this.
 *
 * Surfacing the returned code to the player belongs to the future checkout
 * work and is deliberately not built here.
 */
export async function grantPurchase(
  playerId: string,
  amount: number,
  options: GrantOptions = {}
): Promise<PurchaseGrantResult> {
  if (amount <= 0) return { granted: false };

  let recoveryCode: string | undefined;

  const existing = await getDurablePlayer(playerId);
  if (!existing) {
    // Silent claim: credential attached to the same id, no interruption, no
    // replacement. Display name stays null — this is not a profile.
    const code = generateRecoveryCode();
    const claimed = await claimPlayer(playerId, null, code);
    if (!claimed) {
      // Lost a race with another claim. The player is now recoverable either
      // way, which is the precondition we needed; continue without a code.
      if (!(await getDurablePlayer(playerId))) {
        return { granted: false };
      }
    } else {
      recoveryCode = code;
    }
  }

  const sql = requireSql();
  const rows = await sql`
    INSERT INTO accounts.entitlement_ledger
      (player_id, kind, amount, grant_key, expires_at, note)
    VALUES
      (${playerId}, 'purchase', ${amount},
       ${options.grantKey ?? null}, ${options.expiresAt ?? null}, ${options.note ?? null})
    ON CONFLICT DO NOTHING
    RETURNING entry_id
  `;

  return { granted: rows.length > 0, ...(recoveryCode ? { recoveryCode } : {}) };
}

/**
 * Neutralise a lapsed grant by writing a negative 'expiry' row.
 *
 * Expiry is a row rather than a WHERE clause on expires_at so that balance
 * stays a plain SUM: filtering a grant out after it had already been spent
 * would drive the balance negative.
 */
export async function expireCredits(
  playerId: string,
  amount: number,
  note?: string
): Promise<boolean> {
  if (amount <= 0) return false;
  const sql = requireSql();
  const rows = await sql`
    INSERT INTO accounts.entitlement_ledger (player_id, kind, amount, note)
    VALUES (${playerId}, 'expiry', ${-amount}, ${note ?? null})
    RETURNING entry_id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Consuming — the one integration point
// ---------------------------------------------------------------------------

/**
 * Charge one game's entitlement, at creation and nowhere else.
 *
 * ATOMIC BY CONSTRUCTION. The balance test lives inside the INSERT rather than
 * in a read-then-write, so two concurrent creations cannot both observe a
 * balance of one and both spend it.
 *
 * IDEMPOTENT BY CONSTRAINT. The partial unique index on operational_game_id
 * means a retried creation collides with its own earlier consumption instead of
 * charging twice, and the collision is reported as success — the caller asked
 * for this game to be paid for, and it is.
 *
 * NEVER CALLED AGAIN FOR THE LIFE OF THE GAME. That is what guarantees an
 * already-valid game survives later exhaustion, expiry or an outage of this
 * store: there is no second checkpoint that could fail.
 */
export async function consumeForGame(
  playerId: string | null,
  operationalGameId: string,
  questionBudget: number
): Promise<ConsumeOutcome> {
  if (!isEntitlementEnabled()) return { ok: true, reason: "disabled" };
  if (!playerId) return { ok: false, reason: "no_player" };

  // V2.6 — unlimited play, checked BEFORE the cost is derived.
  //
  // The position is what makes the grant budget-INDEPENDENT rather than
  // budget-exempt: a 100-question game and a 20-question game take the same
  // path, because no price is ever computed for an exempt identity. Returning
  // here also means NO CONSUMPTION ROW IS WRITTEN — the ledger never learns
  // that this game happened, which is precisely the analytics guarantee.
  if (await hasUnlimitedPlay(playerId)) return { ok: true, reason: "unlimited" };

  // COST IS DERIVED HERE, FROM A BUDGET, NEVER RECEIVED AS A PRICE.
  //
  // The caller hands over the question budget it resolved server-side — the
  // same value it persisted as max_questions — and the mapping lives inside
  // lib/questionBudget.ts. No caller holds the table, so no request can state
  // or influence what a game costs, even if a client invented a price field.
  const cost = playCreditCostForBudget(questionBudget);
  if (cost <= 0) return { ok: true, reason: "disabled" };

  try {
    const sql = requireSql();

    // A replay of a creation that already paid.
    const existing = await sql`
      SELECT entry_id FROM accounts.entitlement_ledger
       WHERE kind = 'consumption' AND operational_game_id = ${operationalGameId}::uuid
       LIMIT 1
    `;
    if (existing.length > 0) return { ok: true, reason: "already_consumed" };

    // -----------------------------------------------------------------------
    // THE DOUBLE-SPEND GUARD. Documented invariant, not an accidental property
    // of the query shape.
    //
    // The conditional INSERT alone is NOT sufficient. Every statement here runs
    // as its own autocommit transaction under READ COMMITTED, and the balance
    // subquery is a plain non-locking read. Two concurrent charges for the same
    // player with DIFFERENT operational_game_ids would each snapshot the
    // balance before either insert committed, both find it sufficient, and both
    // write — driving the balance negative. The unique index does not help:
    // it only collides a game with itself.
    //
    // So the check and the write are serialised per player by an advisory
    // transaction lock. The second caller blocks until the first commits, then
    // recomputes the balance and correctly finds it insufficient. The lock is
    // released automatically at transaction end — there is nothing to leak.
    //
    // Advisory rather than row locking because there is no row to lock: the
    // anonymous majority has no durable player record, by design. 4242 is an
    // arbitrary namespace constant that keeps this lock space distinct from any
    // other advisory-lock user.
    //
    // Deliberately NOT a reservation table or two-phase commit. One lock and
    // one conditional insert is the whole mechanism.
    // -----------------------------------------------------------------------
    const results = await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(4242, hashtext(${playerId}))`,
      sql`
        INSERT INTO accounts.entitlement_ledger
          (player_id, kind, amount, operational_game_id, note)
        SELECT ${playerId}, 'consumption', ${-cost}, ${operationalGameId}::uuid, 'game_start'
        WHERE (
          SELECT COALESCE(SUM(amount), 0)
            FROM accounts.entitlement_ledger
           WHERE player_id = ${playerId}
        ) >= ${cost}
        ON CONFLICT (operational_game_id) WHERE kind = 'consumption' DO NOTHING
        RETURNING entry_id
      `,
    ]);

    const inserted = results[1] ?? [];
    if (inserted.length > 0) return { ok: true, reason: "consumed" };

    // No row: either the balance test failed, or a concurrent request won the
    // race and already paid for this same game. Both are correct outcomes; the
    // second is success.
    const raced = await sql`
      SELECT entry_id FROM accounts.entitlement_ledger
       WHERE kind = 'consumption' AND operational_game_id = ${operationalGameId}::uuid
       LIMIT 1
    `;
    if (raced.length > 0) return { ok: true, reason: "already_consumed" };

    return { ok: false, reason: "insufficient_balance" };
  } catch (err) {
    // FAIL CLOSED, AND ONLY HERE. An unverifiable entitlement must not hand out
    // a free game — but this posture exists at creation only. No turn, answer,
    // clue, correction or resolution path consults this module, so an outage
    // can never terminate a game already under way.
    // eslint-disable-next-line no-console
    console.error(`[barkoba] entitlement check failed for ${playerId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Read-only pre-check, so a player with no balance is refused BEFORE a model
 * call is spent on them.
 *
 * Advisory only — `consumeForGame` remains the authority, because only the
 * consumption is atomic. This exists to avoid burning an Anthropic call to tell
 * someone they cannot play.
 *
 * Fails closed, like the consumption it precedes.
 */
export async function canStartGame(playerId: string | null): Promise<ConsumeOutcome> {
  if (!isEntitlementEnabled()) return { ok: true, reason: "disabled" };
  if (!playerId) return { ok: false, reason: "no_player" };

  // V2.6 — an exempt identity is never refused here. This pre-check exists only
  // to avoid burning a model call on someone who cannot play; an unlimited
  // player always can, so there is nothing to pre-check.
  if (await hasUnlimitedPlay(playerId)) return { ok: true, reason: "unlimited" };

  try {
    // DIMENSION-BLIND BY DESIGN. This runs before the request body is parsed,
    // so the game's budget — and therefore its cost — is not yet known. It asks
    // only "has this player any balance at all", which is the strongest
    // question available at this point. A player with some balance but not
    // enough for the tier they chose passes here and is correctly refused by
    // the authoritative charge, which knows the budget.
    return (await getBalance(playerId)) > 0
      ? { ok: true, reason: "consumed" }
      : { ok: false, reason: "insufficient_balance" };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] entitlement pre-check failed for ${playerId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * The optional first-contact allowance.
 *
 * Quantity is configuration, not a decision taken here: unset means no
 * automatic grant, and gating with no grants configured simply blocks
 * creation — which is why the rollout flag ships OFF.
 *
 * NEVER THROWS: a failed complimentary grant must not break game creation. The
 * gate that follows will decide on the real balance.
 */
export async function ensureInitialComplimentary(playerId: string | null): Promise<void> {
  if (!isEntitlementEnabled() || !playerId) return;
  const amount = env.entitlementComplimentaryGrant();
  if (amount <= 0) return;

  // V2.6 — an unlimited identity never accrues complimentary value.
  //
  // Not a micro-optimisation. A developer identity that collected the
  // first-contact allowance would put a complimentary_grant row in the ledger
  // that is never spent and never can be, permanently overstating
  // `complimentary_granted` in exactly the provenance query this whole design
  // exists to keep clean. Checked after the amount test so it costs nothing on
  // deployments that grant no allowance at all.
  if (await hasUnlimitedPlay(playerId)) return;

  try {
    await grantComplimentary(playerId, amount, {
      grantKey: "initial_complimentary",
      note: "first contact",
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] initial complimentary grant failed for ${playerId}:`, err);
  }
}
