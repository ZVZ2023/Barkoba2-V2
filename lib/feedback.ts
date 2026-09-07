import { getSql, isCorpusConfigured, type SqlClient } from "./corpus/db";

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 — player feedback.
//
// AVAILABLE TO EVERY PLAYER, UNCONDITIONALLY. No account, no verification,
// no Founding Tester approval — see this module's own tests for why. This
// is deliberately NOT gated by BETA_COMMUNITY_ENABLED (lib/env.ts's own doc
// on that flag says so explicitly): feedback is not a "beta/community entry
// point", it is a standing product channel.
//
// STORES THE LEAST POSSIBLE GAME CONTEXT. operational_game_id is an opaque
// reference — the SAME safe-to-store id lib/entitlements.ts already keys
// consumption rows on — never the target, the transcript, or any other game
// content. A reviewer who needs more must go through the EXISTING,
// already-authorized channels (getArchivedGameForOwner, the live record) to
// resolve it; this table is not a second way to read a game's secret.
// ---------------------------------------------------------------------------

export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;
export const FEEDBACK_CATEGORY_MAX_LENGTH = 40;

const GAME_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubmitFeedbackInput {
  playerId: string | null;
  message: string;
  category?: string | null;
  operationalGameId?: string | null;
  /** "hu" or "en"; anything else (including absent) is stored as null. */
  lang?: string | null;
}

export type SubmitFeedbackOutcome =
  | { ok: true }
  | { ok: false; reason: "empty" | "too_long" | "unavailable" };

/** NEVER THROWS, matching every other player-facing write in this codebase. */
export async function submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackOutcome> {
  const message = input.message.trim();
  if (message.length === 0) return { ok: false, reason: "empty" };
  if (message.length > FEEDBACK_MESSAGE_MAX_LENGTH) return { ok: false, reason: "too_long" };

  const category =
    typeof input.category === "string" && input.category.trim().length > 0
      ? input.category.trim().slice(0, FEEDBACK_CATEGORY_MAX_LENGTH)
      : null;

  const language = input.lang === "hu" || input.lang === "en" ? input.lang : null;

  // A malformed game id is silently dropped, not refused — the reference is
  // a courtesy the caller offered, not a claim the server must validate
  // ownership of (see this module's own header on why the id alone is safe
  // to store either way).
  const operationalGameId =
    typeof input.operationalGameId === "string" && GAME_ID_SHAPE.test(input.operationalGameId)
      ? input.operationalGameId
      : null;

  if (!isCorpusConfigured()) return { ok: false, reason: "unavailable" };

  try {
    const sql = requireSql();
    await sql`
      INSERT INTO feedback.submissions (player_id, operational_game_id, category, language, message)
      VALUES (${input.playerId}, ${operationalGameId}::uuid, ${category}, ${language}, ${message})
    `;
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] feedback submission failed:", err);
    return { ok: false, reason: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 COMPLETION — admin retrieval.
//
// READ-ONLY, ADMIN-GATED BY THE CALLER (app/api/feedback/admin/route.ts),
// NOT HERE — mirrors listPendingApplications()'s own "ADMIN ONLY — enforced
// by the caller" contract in lib/betaCommunity.ts. This module has no
// concept of who is asking.
//
// A CONSERVATIVE, FIXED SERVER-SIDE LIMIT, deliberately capped — see
// FEEDBACK_ADMIN_PAGE_SIZE.
//
// STABLE KEYSET PAGINATION ON (created_at, submission_id), NOT created_at
// ALONE. created_at is not a unique ordering key — two submissions in the
// same millisecond would let a created_at-only cursor skip or repeat a row
// depending on which one happened to land on a page boundary. The row-value
// comparison `(created_at, submission_id) < (cursor_created_at,
// cursor_submission_id)` with `ORDER BY created_at DESC, submission_id DESC`
// is a standard, correct keyset boundary: submission_id (bigserial, strictly
// increasing, assigned once at insert) is the tiebreaker that makes the
// ordering — and therefore the boundary — deterministic even when
// created_at collides.
//
// submission_id ITSELF NEVER LEAVES THIS MODULE AS A SEPARATE FIELD. It is
// used only to build the OPAQUE `next_cursor` token (encodeCursor), which
// round-trips through the client as a meaningless string — never returned
// or accepted as a bare, independently queryable id.
// ---------------------------------------------------------------------------

export const FEEDBACK_ADMIN_PAGE_SIZE = 50;

export interface FeedbackListItem {
  created_at: string;
  language: "hu" | "en" | null;
  message: string;
  operational_game_id: string | null;
}

export interface FeedbackListResult {
  items: FeedbackListItem[];
  /** Opaque. Pass back verbatim to fetch the next page; null means there is none. */
  next_cursor: string | null;
}

export type ListFeedbackOutcome =
  | { ok: true; result: FeedbackListResult }
  | { ok: false; reason: "unavailable" | "invalid_cursor" };

interface FeedbackCursor {
  createdAt: string;
  submissionId: number;
}

/**
 * Opaque on purpose: a client must never be able to construct or interpret
 * one, only receive it from a prior page and echo it back. Not a security
 * boundary (there is nothing secret in a submission's own timestamp/id) —
 * this exists solely so the response shape never carries a bare, reusable
 * submission_id field.
 */
function encodeCursor(cursor: FeedbackCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.submissionId}`, "utf8").toString("base64url");
}

/** Returns null for anything that does not decode to a well-formed cursor — never throws. */
function decodeCursor(token: string): FeedbackCursor | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep <= 0) return null;
    const createdAt = decoded.slice(0, sep);
    const idPart = decoded.slice(sep + 1);
    if (Number.isNaN(Date.parse(createdAt))) return null;
    if (!/^\d+$/.test(idPart)) return null;
    const submissionId = Number(idPart);
    if (!Number.isSafeInteger(submissionId)) return null;
    return { createdAt, submissionId };
  } catch {
    return null;
  }
}

/**
 * Newest first, stably. `cursorToken` (opaque; from a previous page's
 * `next_cursor`) narrows to strictly older rows by the composite
 * (created_at, submission_id) ordering. A malformed token is REJECTED
 * (reason: "invalid_cursor") rather than silently treated as "no cursor" —
 * failing safely without ever describing the expected internal shape.
 */
export async function listRecentFeedback(cursorToken?: string | null): Promise<ListFeedbackOutcome> {
  if (!isCorpusConfigured()) return { ok: false, reason: "unavailable" };

  let cursor: FeedbackCursor | null = null;
  if (typeof cursorToken === "string" && cursorToken.length > 0) {
    cursor = decodeCursor(cursorToken);
    if (!cursor) return { ok: false, reason: "invalid_cursor" };
  }

  try {
    const sql = requireSql();
    // One extra row fetched to know whether a further page exists, without
    // a separate COUNT query.
    const rows = cursor
      ? await sql`
          SELECT submission_id, operational_game_id, language, message, created_at
            FROM feedback.submissions
           WHERE (created_at, submission_id) < (${cursor.createdAt}::timestamptz, ${cursor.submissionId}::bigint)
           ORDER BY created_at DESC, submission_id DESC
           LIMIT ${FEEDBACK_ADMIN_PAGE_SIZE + 1}
        `
      : await sql`
          SELECT submission_id, operational_game_id, language, message, created_at
            FROM feedback.submissions
           ORDER BY created_at DESC, submission_id DESC
           LIMIT ${FEEDBACK_ADMIN_PAGE_SIZE + 1}
        `;

    const hasMore = rows.length > FEEDBACK_ADMIN_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, FEEDBACK_ADMIN_PAGE_SIZE) : rows;
    const lastRow = page[page.length - 1];

    return {
      ok: true,
      result: {
        next_cursor:
          hasMore && lastRow
            ? encodeCursor({
                createdAt:
                  lastRow.created_at instanceof Date ? lastRow.created_at.toISOString() : String(lastRow.created_at),
                submissionId: Number(lastRow.submission_id),
              })
            : null,
        items: page.map((row) => ({
          created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
          language: row.language === "hu" || row.language === "en" ? row.language : null,
          message: String(row.message),
          operational_game_id: typeof row.operational_game_id === "string" ? row.operational_game_id : null,
        })),
      },
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] feedback admin listing failed:", err);
    return { ok: false, reason: "unavailable" };
  }
}

function requireSql(): SqlClient {
  const sql = getSql();
  if (!sql) throw new Error("feedback: no database client");
  return sql;
}
