import type { ModelCallUsage } from "./providers/types";
import type { OperationKind } from "./corpus/turnTelemetry";

// ---------------------------------------------------------------------------
// V2.8.7 — per-game AI cost accounting.
//
// PURE. No network, no database, no environment: this module prices token
// usage that lib/corpus/turnTelemetry.ts already recorded, against a DATED
// price list transcribed from the providers' official pricing pages. It is
// the arithmetic behind scripts/reportAiCost.ts and nothing else reads it.
//
// THREE RULES, ALL DELIBERATE:
//
//   1. NO INVENTED AVERAGES. There is no "typical game costs X" constant
//      anywhere. A per-game figure exists only once that game's calls have
//      been measured, and the report shows completed and abandoned games
//      separately because their call counts differ by construction.
//
//   2. UNKNOWN IS NOT ZERO. A call whose provider reported no usage (or
//      whose model has no price below) is counted as UNPRICED — surfaced in
//      the report as such — never silently added as $0.00.
//
//   3. NO DOUBLE COUNTING. Every billable call is one row in
//      corpus.turn_operations, including rejected duplicates, timeouts that
//      may still have been billed, and refusals. Reasoning tokens are a share
//      of output_tokens on every provider Barkóba uses and are never added a
//      second time.
//
// PRICES ARE OBSERVATIONS, NOT PROMISES. Each entry records where and when the
// figure was read. When a provider changes its list price, add a new entry
// with a new observed_on date rather than editing the old one, so historical
// reports can be re-run against the price that applied at the time.
// ---------------------------------------------------------------------------

export interface ModelPrice {
  provider: string;
  /** Matched as a prefix of the recorded model id, so dated snapshots (e.g. claude-haiku-4-5-20251001) resolve. */
  model_prefix: string;
  /** USD per 1M uncached input tokens. */
  input_usd_per_m: number;
  /** USD per 1M cached (cache-read) input tokens. */
  cached_input_usd_per_m: number;
  /** USD per 1M cache-write input tokens; null where the provider has no such line item. */
  cache_write_usd_per_m: number | null;
  /** USD per 1M output tokens (reasoning included where the provider bills it as output). */
  output_usd_per_m: number;
  /** ISO date the figures were read from the source. */
  observed_on: string;
  source: string;
}

/**
 * Standard-tier list prices. Long-context, batch, and "fast mode" tiers are
 * NOT modelled: Barkóba's calls are short synchronous requests and the report
 * would misprice them by applying any other tier.
 */
export const AI_PRICE_LIST: readonly ModelPrice[] = [
  {
    provider: "openai",
    model_prefix: "gpt-6-astra",
    input_usd_per_m: 10,
    cached_input_usd_per_m: 1,
    cache_write_usd_per_m: null,
    output_usd_per_m: 50,
    observed_on: "2026-09-05",
    source: "https://developers.openai.com/api/docs/pricing (standard tier; page carries no effective date)",
  },
  {
    provider: "anthropic",
    model_prefix: "claude-fable-5-1",
    input_usd_per_m: 10,
    cached_input_usd_per_m: 0.25,
    cache_write_usd_per_m: 12.5,
    output_usd_per_m: 50,
    observed_on: "2026-06-24",
    source: "Anthropic model table (cached 2026-06-24) — Fable 5.1 cache reads at $0.25/MTok; cache writes at the standard 1.25x input rate",
  },
  {
    provider: "anthropic",
    model_prefix: "claude-sonnet-5",
    input_usd_per_m: 2,
    cached_input_usd_per_m: 0.2,
    cache_write_usd_per_m: 2.5,
    output_usd_per_m: 10,
    observed_on: "2026-06-24",
    source: "Anthropic model table (cached 2026-06-24); cache read 0.1x, cache write 1.25x of input",
  },
  {
    provider: "anthropic",
    model_prefix: "claude-haiku-4-5",
    input_usd_per_m: 1,
    cached_input_usd_per_m: 0.1,
    cache_write_usd_per_m: 1.25,
    output_usd_per_m: 5,
    observed_on: "2026-06-24",
    source: "Anthropic model table (cached 2026-06-24); cache read 0.1x, cache write 1.25x of input",
  },
];

/** The price entry for a recorded call, or null when the model is unpriced. */
export function priceFor(provider: string, modelId: string | null): ModelPrice | null {
  if (!modelId) return null;
  // Longest matching prefix wins, so a more specific entry can override a
  // family-wide one if one is ever added.
  let best: ModelPrice | null = null;
  for (const entry of AI_PRICE_LIST) {
    if (entry.provider !== provider) continue;
    if (!modelId.startsWith(entry.model_prefix)) continue;
    if (!best || entry.model_prefix.length > best.model_prefix.length) best = entry;
  }
  return best;
}

/**
 * Price one call. Returns null — UNKNOWN — when the model is unpriced or the
 * provider did not report input or output tokens. A null cached/cache-write
 * figure is treated as zero ONLY because both providers report those fields
 * whenever they are non-zero (OpenAI has no cache-write concept at all); the
 * two figures that carry the bulk of the cost are never assumed.
 */
export function estimateCallCostUsd(
  provider: string,
  modelId: string | null,
  usage: ModelCallUsage | null
): number | null {
  const price = priceFor(provider, modelId);
  if (!price || !usage) return null;
  if (usage.input_tokens === null || usage.output_tokens === null) return null;

  const cached = usage.cached_input_tokens ?? 0;
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  const perToken = (usdPerM: number) => usdPerM / 1_000_000;

  return (
    usage.input_tokens * perToken(price.input_usd_per_m) +
    cached * perToken(price.cached_input_usd_per_m) +
    cacheWrite * perToken(price.cache_write_usd_per_m ?? 0) +
    usage.output_tokens * perToken(price.output_usd_per_m)
  );
}

/** The three reported cost buckets. */
export type CostSeat = "racer" | "adjudication" | "other";

/** Which bucket an operation kind bills to; null for rows that are not model calls. */
export function seatForOperationKind(kind: OperationKind | string): CostSeat | null {
  switch (kind) {
    case "provider_attempt":
    case "racer_guess_intent":
      return "racer";
    case "adjudicator":
    case "integrity_review":
      return "adjudication";
    case "validator":
    case "composer_choice":
    case "composer_answer":
    case "composer_clue":
    case "question_edit":
      return "other";
    default:
      return null;
  }
}

/** One corpus.turn_operations row, as the report reads it. */
export interface OperationCostRow {
  game_id: string;
  operation_kind: string;
  provider: string | null;
  model_id: string | null;
  status: string;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
}

export interface SeatCost {
  calls: number;
  priced_calls: number;
  /** Calls whose provider reported no usable usage. Not free — unknown. */
  unknown_usage_calls: number;
  /** Calls with usage but no price entry for their model. Not free — unpriced. */
  unpriced_model_calls: number;
  usd: number;
}

export interface GameCostReport {
  game_id: string;
  /** corpus.games.lifecycle_state, or "unknown" when the game has no corpus row yet. */
  lifecycle_state: string;
  completed: boolean;
  racer: SeatCost;
  adjudication: SeatCost;
  other: SeatCost;
  total: SeatCost;
  /** True when every call in every seat was priced — the only case the total is a full figure. */
  fully_priced: boolean;
}

function emptySeat(): SeatCost {
  return { calls: 0, priced_calls: 0, unknown_usage_calls: 0, unpriced_model_calls: 0, usd: 0 };
}

function addToSeat(seat: SeatCost, row: OperationCostRow): void {
  seat.calls += 1;
  const usage: ModelCallUsage = {
    input_tokens: row.input_tokens,
    cached_input_tokens: row.cached_input_tokens,
    cache_write_input_tokens: row.cache_write_input_tokens,
    output_tokens: row.output_tokens,
    reasoning_tokens: row.reasoning_tokens,
  };
  const hasUsage = usage.input_tokens !== null && usage.output_tokens !== null;
  if (!hasUsage) {
    seat.unknown_usage_calls += 1;
    return;
  }
  const cost = estimateCallCostUsd(row.provider ?? "", row.model_id, usage);
  if (cost === null) {
    seat.unpriced_model_calls += 1;
    return;
  }
  seat.priced_calls += 1;
  seat.usd += cost;
}

/**
 * Group recorded calls by game and seat. `lifecycleByGame` comes from
 * corpus.games; a game with rows here but no corpus row yet (its first answer
 * has not landed) reports lifecycle "unknown" and is never counted as
 * completed.
 */
export function summarizeGameCosts(
  rows: readonly OperationCostRow[],
  lifecycleByGame: ReadonlyMap<string, string>
): GameCostReport[] {
  const byGame = new Map<string, GameCostReport>();

  for (const row of rows) {
    const seat = seatForOperationKind(row.operation_kind);
    if (!seat) continue;
    let report = byGame.get(row.game_id);
    if (!report) {
      const lifecycle = lifecycleByGame.get(row.game_id) ?? "unknown";
      report = {
        game_id: row.game_id,
        lifecycle_state: lifecycle,
        completed: lifecycle === "completed",
        racer: emptySeat(),
        adjudication: emptySeat(),
        other: emptySeat(),
        total: emptySeat(),
        fully_priced: true,
      };
      byGame.set(row.game_id, report);
    }
    addToSeat(report[seat], row);
    addToSeat(report.total, row);
  }

  for (const report of byGame.values()) {
    report.fully_priced = report.total.calls > 0 && report.total.priced_calls === report.total.calls;
  }

  return Array.from(byGame.values());
}

export interface CohortSummary {
  games: number;
  fully_priced_games: number;
  /** Sum over fully priced games only; games with any unpriced call are excluded rather than understated. */
  total_usd_fully_priced: number;
  racer_usd_fully_priced: number;
  adjudication_usd_fully_priced: number;
  other_usd_fully_priced: number;
  /** Mean per fully priced game; null until at least one such game exists. */
  mean_total_usd: number | null;
}

/** Aggregate a cohort (e.g. completed games) without inventing a figure for games that cannot be priced. */
export function summarizeCohort(reports: readonly GameCostReport[]): CohortSummary {
  const priced = reports.filter((r) => r.fully_priced);
  const sum = (pick: (r: GameCostReport) => number) => priced.reduce((acc, r) => acc + pick(r), 0);
  const total = sum((r) => r.total.usd);
  return {
    games: reports.length,
    fully_priced_games: priced.length,
    total_usd_fully_priced: total,
    racer_usd_fully_priced: sum((r) => r.racer.usd),
    adjudication_usd_fully_priced: sum((r) => r.adjudication.usd),
    other_usd_fully_priced: sum((r) => r.other.usd),
    mean_total_usd: priced.length > 0 ? total / priced.length : null,
  };
}
