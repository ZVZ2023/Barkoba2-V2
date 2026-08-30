import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeDeterministicSignals,
  fetchGameIntelligenceByBenchmarkRun,
  fetchGameIntelligenceByOperationalGameId,
} from "../lib/corpus/gameIntelligenceSignals";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";

// ---------------------------------------------------------------------------
// M2 — deterministic evaluation signals.
//
// computeDeterministicSignals() is pure and tested here with no database at
// all — the point of separating it from the SQL that feeds it, matching
// lib/corpus/gameContests.ts's buildContestEvidence() precedent. The
// fetch* functions are exercised against a fake SqlClient, the same pattern
// test/corpusPersistence.test.ts uses, and are NOT run against live Neon here.
// ---------------------------------------------------------------------------

// --- the pure signal function ------------------------------------------------

test("full budget used, no anomalies: zero headroom, forced final", () => {
  const s = computeDeterministicSignals({
    max_questions: 20,
    question_count: 20,
    ambiguous_count: 0,
    flagged_turn_count: 0,
    correction_count: 0,
  });
  assert.equal(s.budget_headroom, 0);
  assert.equal(s.forced_final, true);
  assert.equal(s.guess_detector_flag_rate, 0);
  assert.equal(s.ambiguous_rate, 0);
  assert.equal(s.correction_count, 0);
});

test("one question of headroom is NOT forced final", () => {
  // Mirrors the shape of the frozen M1 baseline (max_questions=50): a guess
  // made with budget still available is a voluntary guess, not one forced by
  // exhaustion — this is exactly the distinction the M2 design requires this
  // signal to make mechanically, without any semantic judgment about when the
  // Racer was actually ready.
  const s = computeDeterministicSignals({
    max_questions: 50,
    question_count: 49,
    ambiguous_count: 9,
    flagged_turn_count: 2,
    correction_count: 0,
  });
  assert.equal(s.budget_headroom, 1);
  assert.equal(s.forced_final, false);
  assert.equal(s.guess_detector_flag_rate, 2 / 49);
  assert.equal(s.ambiguous_rate, 9 / 49);
});

test("zero questions asked: rates are null, not zero, and not NaN", () => {
  const s = computeDeterministicSignals({
    max_questions: 20,
    question_count: 0,
    ambiguous_count: 0,
    flagged_turn_count: 0,
    correction_count: 0,
  });
  assert.equal(s.budget_headroom, 20);
  assert.equal(s.forced_final, false);
  assert.equal(s.guess_detector_flag_rate, null);
  assert.equal(s.ambiguous_rate, null);
});

test("correction_count passes through unchanged", () => {
  const s = computeDeterministicSignals({
    max_questions: 20,
    question_count: 10,
    ambiguous_count: 0,
    flagged_turn_count: 0,
    correction_count: 3,
  });
  assert.equal(s.correction_count, 3);
});

// --- the fetch functions: fake SqlClient, no live database -------------------

interface Recorded {
  sql: string;
}

let calls: Recorded[] = [];
let gameRows: Record<string, unknown>[] = [];

const GAME_ROW = {
  corpus_game_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  operational_game_id: "76041765-4654-4eb1-8713-32591d396600",
  benchmark_case_id: "m1-d1-generic-backpack",
  benchmark_run_id: "c1e02ec4-fedb-4583-9ef8-63dde24eed3a",
  lifecycle_state: "completed",
  outcome: "racer_correct",
  max_questions: "50", // Neon's HTTP driver returns numerics as strings
  question_count: "49",
  ambiguous_count: "9",
};

function fakeSql(strings: TemplateStringsArray, ..._values: SqlValue[]) {
  const text = strings.join("?");
  calls.push({ sql: text });
  if (text.includes("FROM corpus.games")) {
    return Promise.resolve(gameRows);
  }
  if (text.includes("FROM corpus.game_turns") && text.includes("guess_detector_flagged")) {
    return Promise.resolve([{ n: 2 }]);
  }
  if (text.includes("FROM corpus.game_corrections")) {
    return Promise.resolve([{ n: 0 }]);
  }
  if (text.includes("ORDER BY turn_index DESC")) {
    return Promise.resolve([{ prompt_version: "racer/4.0.0" }]);
  }
  if (text.includes("FROM corpus.racer_guidance_versions")) {
    return Promise.resolve([
      {
        version: "racer/4.0.0",
        guidance_text: "…",
        introduced_at: "2026-08-21T19:22:14.000Z",
        source_ref: "204de37",
        game_memory_observability: {
          evidence_ledger: "observed",
          remaining_budget: "deterministically_derived",
          exclusions: "not_observable",
          uncertainty: "not_observable",
          candidate_hypotheses: "not_observable",
        },
      },
    ]);
  }
  if (text.includes("FROM corpus.racer_guidance_decisions")) {
    return Promise.resolve([]); // zero decision events — the valid initial condition
  }
  return Promise.resolve([] as Record<string, unknown>[]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

beforeEach(() => {
  calls = [];
  gameRows = [GAME_ROW];
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
});

test("fetchGameIntelligenceByBenchmarkRun assembles signals and guidance for the M1-shaped fixture", async () => {
  const records = await fetchGameIntelligenceByBenchmarkRun(
    "c1e02ec4-fedb-4583-9ef8-63dde24eed3a"
  );
  assert.equal(records?.length, 1);
  const record = records![0]!;

  assert.equal(record.operational_game_id, "76041765-4654-4eb1-8713-32591d396600");
  assert.equal(record.signals.budget_headroom, 1);
  assert.equal(record.signals.forced_final, false);
  assert.equal(record.signals.guess_detector_flag_rate, 2 / 49);
  assert.equal(record.signals.ambiguous_rate, 9 / 49);
  assert.equal(record.signals.correction_count, 0);

  assert.deepEqual(record.guidance_versions_used, ["racer/4.0.0"]);
  assert.equal(record.guidance.length, 1);
  assert.equal(record.guidance[0]?.found_in_catalog, true);
  assert.equal(record.guidance[0]?.decision_count, 0);
  assert.equal(record.guidance[0]?.game_memory_observability?.exclusions, "not_observable");
});

test("fetchGameIntelligenceByOperationalGameId returns null for an unknown game, without error", async () => {
  gameRows = [];
  const record = await fetchGameIntelligenceByOperationalGameId("00000000-0000-0000-0000-000000000000");
  assert.equal(record, null);
});

test("no fetch path issues an INSERT, UPDATE or DELETE against the frozen corpus", async () => {
  await fetchGameIntelligenceByBenchmarkRun("c1e02ec4-fedb-4583-9ef8-63dde24eed3a");
  for (const call of calls) {
    assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE)\b/i);
  }
});

test("an uncataloged guidance version is reported honestly, not fabricated", async () => {
  const originalFakeSql = fakeSql;
  const patched = ((strings: TemplateStringsArray, ...values: SqlValue[]) => {
    const text = strings.join("?");
    if (text.includes("ORDER BY turn_index DESC")) {
      return Promise.resolve([{ prompt_version: "racer/2.6.0" }]);
    }
    if (text.includes("FROM corpus.racer_guidance_versions")) {
      return Promise.resolve([]); // no catalog row for this older version
    }
    return originalFakeSql(strings, ...values);
  }) as typeof fakeSql;
  patched.transaction = fakeSql.transaction;
  __setSqlClientForTests(patched);

  const records = await fetchGameIntelligenceByBenchmarkRun(
    "c1e02ec4-fedb-4583-9ef8-63dde24eed3a"
  );
  const guidance = records?.[0]?.guidance[0];
  assert.equal(guidance?.version, "racer/2.6.0");
  assert.equal(guidance?.found_in_catalog, false);
  assert.equal(guidance?.game_memory_observability, null);
});

// --- M2 closeout fix: identify guidance version without a final-action join -

test("the guidance-version lookup filters on actor='ai_racer' and takes the latest turn only", async () => {
  await fetchGameIntelligenceByBenchmarkRun("c1e02ec4-fedb-4583-9ef8-63dde24eed3a");
  const versionQuery = calls.find((c) => c.sql.includes("ORDER BY turn_index DESC"));
  assert.ok(versionQuery, "expected the guidance-version query to run");
  assert.match(versionQuery!.sql, /actor = 'ai_racer'/);
  assert.match(versionQuery!.sql, /LIMIT 1/);
});

test("the module issues no SQL join or reference to corpus.game_resolutions", () => {
  // Checked against actual SQL usage, not prose: the module's own comments
  // explain (and are allowed to mention) the join this fix removed — what must
  // never return is a real FROM/JOIN targeting that table.
  const source = readFileSync("lib/corpus/gameIntelligenceSignals.ts", "utf8");
  assert.doesNotMatch(source, /(FROM|JOIN)\s+corpus\.game_resolutions/);
});
