import { getSql, isCorpusConfigured, type SqlClient } from "./corpus/db";
import { env } from "./env";

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 — LIMITED BETA / FOUNDING TESTER FOUNDATION.
//
// Two conditions gate every beta/community surface, exactly like the
// entitlement gate's own two-part posture (lib/entitlements.ts): the feature
// flag AND a reachable store. Both must hold, or the feature behaves as if
// it does not exist — never a half-working state that leaks which half
// failed to a caller who cannot act on it.
//
// STORED SEPARATELY FROM accounts.* AND corpus.*, in beta.* and feedback.*
// — see migration 0015's own header for why. THIS MODULE IS THE ONLY
// READER/WRITER of beta.* and feedback.*, mirroring the "one module owns
// one schema" convention lib/entitlements.ts and lib/corpus/gameCorpus.ts
// already establish.
//
// APPROVAL NEVER TOUCHES accounts.entitlement_ledger. Nothing in this
// module imports lib/entitlements.ts, and nothing here writes a Play
// Credit. Founding Tester status is a community/product fact, not a
// commercial one — conflating the two would be exactly the "approval must
// not grant or alter ordinary game credits" mistake the product decision
// rules out.
// ---------------------------------------------------------------------------

export type BetaApplicationStatus = "pending" | "approved" | "rejected";

export interface BetaApplication {
  application_id: number;
  player_id: string;
  status: BetaApplicationStatus;
  note: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
}

/** Both halves of the gate, reported separately — mirrors entitlementStatus(). */
export function betaCommunityConfigured(): boolean {
  return env.betaCommunityEnabled() && isCorpusConfigured();
}

function requireSql(): SqlClient {
  const sql = getSql();
  if (!sql) throw new Error("betaCommunity: no database client");
  return sql;
}

function toApplication(row: Record<string, unknown>): BetaApplication {
  return {
    application_id: Number(row.application_id),
    player_id: String(row.player_id),
    status: row.status as BetaApplicationStatus,
    note: typeof row.note === "string" ? row.note : null,
    submitted_at:
      row.submitted_at instanceof Date ? row.submitted_at.toISOString() : String(row.submitted_at),
    reviewed_at:
      row.reviewed_at instanceof Date
        ? row.reviewed_at.toISOString()
        : typeof row.reviewed_at === "string"
          ? row.reviewed_at
          : null,
    reviewed_by: typeof row.reviewed_by === "string" ? row.reviewed_by : null,
    rejection_reason: typeof row.rejection_reason === "string" ? row.rejection_reason : null,
  };
}

// ---------------------------------------------------------------------------
// Applications.
// ---------------------------------------------------------------------------

/** This player's own application, or null if they have never applied. NEVER THROWS. */
export async function getApplication(playerId: string): Promise<BetaApplication | null> {
  if (!betaCommunityConfigured()) return null;
  try {
    const sql = requireSql();
    const rows = await sql`
      SELECT application_id, player_id, status, note, submitted_at,
             reviewed_at, reviewed_by, rejection_reason
        FROM beta.applications
       WHERE player_id = ${playerId}
    `;
    return rows.length > 0 ? toApplication(rows[0]!) : null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] beta application read failed for ${playerId}:`, err);
    return null;
  }
}

/** Is this player an approved Founding Tester? Derived, never a second table. */
export async function isBetaMember(playerId: string | null): Promise<boolean> {
  if (!playerId) return false;
  const app = await getApplication(playerId);
  return app?.status === "approved";
}

export type SubmitApplicationOutcome =
  | { ok: true; application: BetaApplication }
  | { ok: false; reason: "unavailable" };

/**
 * Submit a Founding Tester application, or return the EXISTING one
 * unchanged if this player already has a row — see migration 0015's own
 * doc for why "duplicate application" means "return current status," never
 * a second row. ON CONFLICT DO NOTHING + a follow-up read is the same
 * two-step idempotent-insert idiom lib/entitlements.ts's grantComplimentary
 * already uses for its own at-most-once grant_key.
 */
export async function submitApplication(
  playerId: string,
  note: string | null
): Promise<SubmitApplicationOutcome> {
  try {
    const sql = requireSql();
    await sql`
      INSERT INTO beta.applications (player_id, note)
      VALUES (${playerId}, ${note})
      ON CONFLICT (player_id) DO NOTHING
    `;
    const rows = await sql`
      SELECT application_id, player_id, status, note, submitted_at,
             reviewed_at, reviewed_by, rejection_reason
        FROM beta.applications
       WHERE player_id = ${playerId}
    `;
    if (rows.length === 0) return { ok: false, reason: "unavailable" };
    return { ok: true, application: toApplication(rows[0]!) };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] beta application submit failed for ${playerId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}

/** The review queue: every pending application, oldest first (first-applied, first-reviewed). ADMIN ONLY — enforced by the caller, not here. */
export async function listPendingApplications(): Promise<BetaApplication[]> {
  try {
    const sql = requireSql();
    const rows = await sql`
      SELECT application_id, player_id, status, note, submitted_at,
             reviewed_at, reviewed_by, rejection_reason
        FROM beta.applications
       WHERE status = 'pending'
       ORDER BY submitted_at ASC
    `;
    return rows.map(toApplication);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] beta pending-application list failed:", err);
    return [];
  }
}

export type ReviewOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "already_reviewed" | "self_review" | "unavailable" };

/**
 * Approve or reject one application.
 *
 * SELF-REVIEW IS REFUSED HERE, UNCONDITIONALLY — not merely by the caller
 * being an admin. An admin who also happens to hold a pending application
 * of their own must not be able to approve (or reject) it: the check
 * compares the application's OWN player_id against the reviewer's, with no
 * exception for admin status, because admin status is exactly the
 * privilege being checked for misuse here.
 *
 * ATOMIC AND ONE-SHOT: the UPDATE's own WHERE clause requires
 * status = 'pending', so two concurrent reviews (or a retried request) can
 * both run this function but only the first can actually change a row —
 * the second correctly reports already_reviewed rather than silently
 * double-applying a decision.
 */
export async function reviewApplication(
  applicationId: number,
  reviewerPlayerId: string,
  decision: "approved" | "rejected",
  rejectionReason: string | null
): Promise<ReviewOutcome> {
  try {
    const sql = requireSql();
    const existing = await sql`
      SELECT player_id, status FROM beta.applications WHERE application_id = ${applicationId}
    `;
    if (existing.length === 0) return { ok: false, reason: "not_found" };
    const row = existing[0]!;
    if (String(row.player_id) === reviewerPlayerId) return { ok: false, reason: "self_review" };
    if (String(row.status) !== "pending") return { ok: false, reason: "already_reviewed" };

    const updated = await sql`
      UPDATE beta.applications
         SET status = ${decision}, reviewed_at = now(), reviewed_by = ${reviewerPlayerId},
             rejection_reason = ${decision === "rejected" ? rejectionReason : null}
       WHERE application_id = ${applicationId} AND status = 'pending'
      RETURNING application_id
    `;
    if (updated.length === 0) return { ok: false, reason: "already_reviewed" };
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] beta application review failed for ${applicationId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Community profile — Founding Testers only. Append-only moderation, per
// migration 0015's own doc: the public read is "the most recent APPROVED
// row," never "the most recent row."
// ---------------------------------------------------------------------------

export type ProfileRevisionStatus = "pending" | "approved" | "rejected";

export interface ProfileRevision {
  revision_id: number;
  player_id: string;
  headline: string | null;
  bio: string | null;
  status: ProfileRevisionStatus;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

function toRevision(row: Record<string, unknown>): ProfileRevision {
  return {
    revision_id: Number(row.revision_id),
    player_id: String(row.player_id),
    headline: typeof row.headline === "string" ? row.headline : null,
    bio: typeof row.bio === "string" ? row.bio : null,
    status: row.status as ProfileRevisionStatus,
    submitted_at:
      row.submitted_at instanceof Date ? row.submitted_at.toISOString() : String(row.submitted_at),
    reviewed_at:
      row.reviewed_at instanceof Date
        ? row.reviewed_at.toISOString()
        : typeof row.reviewed_at === "string"
          ? row.reviewed_at
          : null,
    reviewed_by: typeof row.reviewed_by === "string" ? row.reviewed_by : null,
  };
}

/** The CURRENTLY PUBLIC profile: the most recent APPROVED revision, or null if none was ever approved. */
export async function getPublicProfile(playerId: string): Promise<ProfileRevision | null> {
  try {
    const sql = requireSql();
    const rows = await sql`
      SELECT revision_id, player_id, headline, bio, status, submitted_at, reviewed_at, reviewed_by
        FROM beta.profile_revisions
       WHERE player_id = ${playerId} AND status = 'approved'
       ORDER BY submitted_at DESC
       LIMIT 1
    `;
    return rows.length > 0 ? toRevision(rows[0]!) : null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] beta public profile read failed for ${playerId}:`, err);
    return null;
  }
}

/** This player's own most recent revision, whatever its status — for their own "awaiting review" view. */
export async function getLatestOwnRevision(playerId: string): Promise<ProfileRevision | null> {
  try {
    const sql = requireSql();
    const rows = await sql`
      SELECT revision_id, player_id, headline, bio, status, submitted_at, reviewed_at, reviewed_by
        FROM beta.profile_revisions
       WHERE player_id = ${playerId}
       ORDER BY submitted_at DESC
       LIMIT 1
    `;
    return rows.length > 0 ? toRevision(rows[0]!) : null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] beta own-revision read failed for ${playerId}:`, err);
    return null;
  }
}

export type SubmitRevisionOutcome =
  | { ok: true; revision: ProfileRevision }
  | { ok: false; reason: "unavailable" };

/**
 * Submit a new profile revision. ALWAYS INSERTS A NEW ROW — never updates
 * one in place, matching the append-only design: the previously approved
 * row (if any) remains exactly as it was, still the public answer, until
 * this new row is itself approved.
 */
export async function submitProfileRevision(
  playerId: string,
  headline: string | null,
  bio: string | null
): Promise<SubmitRevisionOutcome> {
  try {
    const sql = requireSql();
    const rows = await sql`
      INSERT INTO beta.profile_revisions (player_id, headline, bio)
      VALUES (${playerId}, ${headline}, ${bio})
      RETURNING revision_id, player_id, headline, bio, status, submitted_at, reviewed_at, reviewed_by
    `;
    if (rows.length === 0) return { ok: false, reason: "unavailable" };
    return { ok: true, revision: toRevision(rows[0]!) };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] beta profile revision submit failed for ${playerId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}

export async function listPendingProfileRevisions(): Promise<ProfileRevision[]> {
  try {
    const sql = requireSql();
    const rows = await sql`
      SELECT revision_id, player_id, headline, bio, status, submitted_at, reviewed_at, reviewed_by
        FROM beta.profile_revisions
       WHERE status = 'pending'
       ORDER BY submitted_at ASC
    `;
    return rows.map(toRevision);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] beta pending-revision list failed:", err);
    return [];
  }
}

/** Same self-review and atomicity guarantees as reviewApplication — see its own doc. */
export async function reviewProfileRevision(
  revisionId: number,
  reviewerPlayerId: string,
  decision: "approved" | "rejected"
): Promise<ReviewOutcome> {
  try {
    const sql = requireSql();
    const existing = await sql`
      SELECT player_id, status FROM beta.profile_revisions WHERE revision_id = ${revisionId}
    `;
    if (existing.length === 0) return { ok: false, reason: "not_found" };
    const row = existing[0]!;
    if (String(row.player_id) === reviewerPlayerId) return { ok: false, reason: "self_review" };
    if (String(row.status) !== "pending") return { ok: false, reason: "already_reviewed" };

    const updated = await sql`
      UPDATE beta.profile_revisions
         SET status = ${decision}, reviewed_at = now(), reviewed_by = ${reviewerPlayerId}
       WHERE revision_id = ${revisionId} AND status = 'pending'
      RETURNING revision_id
    `;
    if (updated.length === 0) return { ok: false, reason: "already_reviewed" };
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] beta profile revision review failed for ${revisionId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}
