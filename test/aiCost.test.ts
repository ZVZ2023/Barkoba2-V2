import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_PRICE_LIST,
  estimateCallCostUsd,
  priceFor,
  seatForOperationKind,
  summarizeCohort,
  summarizeGameCosts,
  type OperationCostRow,
} from "../lib/aiCost";

// ---------------------------------------------------------------------------
// V2.8.7 — per-game AI cost arithmetic. Pure functions; no database.
// ---------------------------------------------------------------------------

test("every price entry is dated and sourced, and the V2.8.7 models are priced", () => {
  for (const p of AI_PRICE_LIST) {
    assert.match(p.observed_on, /^\d{4}-\d{2}-\d{2}$/, `${p.model_prefix} carries an observation date`);
    assert.ok(p.source.length > 10, `${p.model_prefix} carries a source`);
  }
  assert.ok(priceFor("openai", "gpt-6-astra"));
  assert.ok(priceFor("anthropic", "claude-fable-5-1"));
  assert.ok(priceFor("anthropic", "claude-haiku-4-5-20251001"), "dated snapshots resolve by prefix");
  assert.equal(priceFor("xai", "grok-4.6"), null, "an unverified price is absent, not guessed");
  assert.equal(priceFor("anthropic", "gpt-6-astra"), null, "prices are per provider");
});

test("gpt-6-astra: $10 / $1 cached / $50 per 1M, reasoning billed inside output, no cache-write line", () => {
  const usd = estimateCallCostUsd("openai", "gpt-6-astra", {
    input_tokens: 1_000_000,
    cached_input_tokens: 1_000_000,
    cache_write_input_tokens: null,
    output_tokens: 1_000_000,
    reasoning_tokens: 900_000, // informational — never added again
  });
  assert.equal(usd, 61);
});

test("claude-fable-5-1: $10 / $0.25 cache read / $12.50 cache write / $50 per 1M", () => {
  const usd = estimateCallCostUsd("anthropic", "claude-fable-5-1", {
    input_tokens: 1_000_000,
    cached_input_tokens: 1_000_000,
    cache_write_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    reasoning_tokens: null,
  });
  assert.equal(usd, 72.75);
});

test("UNKNOWN IS NOT ZERO: missing input or output tokens, or an unpriced model, yield null", () => {
  const known = { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_tokens: null };
  assert.ok(estimateCallCostUsd("openai", "gpt-6-astra", known)! > 0);
  assert.equal(estimateCallCostUsd("openai", "gpt-6-astra", { ...known, input_tokens: null }), null);
  assert.equal(estimateCallCostUsd("openai", "gpt-6-astra", { ...known, output_tokens: null }), null);
  assert.equal(estimateCallCostUsd("openai", "gpt-6-astra", null), null);
  assert.equal(estimateCallCostUsd("xai", "grok-4.6", known), null);
});

test("operation kinds map to exactly three seats; corpus writes are not calls", () => {
  assert.equal(seatForOperationKind("provider_attempt"), "racer");
  assert.equal(seatForOperationKind("racer_guess_intent"), "racer");
  assert.equal(seatForOperationKind("adjudicator"), "adjudication");
  assert.equal(seatForOperationKind("integrity_review"), "adjudication");
  for (const k of ["validator", "composer_choice", "composer_answer", "composer_clue", "question_edit"]) {
    assert.equal(seatForOperationKind(k), "other");
  }
  assert.equal(seatForOperationKind("corpus_write"), null);
});

function row(overrides: Partial<OperationCostRow>): OperationCostRow {
  return {
    game_id: "g1",
    operation_kind: "provider_attempt",
    provider: "openai",
    model_id: "gpt-6-astra",
    status: "accepted",
    input_tokens: 10_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: null,
    output_tokens: 1_000,
    reasoning_tokens: 800,
    ...overrides,
  };
}

test("per-game report: seats sum to the total, rejected duplicates and refusals count once, unknown rows are flagged not zeroed", () => {
  const rows: OperationCostRow[] = [
    row({}), // racer attempt: 10k in ($0.10) + 1k out ($0.05) = 0.15
    row({ status: "duplicate_rejected" }), // still billed: 0.15
    row({ operation_kind: "racer_guess_intent", input_tokens: 2_000, output_tokens: 100 }), // 0.02 + 0.005 = 0.025
    row({ operation_kind: "adjudicator", provider: "anthropic", model_id: "claude-fable-5-1", input_tokens: 1_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 100 }), // 0.01 + 0.005 = 0.015
    row({ operation_kind: "integrity_review", provider: "anthropic", model_id: "claude-fable-5-1", status: "refusal", input_tokens: 1_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }), // 0.01
    row({ operation_kind: "composer_answer", provider: "anthropic", model_id: "claude-haiku-4-5-20251001", input_tokens: 1_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 200 }), // 0.001 + 0.001 = 0.002
    row({ operation_kind: "validator", provider: "anthropic", model_id: "claude-sonnet-5", input_tokens: null, output_tokens: null }), // unknown usage
    row({ operation_kind: "corpus_write", provider: null, model_id: null, input_tokens: null, output_tokens: null }), // not a call
  ];
  const [report] = summarizeGameCosts(rows, new Map([["g1", "completed"]]));
  assert.ok(report);
  assert.equal(report!.completed, true);
  assert.equal(report!.racer.calls, 3);
  assert.ok(Math.abs(report!.racer.usd - 0.325) < 1e-9);
  assert.equal(report!.adjudication.calls, 2);
  assert.ok(Math.abs(report!.adjudication.usd - 0.025) < 1e-9);
  assert.equal(report!.other.calls, 2);
  assert.equal(report!.other.unknown_usage_calls, 1);
  assert.ok(Math.abs(report!.other.usd - 0.002) < 1e-9);
  assert.equal(report!.total.calls, 7, "corpus_write is not a model call");
  assert.ok(Math.abs(report!.total.usd - (0.325 + 0.025 + 0.002)) < 1e-9);
  assert.equal(report!.fully_priced, false, "one unknown-usage call means the total is a floor, not a figure");
});

test("cohort summary: completed and abandoned are separate, and only fully priced games contribute a per-game figure", () => {
  const rows: OperationCostRow[] = [
    row({ game_id: "done" }),
    row({ game_id: "quit", input_tokens: 5_000, output_tokens: 500 }),
    row({ game_id: "partial" }),
    row({ game_id: "partial", operation_kind: "validator", provider: "anthropic", model_id: "claude-sonnet-5", input_tokens: null, output_tokens: null }),
  ];
  const reports = summarizeGameCosts(rows, new Map([["done", "completed"], ["quit", "abandoned_inferred"]]));
  const completed = summarizeCohort(reports.filter((r) => r.completed));
  const notCompleted = summarizeCohort(reports.filter((r) => !r.completed));

  assert.equal(completed.games, 1);
  assert.equal(completed.fully_priced_games, 1);
  assert.ok(Math.abs((completed.mean_total_usd ?? 0) - 0.15) < 1e-9);

  assert.equal(notCompleted.games, 2, "'quit' (abandoned) and 'partial' (no corpus row yet => unknown lifecycle)");
  assert.equal(notCompleted.fully_priced_games, 1, "'partial' has an unknown-usage call and is excluded rather than understated");
  assert.ok(Math.abs(notCompleted.total_usd_fully_priced - 0.075) < 1e-9);

  const none = summarizeCohort([]);
  assert.equal(none.mean_total_usd, null, "no invented average before any game is measured");
});
