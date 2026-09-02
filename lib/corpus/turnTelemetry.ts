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
// null/[]/void, exactly like recordGameState's own disabled path).
//
// REVIEW FIX — A HUNG QUERY, NOT ONLY A REJECTED ONE. The original version
// only guarded against a rejected promise; a promise that never settles at
// all (a stalled Neon connection) would have stalled the awaited caller
// until Vercel killed the whole function. withTelemetryTimeout races every
// query against a small local ceiling and resolves with a safe fallback if
// the ceiling wins, WITHOUT cancelling the underlying query — it may still
// complete later, but nothing here waits for that. See its own doc for the
// one accepted, documented trade-off this creates.
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
 * ACCEPTED, DOCUMENTED TRADE-OFF: if a `recordOperationStarted` insert wins
 * the race late (after the timeout already returned null) but the insert
 * itself SUCCEEDS moments later, the caller never learns that row's id and
 * so can never complete it — a genuine but rare orphaned `started` row,
 * indistinguishable from a real killed attempt until an operator
 * cross-checks corpus.turn_operations against corpus.game_turns for that
 * game/turn. This is the accepted cost of a timeout existing at all: making
 * it impossible would require a two-phase design (reserve an id
 * synchronously, insert asynchronously) that is a larger observability
 * system than S2 is scoped to build.
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
 * Insert a durable `started` row BEFORE the work it describes begins.
 *
 * Returns the new operation_id, or null if corpus is unconfigured, the
 * insert itself failed, or it did not complete within TELEMETRY_TIMEOUT_CONFIG.timeoutMs —
 * all three are silently tolerated by every caller. A null return is not an
 * error the caller must react to; it simply means this attempt will not have
 * a completion record (rare, and never worse than the pre-S2 state of
 * recording nothing at all).
 */
export async function recordOperationStarted(input: StartOperationInput): Promise<string | null> {
  if (!isCorpusConfigured()) return null;
  const sql = getSql();
  if (!sql) return null;

  const insert = (async () => {
    const rows = await sql`
      INSERT INTO corpus.turn_operations
        (game_id, turn_index, operation_kind, attempt_number, provider, model_id, status)
      VALUES (${input.gameId}, ${input.turnIndex}, ${input.operationKind}, ${input.attemptNumber}, ${input.provider}, ${input.modelId}, 'started')
      RETURNING operation_id
    `;
    const id = rows[0]?.operation_id;
    return typeof id === "string" ? id : null;
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(
      "[barkoba] turn-operation telemetry insert failed (fail-open, gameplay unaffected):",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  });

  return withTelemetryTimeout(insert, null);
}

export interface CompleteOperationInput {
  operationId: string;
  status: OperationStatus;
  latencyMs: number | null;
  /** A short classification only (e.g. "self_timeout"), never a raw error message or stack. */
  errorClass: string | null;
  /**
   * S2 review fix — the RESOLVED model id, when this completion is the point
   * that first learns it (a successful provider_attempt). Omitted (or null)
   * on every other completion — including provider_error/self_timeout, so a
   * failed attempt's row keeps the REQUESTED model id it was inserted with —
   * and on corpus_write, which never carries a model at all. The SQL below
   * only overwrites model_id when a value is actually given
   * (COALESCE(new, existing)), so omitting this field is a true no-op on
   * that column, never a silent NULL-out.
   */
  modelId?: string | null;
}

/** Update a previously-started row with its terminal outcome. Fail-open, and time-bounded. */
export async function recordOperationCompleted(input: CompleteOperationInput): Promise<void> {
  if (!isCorpusConfigured()) return;
  const sql = getSql();
  if (!sql) return;

  const update = (async () => {
    await sql`
      UPDATE corpus.turn_operations
      SET completed_at = now(),
          status = ${input.status},
          latency_ms = ${input.latencyMs},
          error_class = ${input.errorClass},
          model_id = COALESCE(${input.modelId ?? null}, model_id)
      WHERE operation_id = ${input.operationId}
    `;
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(
      "[barkoba] turn-operation telemetry update failed (fail-open, gameplay unaffected):",
      err instanceof Error ? err.message : String(err)
    );
  });

  await withTelemetryTimeout(update, undefined);
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
