import { randomUUID } from "crypto";
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
// provider call, never delay gameplay beyond TELEMETRY_TIMEOUT_CONFIG.timeoutMs, and never
// become a player-facing error — mirroring lib/corpus/gameCorpus.ts's own
// first rule ("it never throws. A corpus failure must never break a game."),
// and identically inert when corpus is unconfigured (this test environment
// has no DATABASE_URL; every call below is then a no-op returning
// void, exactly like recordGameState's own disabled path).
//
// REVIEW FIX (round 1) — A HUNG QUERY, NOT ONLY A REJECTED ONE. The original
// version only guarded against a rejected promise; a promise that never
// settles at all (a stalled Neon connection) would have stalled the awaited
// caller until Vercel killed the whole function. withTelemetryTimeout races
// every query against a small local ceiling and resolves if the ceiling
// wins, WITHOUT cancelling the underlying query — it may still complete
// later, but nothing here waits for that.
//
// REVIEW FIX (round 2) — THE ORPHANED-ROW PROBLEM, CLOSED, NOT ACCEPTED.
// Round 1 let the database assign operation_id (`RETURNING operation_id`
// from the start INSERT), which meant a start INSERT that raced past
// TELEMETRY_TIMEOUT_CONFIG.timeoutMs but later succeeded produced a row the
// caller could never learn the id of — indistinguishable from a genuinely
// killed attempt, and exactly the false-positive findPresumedKilledOperations
// exists to avoid. The fix: the ID is generated HERE, client-side, with
// randomUUID(), before any INSERT is even attempted, and carried through the
// whole attempt as an OperationHandle. That makes both ends of an attempt's
// life idempotent and order-independent:
//   - the START write is `INSERT ... ON CONFLICT (operation_id) DO NOTHING`
//     — if the terminal write already created this row (see below), a late
//     start INSERT is a silent no-op, never resurrecting a finished row back
//     to 'started'.
//   - the TERMINAL write is `INSERT ... ON CONFLICT (operation_id) DO UPDATE
//     ... WHERE status = 'started'` — a single idempotent upsert that
//     creates the row directly (with its final status) if the start INSERT
//     never landed at all (timed out, failed, or is still in flight), or
//     updates it in place if the start row is already there. The `WHERE
//     status = 'started'` guard is what makes this direction-safe too: once
//     a row is terminal, no later write — including a delayed start INSERT
//     landing after it — can ever move it back to a non-terminal state.
// Net effect: a normal attempt's row is terminal the instant its outcome is
// known, regardless of whether its start INSERT has landed, timed out, or
// failed outright. findPresumedKilledOperations' `status = 'started'` filter
// therefore never matches a completed attempt merely because its start
// response was slow — only a row genuinely never completed stays 'started'.
//
// WHAT IS NEVER STORED HERE: secret targets, player answers or explanations,
// prompts, model output, tool-call arguments, credentials, or headers. Only
// operational facts about an attempt — who, when, how long, how it ended.
// ---------------------------------------------------------------------------

/**
 * Gameplay must never wait longer than this for a telemetry operation.
 * Small and local — not a network-level Neon/AbortSignal timeout (this
 * driver's tagged-template calls do not expose one; see the module doc on
 * why a local race is "an equivalently safe mechanism" for this purpose),
 * just an upper bound on how long ANY caller here will wait.
 *
 * A mutable config object, not a bare constant — matching lib/turnBudget.ts's
 * TURN_BUDGET_CONFIG — so a test can shrink it to prove the timeout actually
 * fires without a real 2-second wait, the same seam already used for the
 * shared provider deadline.
 */
export const TELEMETRY_TIMEOUT_CONFIG = { timeoutMs: 2000 };

/**
 * Race `promise` against a `TELEMETRY_TIMEOUT_CONFIG.timeoutMs` timer. If the timer wins,
 * resolves with `fallback` immediately; the original promise is left to
 * settle on its own and its eventual result (success or rejection) is
 * swallowed here so it can never become an unhandled rejection.
 *
 * No longer creates an orphaned-row risk the way it did in round 1 (see the
 * module doc): whichever of the start/terminal writes lands first wins by
 * construction (ON CONFLICT DO NOTHING / DO UPDATE ... WHERE status =
 * 'started'), so a query racing past this timeout and succeeding later can
 * still only ever produce the SAME correct row a caller already has the id
 * for via its OperationHandle — never a row nobody can reach.
 */
function withTelemetryTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, TELEMETRY_TIMEOUT_CONFIG.timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
        // eslint-disable-next-line no-console
        console.warn(
          "[barkoba] telemetry query failed (fail-open, gameplay unaffected):",
          err instanceof Error ? err.message : String(err)
        );
      }
    );
  });
}

export type OperationKind = "provider_attempt" | "corpus_write";

export type OperationStatus =
  | "started"
  | "accepted"
  | "duplicate_rejected"
  | "provider_error"
  | "self_timeout"
  /**
   * S2 review fix — a provider_attempt abandoned BEFORE the call started
   * because the PER-INVOCATION shared provider-time budget (lib/turnBudget.ts)
   * ran out during the pre-provider work (the daily spend-ceiling check,
   * this very insert). Deliberately NOT named "budget_exhausted" — that
   * string is already the existing CLIENT-FACING error code for the
   * unrelated GLOBAL DAILY racer-call ceiling (lib/callBudget.ts); reusing
   * it here would conflate two different budgets in the durable record.
   * Distinct from `self_timeout` (the provider call itself started and was
   * then aborted) — the recoverable 502 the player sees is identical
   * either way; this status is what makes the two causes distinguishable
   * in telemetry.
   */
  | "shared_budget_exhausted"
  | "presumed_killed"
  // --- corpus_write outcomes, mirroring gameCorpus.ts's own CorpusOutcome
  // literally — see the review fix on recordGameState's return value below.
  | "written"
  | "deferred"
  | "disabled"
  | "below_threshold"
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
  /** The REQUESTED model id at call time; null for corpus_write or when not yet resolved. */
  modelId: string | null;
}

/**
 * Round-2 review fix — everything a terminal write needs to either UPDATE an
 * existing 'started' row or CREATE the terminal row directly (if the start
 * write never landed), carried by the caller across the attempt instead of a
 * bare id. `requestedModelId` is the fallback used only when a terminal
 * write's own `modelId` is omitted AND it turns out to be the one creating
 * the row (start INSERT lost the race entirely) — see recordOperationCompleted.
 *
 * Contains only the same non-sensitive identifying fields StartOperationInput
 * already carried; no new data is captured.
 */
export interface OperationHandle {
  operationId: string;
  gameId: string;
  turnIndex: number | null;
  operationKind: OperationKind;
  attemptNumber: number | null;
  provider: string | null;
  requestedModelId: string | null;
}

/**
 * Generate an operation's id and identifying handle, and best-effort issue
 * its durable `started` row.
 *
 * ALWAYS returns a usable handle — never null. The id is generated
 * client-side (randomUUID()) before any database call, which is what makes
 * this safe to use unconditionally regardless of whether corpus is
 * configured, the insert fails, or it does not complete within
 * TELEMETRY_TIMEOUT_CONFIG.timeoutMs: recordOperationCompleted's idempotent
 * upsert (see its own doc) can always create the terminal row directly from
 * this same handle if the start write never lands. Every caller may now
 * unconditionally call recordOperationCompleted with the returned handle,
 * with no null-check required.
 */
export async function recordOperationStarted(input: StartOperationInput): Promise<OperationHandle> {
  const handle: OperationHandle = {
    operationId: randomUUID(),
    gameId: input.gameId,
    turnIndex: input.turnIndex,
    operationKind: input.operationKind,
    attemptNumber: input.attemptNumber,
    provider: input.provider,
    requestedModelId: input.modelId,
  };

  if (!isCorpusConfigured()) return handle;
  const sql = getSql();
  if (!sql) return handle;

  const insert = (async () => {
    // ON CONFLICT DO NOTHING — the only way this id could already exist is a
    // terminal write that beat this start write to the row (see the module
    // doc); in that case the terminal outcome must never be reverted to
    // 'started'.
    await sql`
      INSERT INTO corpus.turn_operations
        (operation_id, game_id, turn_index, operation_kind, attempt_number, provider, model_id, status)
      VALUES (${handle.operationId}, ${input.gameId}, ${input.turnIndex}, ${input.operationKind}, ${input.attemptNumber}, ${input.provider}, ${input.modelId}, 'started')
      ON CONFLICT (operation_id) DO NOTHING
    `;
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(
      "[barkoba] turn-operation telemetry insert failed (fail-open, gameplay unaffected):",
      err instanceof Error ? err.message : String(err)
    );
  });

  await withTelemetryTimeout(insert, undefined);
  return handle;
}

export interface CompletionOutcome {
  status: OperationStatus;
  latencyMs: number | null;
  /** A short classification only (e.g. "self_timeout"), never a raw error message or stack. */
  errorClass: string | null;
  /**
   * The RESOLVED model id, when this completion is the point that first
   * learns it (a successful provider_attempt). Omitted (or null) on every
   * other completion — including provider_error/self_timeout, so the row
   * keeps the REQUESTED model id (`handle.requestedModelId`) it started
   * with — and on corpus_write, which never carries a model at all.
   */
  modelId?: string | null;
}

/**
 * Idempotently record an operation's terminal outcome, from `handle` alone —
 * no read is required first.
 *
 * Round-2 review fix — a single `INSERT ... ON CONFLICT (operation_id) DO
 * UPDATE ... WHERE status = 'started'` upsert:
 *   - if the start row is already there (the common case), this UPDATEs it
 *     in place;
 *   - if the start write never landed (timed out, failed, or is still in
 *     flight and loses the race), this CREATEs the terminal row directly
 *     from the handle's own identifying fields — nothing is lost merely
 *     because the start write was slow or unlucky;
 *   - if the row is somehow ALREADY terminal (a duplicate completion call,
 *     or a start write landing late after this one), the `WHERE status =
 *     'started'` guard makes the UPDATE branch a no-op — a terminal outcome
 *     can never be overwritten by a second write.
 * model_id uses COALESCE(new, existing) semantics via EXCLUDED so a
 * completion that omits `modelId` never nulls out a value the row already
 * has (or, on the create-directly branch, falls back to the handle's own
 * `requestedModelId`).
 */
export async function recordOperationCompleted(
  handle: OperationHandle,
  outcome: CompletionOutcome
): Promise<void> {
  if (!isCorpusConfigured()) return;
  const sql = getSql();
  if (!sql) return;

  const modelIdForRow = outcome.modelId ?? handle.requestedModelId ?? null;

  const upsert = (async () => {
    await sql`
      INSERT INTO corpus.turn_operations
        (operation_id, game_id, turn_index, operation_kind, attempt_number, provider, model_id, status, latency_ms, error_class, completed_at)
      VALUES (${handle.operationId}, ${handle.gameId}, ${handle.turnIndex}, ${handle.operationKind}, ${handle.attemptNumber}, ${handle.provider}, ${modelIdForRow}, ${outcome.status}, ${outcome.latencyMs}, ${outcome.errorClass}, now())
      ON CONFLICT (operation_id) DO UPDATE SET
        status = EXCLUDED.status,
        latency_ms = EXCLUDED.latency_ms,
        error_class = EXCLUDED.error_class,
        completed_at = EXCLUDED.completed_at,
        model_id = COALESCE(EXCLUDED.model_id, corpus.turn_operations.model_id)
      WHERE corpus.turn_operations.status = 'started'
    `;
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(
      "[barkoba] turn-operation telemetry update failed (fail-open, gameplay unaffected):",
      err instanceof Error ? err.message : String(err)
    );
  });

  await withTelemetryTimeout(upsert, undefined);
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
 * recordOperationCompleted using an OperationHandle reconstructed from an id
 * this function returned — that remains an optional caller decision, not
 * something this module performs on its own (no background job, no
 * reconciliation pass, per S2's explicit smallest-design scope).
 *
 * Round-2 review fix means this filter is now trustworthy: a row can only be
 * `status = 'started'` here if its terminal write has genuinely never
 * happened — a completed attempt's row is always terminal from the moment
 * ITS OWN outcome is known, independent of whether its start write ever
 * landed. See the module doc.
 */
export async function findPresumedKilledOperations(
  thresholdMs: number
): Promise<PresumedKilledOperation[]> {
  if (!isCorpusConfigured()) return [];
  const sql = getSql();
  if (!sql) return [];

  const query = (async () => {
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
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(
      "[barkoba] presumed-killed telemetry query failed (fail-open, observability only):",
      err instanceof Error ? err.message : String(err)
    );
    return [] as PresumedKilledOperation[];
  });

  return withTelemetryTimeout(query, []);
}
