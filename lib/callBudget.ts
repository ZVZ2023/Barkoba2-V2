import { getKV } from "./kv";
import { env } from "./env";

// ---------------------------------------------------------------------------
// GLOBAL daily ceiling on Racer model calls — across all users and all IPs.
//
// This is deliberately NOT the same control as lib/rateLimit.ts. That one is
// per-IP and only guards /api/game/create. It caps a single abuser; it does
// nothing about aggregate organic traffic, and nothing at all about one actor
// spreading requests across many IPs. Per-IP limiting bounds the worst
// individual; only a global counter bounds the bill.
//
// FAILS CLOSED. If the counter cannot be read or incremented — KV down,
// Upstash misconfigured, network partition — the call is DENIED, not allowed
// through. An outage that silently disables the only global spend ceiling is
// exactly the failure this exists to prevent.
//
// Note on precision: the counter is incremented before the ceiling is checked,
// so a denied attempt still consumes a slot. That biases the ceiling toward
// stopping early rather than late, which is the correct direction for a
// spend control. It is not an exact accounting of successful calls.
//
// Scope and why the counters are SEPARATE (M4):
//
//   "racer"   — turn generation + guess-intent resolution. Cheap model, ~20-25
//               calls per game, the unbounded one.
//   "resolve" — Adjudicator + Integrity Review. Strong model, at most 2 calls
//               per completed game and often 1.
//
// A shared counter would let a busy day of cheap Racer turns exhaust the budget
// and block adjudication of games already played to completion — running out of
// money at the worst possible moment, after all the cost has been sunk. Separate
// ceilings mean the two failure modes cannot cause each other.
//
// The Validator call in /api/game/create is still not metered — it is bounded by
// the per-IP game-creation limit. Add consumeModelCall("resolve") there if that
// ever stops being true.
// ---------------------------------------------------------------------------

const COUNTER_TTL_SECONDS = 48 * 60 * 60; // key is date-scoped; TTL just reaps it

export type ModelCallKind = "racer" | "resolve";

export interface CallBudgetResult {
  allowed: boolean;
  used: number;
  ceiling: number;
  /** Set when the denial was caused by an infrastructure failure, not real usage. */
  failedClosed: boolean;
}

function counterKey(kind: ModelCallKind, now: Date): string {
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return `budget:${kind}calls:${day}`;
}

function ceilingFor(kind: ModelCallKind): number {
  return kind === "racer" ? env.racerDailyCallCeiling() : env.resolveDailyCallCeiling();
}

/**
 * Reserve one model call of the given kind against today's global ceiling.
 * Call this immediately BEFORE each model request, and abort the request if
 * `allowed` is false.
 */
export async function consumeModelCall(
  kind: ModelCallKind
): Promise<CallBudgetResult> {
  const ceiling = ceilingFor(kind);

  try {
    const used = await getKV().incrWithExpiry(
      counterKey(kind, new Date()),
      COUNTER_TTL_SECONDS
    );
    return { allowed: used <= ceiling, used, ceiling, failedClosed: false };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[barkoba] ${kind} call budget counter unavailable — failing closed:`,
      err
    );
    return { allowed: false, used: -1, ceiling, failedClosed: true };
  }
}

// ---------------------------------------------------------------------------
// V2.7 — capacity observability. A READ, never a reservation: this must
// never increment the counter it reports on, or observing usage would itself
// consume budget. Same counter, same key, same ceiling as consumeModelCall
// above — deliberately not a second source of truth.
// ---------------------------------------------------------------------------

export interface CallBudgetSnapshot {
  kind: ModelCallKind;
  used: number;
  ceiling: number;
  /** used / ceiling. 0 when the ceiling is misconfigured to 0. -1 on read failure. */
  utilization: number;
}

/** Today's usage against the ceiling, for the given call kind. Never throws. */
export async function peekModelCallUsage(kind: ModelCallKind): Promise<CallBudgetSnapshot> {
  const ceiling = ceilingFor(kind);
  try {
    const used = (await getKV().get<number>(counterKey(kind, new Date()))) ?? 0;
    return { kind, used, ceiling, utilization: ceiling > 0 ? used / ceiling : 0 };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] ${kind} call budget peek failed:`, err);
    return { kind, used: -1, ceiling, utilization: -1 };
  }
}
