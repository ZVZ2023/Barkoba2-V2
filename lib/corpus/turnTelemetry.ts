import { getSql, isCorpusConfigured } from "./db";

// ---------------------------------------------------------------------------
// S2 / RB-2 — durable turn-operation telemetry.
//
// THE SMALLEST DURABLE IMPLEMENTATION, not a general observability system.
// One additive table (migrations/0012_turn_operation_telemetry.sql), no new
// infrastructure: this reuses the exact seam lib/callBudget.ts already relies
// on for a pre-fetch durable write (its own comment: "the counter is
// incremented before the ceiling is checked, so a denied attempt still
// consumes a slot"), and the exact getSql()/isCorpusConfigured() pattern
// lib/corpus/gameCorpus.ts already uses. No KV marker is added alongside
// this — the durable row IS the source for killed-attempt history; see the
// module doc on findPresumedKilledOperations below for why no background job
// or reconciliation pass is needed either.
//
// FAIL-OPEN, ABSOLUTELY. Every function here swallows its own failure and
// logs a structured, non-sensitive line. Telemetry must never prevent a
// provider call, never delay gameplay beyond the write's own await, and
// never become a player-facing error — mirroring lib/corpus/gameCorpus.ts's
// own first rule ("it never throws. A corpus failure must never break a
// game."), and identically inert when corpus is unconfigured (this test
// environment has no DATABASE_URL; every call below is then a no-op returning
// null/[]/void, exactly like recordGameState's own disabled path).
//
// WHAT IS NEVER STORED HERE: secret targets, player answers or explanations,
// prompts, model output, tool-call arguments, credentials, or headers. Only
// operational facts about an attempt — who, when, how long, how it ended.
// ---------------------------------------------------------------------------

export type OperationKind = "provider_attempt" | "corpus_write";

export type OperationStatus =
  | "started"
  | "accepted"
  | "duplicate_rejected"
  | "provider_error"
  | "self_timeout"
  | "presumed_killed"
  | "completed"
  | "error";

export interface StartOperationInput {
  gameId: string;
  /** The turn this operation is producing/persisting, or null when not yet known. */
  turnIndex: number | null;
  operationKind: OperationKind;
  /** 1-based attempt number within the duplicate-guard loop; null for corpus_write. */
  attemptNumber: number | null;
  /** Provider id ("anthropic" | "xai"); null for corpus_write. */
  provider: string | null;
  /** Requested model id; null for corpus_write or when not yet resolved. */
  modelId: string | null;
}

/**
 * Insert a durable `started` row BEFORE the work it describes begins.
 *
 * Returns the new operation_id, or null if corpus is unconfigured or the
 * insert itself failed — both are silently tolerated by every caller. A null
 * return is not an error the caller must react to; it simply means this
 * attempt will not have a completion record (rare, and never worse than the
 * pre-S2 state of recording nothing at all).
 */
export async function recordOperationStarted(input: StartOperationInput): Promise<string | null> {
  if (!isCorpusConfigured()) return null;
  const sql = getSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      INSERT INTO corpus.turn_operations
        (game_id, turn_index, operation_kind, attempt_number, provider, model_id, status)
      VALUES (${input.gameId}, ${input.turnIndex}, ${input.operationKind}, ${input.attemptNumber}, ${input.provider}, ${input.modelId}, 'started')
      RETURNING operation_id
    `;
    const id = rows[0]?.operation_id;
    return typeof id === "string" ? id : null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[barkoba] turn-operation telemetry insert failed (fail-open, gameplay unaffected):",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

export interface CompleteOperationInput {
  operationId: string;
  status: OperationStatus;
  latencyMs: number | null;
  /** A short classification only (e.g. "self_timeout"), never a raw error message or stack. */
  errorClass: string | null;
}

/** Update a previously-started row with its terminal outcome. Fail-open. */
export async function recordOperationCompleted(input: CompleteOperationInput): Promise<void> {
  if (!isCorpusConfigured()) return;
  const sql = getSql();
  if (!sql) return;

  try {
    await sql`
      UPDATE corpus.turn_operations
      SET completed_at = now(), status = ${input.status}, latency_ms = ${input.latencyMs}, error_class = ${input.errorClass}
      WHERE operation_id = ${input.operationId}
    `;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[barkoba] turn-operation telemetry update failed (fail-open, gameplay unaffected):",
      err instanceof Error ? err.message : String(err)
    );
  }
}

export interface PresumedKilledOperation {
  operationId: string;
  gameId: string;
  turnIndex: number | null;
  operationKind: OperationKind;
  startedAt: string;
}

/**
 * Rows still `started` older than `thresholdMs`. PURE QUERY — this never
 * writes `presumed_killed` into the row itself, on purpose: the requirement
 * is that classification must be possible WITHOUT depending on any later
 * request occurring, and a read-only age comparison is the only mechanism
 * that satisfies that unconditionally. If a later request wants to also
 * WRITE the classification for its own bookkeeping, it can do so with
 * recordOperationCompleted(status: "presumed_killed") using an id this
 * function returned — that remains an optional caller decision, not
 * something this module performs on its own (no background job, no
 * reconciliation pass, per S2's explicit smallest-design scope).
 */
export async function findPresumedKilledOperations(
  thresholdMs: number
): Promise<PresumedKilledOperation[]> {
  if (!isCorpusConfigured()) return [];
  const sql = getSql();
  if (!sql) return [];

  try {
    const rows = await sql`
      SELECT operation_id, game_id, turn_index, operation_kind, started_at
      FROM corpus.turn_operations
      WHERE status = 'started'
        AND started_at < (now() - (${thresholdMs}::text || ' milliseconds')::interval)
    `;
    return rows.map((r) => ({
      operationId: String(r.operation_id),
      gameId: String(r.game_id),
      turnIndex: typeof r.turn_index === "number" ? r.turn_index : null,
      operationKind: r.operation_kind as OperationKind,
      startedAt: String(r.started_at),
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[barkoba] presumed-killed telemetry query failed (fail-open, observability only):",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}
