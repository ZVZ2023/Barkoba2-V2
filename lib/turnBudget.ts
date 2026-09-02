// ---------------------------------------------------------------------------
// S2 / RB-2 — the shared provider-time budget for one /turn invocation.
//
// Pure, no I/O, no Date.now() baked in — the same reason lib/turnRecovery.ts
// and lib/duplicateQuestionGuard.ts are pure: this IS the arithmetic that
// decides whether a provider attempt may start and for how long, so it is
// unit-tested directly with fabricated timestamps rather than by sleeping for
// real 45-300 second intervals.
//
// ---------------------------------------------------------------------------
// THE DESIGN THIS REPLACES
// ---------------------------------------------------------------------------
//
// Before S2, `TURN_LOCK_TTL_SECONDS = maxDuration` (both 60) and nothing
// bounded an individual provider call at all. The read-only S2 discovery
// passes found: (1) Vercel's actual Hobby-plan ceiling is 300s, not 60 --
// self-imposed headroom existed and was unused; (2) no AbortSignal reached
// either provider adapter; (3) MAX_DUPLICATE_QUESTION_ATTEMPTS=3 means up to
// three sequential provider calls can occur in ONE invocation, so a flat
// per-attempt deadline of ~150s could sum to 450s -- incoherent against any
// sane maxDuration. This module is the fix for exactly that tension: ONE
// absolute, shared deadline for the whole invocation's provider time, with
// each attempt drawing down from whatever is left.
//
// ---------------------------------------------------------------------------
// A LOCAL DEADLINE ONLY. Aborting Barkóba's own fetch stops BARKÓBA from
// waiting. It does not, and cannot be claimed to, cancel the remote
// provider's inference or its billing -- xAI documents no cancellation
// endpoint, and whether an aborted connection halts server-side work is
// unconfirmed by either provider's public documentation as of this session.
// ---------------------------------------------------------------------------

/** Provisional, fixed for S2 -- not environment-configurable (see route.ts). */
export interface TurnBudgetConfig {
  /** Absolute ceiling on TOTAL provider time across every attempt in one invocation. */
  sharedDeadlineMs: number;
  /** The most any single attempt may be given, even with budget to spare. */
  perAttemptMaxMs: number;
  /** Below this much remaining shared budget, no new attempt may start. */
  minRemainingToStartMs: number;
}

export const TURN_BUDGET_CONFIG: TurnBudgetConfig = {
  sharedDeadlineMs: 240_000, // 240s
  perAttemptMaxMs: 150_000, // 150s
  minRemainingToStartMs: 45_000, // 45s
};

export interface AttemptBudgetDecision {
  /** May a new provider attempt start at all? */
  allowed: boolean;
  /**
   * The allowance to enforce locally for this attempt, in ms.
   * 0 when `allowed` is false -- there is nothing to enforce because nothing
   * may start.
   */
  allowanceMs: number;
  /** Time remaining against the shared deadline at the moment of this decision. */
  remainingMs: number;
}

/**
 * Decide whether another provider attempt may start, and for how long, given
 * a single ABSOLUTE deadline for the whole invocation (`providerDeadlineAt`,
 * an epoch-ms timestamp fixed once at route entry) and the current time.
 *
 * Using an absolute deadline rather than a per-attempt duration is what makes
 * "the shared deadline includes time already consumed by earlier attempts
 * and intervening work" true BY CONSTRUCTION: `now` reflects real elapsed
 * wall-clock time regardless of what consumed it (a slow attempt, a
 * duplicate check, a CAS save), so no separate bookkeeping of "time spent so
 * far" is needed.
 */
export function decideAttemptBudget(
  providerDeadlineAt: number,
  now: number,
  config: TurnBudgetConfig = TURN_BUDGET_CONFIG
): AttemptBudgetDecision {
  const remainingMs = providerDeadlineAt - now;
  if (remainingMs < config.minRemainingToStartMs) {
    return { allowed: false, allowanceMs: 0, remainingMs };
  }
  return { allowed: true, allowanceMs: Math.min(config.perAttemptMaxMs, remainingMs), remainingMs };
}

/** True when an error is the result of THIS module's own abort, not a provider-side failure. */
export function isLocalTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Run `fn` with an AbortSignal that fires after `allowanceMs` -- Barkóba
 * stops waiting; see the module doc on what this does and does not claim
 * about the remote provider. The timer is ALWAYS cleared, success or
 * failure, so it can never fire after this call has already settled.
 */
export async function runWithAbortTimeout<T>(
  allowanceMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), allowanceMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
