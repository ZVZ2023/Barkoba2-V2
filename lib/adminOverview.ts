import { getSql, isCorpusConfigured, type SqlClient } from "./corpus/db";

// ---------------------------------------------------------------------------
// V2.9.2 — read-only aggregate queries for the admin overview
// (app/api/admin/overview/route.ts). ADMIN-GATED BY THE CALLER, NOT HERE —
// mirrors lib/feedback.ts's own "this module has no concept of who is
// asking" contract.
//
// EVERY FUNCTION HERE NEVER THROWS, returns null/an explicit outcome on
// failure instead — matching lib/corpus/gameCorpus.ts's
// questionBudgetDistributionToday() and lib/feedback.ts's
// listRecentFeedback(), the two existing precedents this file follows.
//
// AGGREGATE AND METADATA ONLY. No target, no transcript, no guess, no
// card/email/name payment data (purchase_facts never contains those fields
// to begin with — see lib/purchaseFacts.ts's own schema).
// ---------------------------------------------------------------------------

export type AdminOverviewRange = "today" | "7d" | "all";

/** null means "all time" — no lower bound. */
export function rangeSince(range: AdminOverviewRange): Date | null {
  const now = new Date();
  if (range === "today") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  if (range === "7d") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  return null;
}

function requireSql(): SqlClient {
  const sql = getSql();
  if (!sql) throw new Error("adminOverview: no database client");
  return sql;
}

// ---------------------------------------------------------------------------
// Accounts: registered / verified / pending — always ALL-TIME. "Total"
// describes current account state, not a period's activity, so this is
// deliberately not filtered by range (unlike every other section below).
// ---------------------------------------------------------------------------

export interface AccountTotals {
  registered: number;
  verified: number;
  pending_verification: number;
}

export async function getAccountTotals(): Promise<AccountTotals | null> {
  if (!isCorpusConfigured()) return null;
  try {
    const sql = requireSql();
    const rows = await sql`
      SELECT
        COUNT(*)::int AS registered,
        COUNT(*) FILTER (WHERE email_verified_at IS NOT NULL)::int AS verified,
        COUNT(*) FILTER (WHERE email IS NOT NULL AND email_verified_at IS NULL)::int AS pending_verification
        FROM accounts.players
       WHERE disabled_at IS NULL
    `;
    const row = rows[0];
    if (!row) return { registered: 0, verified: 0, pending_verification: 0 };
    return {
      registered: Number(row.registered),
      verified: Number(row.verified),
      pending_verification: Number(row.pending_verification),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] adminOverview: account totals read failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recent signups — stable keyset pagination on (registered_at, player_id),
// the exact idiom lib/feedback.ts's listRecentFeedback already established
// for (created_at, submission_id).
// ---------------------------------------------------------------------------

export const SIGNUPS_PAGE_SIZE = 20;

export interface RecentSignup {
  player_id: string;
  display_name: string | null;
  email: string | null;
  verified: boolean;
  registered_at: string;
}

export interface RecentSignupsResult {
  items: RecentSignup[];
  next_cursor: string | null;
}

interface SignupCursor {
  registeredAt: string;
  playerId: string;
}

function encodeSignupCursor(cursor: SignupCursor): string {
  return Buffer.from(`${cursor.registeredAt}|${cursor.playerId}`, "utf8").toString("base64url");
}

function decodeSignupCursor(token: string): SignupCursor | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep <= 0) return null;
    const registeredAt = decoded.slice(0, sep);
    const playerId = decoded.slice(sep + 1);
    if (Number.isNaN(Date.parse(registeredAt)) || !playerId) return null;
    return { registeredAt, playerId };
  } catch {
    return null;
  }
}

export type ListRecentSignupsOutcome =
  | { ok: true; result: RecentSignupsResult }
  | { ok: false; reason: "unavailable" | "invalid_cursor" };

export async function listRecentSignups(cursorToken?: string | null): Promise<ListRecentSignupsOutcome> {
  if (!isCorpusConfigured()) return { ok: false, reason: "unavailable" };

  let cursor: SignupCursor | null = null;
  if (typeof cursorToken === "string" && cursorToken.length > 0) {
    cursor = decodeSignupCursor(cursorToken);
    if (!cursor) return { ok: false, reason: "invalid_cursor" };
  }

  try {
    const sql = requireSql();
    const rows = cursor
      ? await sql`
          SELECT player_id, display_name, email, email_verified_at, registered_at
            FROM accounts.players
           WHERE disabled_at IS NULL
             AND (registered_at, player_id) < (${cursor.registeredAt}::timestamptz, ${cursor.playerId})
           ORDER BY registered_at DESC, player_id DESC
           LIMIT ${SIGNUPS_PAGE_SIZE + 1}
        `
      : await sql`
          SELECT player_id, display_name, email, email_verified_at, registered_at
            FROM accounts.players
           WHERE disabled_at IS NULL
           ORDER BY registered_at DESC, player_id DESC
           LIMIT ${SIGNUPS_PAGE_SIZE + 1}
        `;

    const hasMore = rows.length > SIGNUPS_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, SIGNUPS_PAGE_SIZE) : rows;
    const last = page[page.length - 1];

    return {
      ok: true,
      result: {
        items: page.map((row) => ({
          player_id: String(row.player_id),
          display_name: row.display_name ? String(row.display_name) : null,
          email: row.email ? String(row.email) : null,
          verified: row.email_verified_at !== null,
          registered_at:
            row.registered_at instanceof Date ? row.registered_at.toISOString() : String(row.registered_at),
        })),
        next_cursor:
          hasMore && last
            ? encodeSignupCursor({
                registeredAt:
                  last.registered_at instanceof Date ? last.registered_at.toISOString() : String(last.registered_at),
                playerId: String(last.player_id),
              })
            : null,
      },
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] adminOverview: recent signups read failed:", err);
    return { ok: false, reason: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Games started/completed and outcome breakdown, bounded to `since` (or
// all-time when null). A row exists in corpus.games only once a game has
// at least one completed question/answer (see that table's own migration
// header) — "started" therefore means "reached that threshold", not
// "every /api/game/create call".
// ---------------------------------------------------------------------------

export interface GameLifecycleSummary {
  started: number;
  completed: number;
  by_outcome: { outcome: string; count: number }[];
  /** corpus.games rows with lifecycle_state stalled_resolving/expired_unresolved — see this module's own header on why this is the only durable failure-shaped signal in this codebase, and is labelled as game-lifecycle only, never a general operational-failure log. */
  stalled_or_expired: number;
}

export async function getGameLifecycleSummary(since: Date | null): Promise<GameLifecycleSummary | null> {
  if (!isCorpusConfigured()) return null;
  try {
    const sql = requireSql();
    const lifecycleRows = since
      ? await sql`
          SELECT lifecycle_state, COUNT(*)::int AS count
            FROM corpus.games
           WHERE created_at >= ${since.toISOString()}::timestamptz
           GROUP BY lifecycle_state
        `
      : await sql`
          SELECT lifecycle_state, COUNT(*)::int AS count
            FROM corpus.games
           GROUP BY lifecycle_state
        `;
    const outcomeRows = since
      ? await sql`
          SELECT outcome, COUNT(*)::int AS count
            FROM corpus.games
           WHERE created_at >= ${since.toISOString()}::timestamptz AND outcome IS NOT NULL
           GROUP BY outcome
        `
      : await sql`
          SELECT outcome, COUNT(*)::int AS count
            FROM corpus.games
           WHERE outcome IS NOT NULL
           GROUP BY outcome
        `;

    let started = 0;
    let completed = 0;
    let stalledOrExpired = 0;
    for (const row of lifecycleRows) {
      const count = Number(row.count);
      started += count; // every corpus.games row is a game that started, by this table's own definition
      if (row.lifecycle_state === "completed") completed += count;
      if (row.lifecycle_state === "stalled_resolving" || row.lifecycle_state === "expired_unresolved") {
        stalledOrExpired += count;
      }
    }

    return {
      started,
      completed,
      by_outcome: outcomeRows.map((row) => ({ outcome: String(row.outcome), count: Number(row.count) })),
      stalled_or_expired: stalledOrExpired,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] adminOverview: game lifecycle summary read failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Purchased credits / payment status, from accounts.entitlement_ledger's
// existing purchase_facts (migration 0008) — never a card/email/name field,
// because purchase_facts itself never contains those (lib/purchaseFacts.ts's
// own validated schema).
// ---------------------------------------------------------------------------

export const RECENT_PURCHASES_LIMIT = 20;

export interface RecentPurchase {
  created_at: string;
  amount: number;
  product: string | null;
  flavour: string | null;
  quantity: number | null;
  currency: string | null;
  amount_total: number | null;
  livemode: boolean | null;
}

export interface PurchaseSummary {
  purchase_count: number;
  credits_granted: number;
  recent: RecentPurchase[];
}

export async function getPurchaseSummary(since: Date | null): Promise<PurchaseSummary | null> {
  if (!isCorpusConfigured()) return null;
  try {
    const sql = requireSql();
    const totalsRows = since
      ? await sql`
          SELECT COUNT(*)::int AS purchase_count, COALESCE(SUM(amount), 0)::int AS credits_granted
            FROM accounts.entitlement_ledger
           WHERE kind = 'purchase' AND created_at >= ${since.toISOString()}::timestamptz
        `
      : await sql`
          SELECT COUNT(*)::int AS purchase_count, COALESCE(SUM(amount), 0)::int AS credits_granted
            FROM accounts.entitlement_ledger
           WHERE kind = 'purchase'
        `;
    const recentRows = since
      ? await sql`
          SELECT created_at, amount, purchase_facts
            FROM accounts.entitlement_ledger
           WHERE kind = 'purchase' AND created_at >= ${since.toISOString()}::timestamptz
           ORDER BY created_at DESC
           LIMIT ${RECENT_PURCHASES_LIMIT}
        `
      : await sql`
          SELECT created_at, amount, purchase_facts
            FROM accounts.entitlement_ledger
           WHERE kind = 'purchase'
           ORDER BY created_at DESC
           LIMIT ${RECENT_PURCHASES_LIMIT}
        `;

    const totals = totalsRows[0];
    return {
      purchase_count: totals ? Number(totals.purchase_count) : 0,
      credits_granted: totals ? Number(totals.credits_granted) : 0,
      recent: recentRows.map((row) => {
        const facts = (row.purchase_facts ?? null) as Record<string, unknown> | null;
        return {
          created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
          amount: Number(row.amount),
          product: facts && typeof facts.product === "string" ? facts.product : null,
          flavour: facts && typeof facts.flavour === "string" ? facts.flavour : null,
          quantity: facts && typeof facts.quantity === "number" ? facts.quantity : null,
          currency: facts && typeof facts.currency === "string" ? facts.currency : null,
          amount_total: facts && typeof facts.amount_total === "number" ? facts.amount_total : null,
          livemode: facts && typeof facts.livemode === "boolean" ? facts.livemode : null,
        };
      }),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] adminOverview: purchase summary read failed:", err);
    return null;
  }
}
