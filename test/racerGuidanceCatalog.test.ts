import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitSqlStatements } from "../lib/corpus/sqlStatements";
import { RACER_PROMPT_VERSION } from "../lib/prompts/racer";
import {
  getGuidanceVersion,
  listGuidanceDecisions,
  RACER_4_0_0_GAME_MEMORY_OBSERVABILITY,
} from "../lib/corpus/racerGuidanceCatalog";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";

// ---------------------------------------------------------------------------
// M2 — Racer Guidance catalog (Strategy Memory).
//
// SCOPE, STATED HONESTLY, matching test/corpusPersistence.test.ts: there is no
// PostgreSQL in this test environment. These tests verify (1) that migration
// 0012's seed data is byte-identical to the racer/4.0.0 guidance text it was
// written to describe, frozen below rather than imported live — see the
// M4 note directly above RACER_4_0_0_TEXT for why — and (2) that the read
// module issues only SELECT statements and correctly reports the valid
// zero-decision initial state. They do NOT prove the migration applies
// cleanly against live Neon; that is a live-migration exercise, listed as a
// remaining item in the completion report.
// ---------------------------------------------------------------------------

const MIGRATION = readFileSync("migrations/0012_racer_guidance_catalog.sql", "utf8");

// M4 — this migration seeded exactly ONE guidance version, racer/4.0.0, and
// must go on describing that version forever, regardless of what
// lib/prompts/racer.ts exports live today. Before M4, CORE_RACER_RULES *was*
// racer/4.0.0's text, so importing it live and migration 0012's seed were
// the same string by definition. M4 bumped CORE_RACER_RULES to racer/4.1.0's
// text (docs/m4-experiment-spec.md), which would make a live import silently
// stop matching this migration's historical seed — exactly the kind of
// drift this catalog exists to catch, not cause. Frozen verbatim from
// docs/DESIGN-NOTES.md §50 and racer/4.0.0 as it stood at commit 2ca5f1b
// (M3 baseline close), never edited going forward.
const RACER_4_0_0_TEXT = `RACER GUIDANCE V4 — UNCERTAINTY-MANAGEMENT LOOP — APPLY EVERY TURN

Before every turn, hold this state internally. Emit only the resulting question or guess.

KNOWN
Every hard YES, NO, and AMBIGUOUS answer so far. These are filters, not suggestions — nothing later may contradict one. AMBIGUOUS is informative failure, not a soft answer: it means the last question conflated two things a truthful answerer could not separate. Isolate one of them next; never re-ask a paraphrase of it.

UNKNOWN
The open dimensions that actually matter for this target's domain — discovered from the target itself, not a fixed checklist. Which one, if answered, would most shrink what remains possible?

HYPOTHESES
The leading family or families still consistent with KNOWN, plus the single strongest credible alternative. Keep this small and live, never a single premature favorite.

SELECT
Prefer the question that most usefully divides current HYPOTHESES over one that only confirms the leader. A broad split across an unresolved dimension beats naming siblings one at a time. After two or three related NOs on the same branch, stop — that is a signal, not a coincidence — and ask whether the parent frame itself is wrong before trying more siblings.

RED FLAGS — reject and regenerate if the question:
- Contradicts anything in KNOWN
- Re-probes a dimension already settled by a YES or a NO — a sibling within it, an edge case, or a more precise variant of the same confirmed value
- Names one specific sibling while a broader grouping one level up still has multiple live alternatives
- Is a disguised identity question — naming a candidate is a GUESS, not a question
- Investigates spelling, letters, or name structure instead of meaning and properties
- Targets two or three very similar remaining candidates with something generic or descriptive rather than the one property that specifically separates them

BEFORE ANY FINAL GUESS
Name the leader and the strongest remaining alternative — specifically, not a vague sense that others remain. Which facts support the leader and not equally the alternative? Have I asked the single discriminator that would most separate them? Would a reasonably informed human, given everything established so far, still be seriously considering that alternative — if yes, I am not ready to guess. Does the leader violate any fact in KNOWN? If an important discriminator remains unasked and budget allows, ask it instead of guessing.`;

// --- provenance: the seed must say exactly what racer/4.0.0 actually was ----

test("migration 0012 seeds the exact racer/4.0.0 guidance text, byte for byte", () => {
  const match = /\$guidance\$([\s\S]*?)\$guidance\$/.exec(MIGRATION);
  assert.ok(match, "expected a $guidance$ ... $guidance$ dollar-quoted body in the migration");
  assert.equal(
    match![1],
    RACER_4_0_0_TEXT,
    "the seeded guidance_text must be identical to racer/4.0.0's frozen text — " +
      "this is the fact this migration exists to record, permanently, regardless of " +
      "which version is live today"
  );
});

test("migration 0012 seeds racer/4.0.0, and RACER_PROMPT_VERSION has since moved on (M4)", () => {
  assert.match(MIGRATION, /'racer\/4\.0\.0'/);
  assert.notEqual(
    RACER_PROMPT_VERSION,
    "racer/4.0.0",
    "as of M4, the live guidance is racer/4.1.0 — migration 0012 is a historical " +
      "record of racer/4.0.0, not a live mirror of RACER_PROMPT_VERSION"
  );
});

test("migration 0012 never asserts a promotion/rejection decision for the seeded version", () => {
  // The seed statement inserts into racer_guidance_versions only. There must be
  // no companion INSERT into racer_guidance_decisions anywhere in this file —
  // zero decision events is the valid initial condition, not a default this
  // migration is allowed to assert.
  assert.doesNotMatch(MIGRATION, /INSERT INTO corpus\.racer_guidance_decisions/);
});

// --- the migration file must still split safely --------------------------
// Regression cover in the same spirit as test/sqlStatements.test.ts: the
// dollar-quoted guidance_text must not be mistaken for a statement boundary by
// the real migration runner, even though (unlike 0001's plpgsql bodies) this
// dollar-quoted body sits inside a plain INSERT rather than a function.

test("migration 0012 splits into one statement per seed insert, guidance_text intact", () => {
  const statements = splitSqlStatements(MIGRATION);
  const seedStatement = statements.find((s) =>
    s.includes("INSERT INTO corpus.racer_guidance_versions")
  );
  assert.ok(seedStatement, "expected exactly one seed INSERT statement");
  assert.match(seedStatement!, /KNOWN\n/);
  assert.match(seedStatement!, /BEFORE ANY FINAL GUESS/);
  assert.match(seedStatement!, /ON CONFLICT \(version\) DO NOTHING$/);
});

test("migration 0012 defines both immutability triggers", () => {
  assert.match(MIGRATION, /CREATE TRIGGER guidance_versions_immutable/);
  assert.match(MIGRATION, /CREATE TRIGGER guidance_decisions_immutable/);
});

// --- the declared observability shape ---------------------------------------

test("RACER_4_0_0_GAME_MEMORY_OBSERVABILITY declares exclusions/uncertainty/hypotheses as not_observable", () => {
  assert.deepEqual(RACER_4_0_0_GAME_MEMORY_OBSERVABILITY, {
    evidence_ledger: "observed",
    remaining_budget: "deterministically_derived",
    exclusions: "not_observable",
    uncertainty: "not_observable",
    candidate_hypotheses: "not_observable",
  });
});

test("migration 0012's seeded jsonb matches RACER_4_0_0_GAME_MEMORY_OBSERVABILITY exactly", () => {
  const match = /'(\{"evidence_ledger":[\s\S]*?\})'::jsonb/.exec(MIGRATION);
  assert.ok(match, "expected the game_memory_observability jsonb literal in the seed insert");
  assert.deepEqual(JSON.parse(match![1]!), RACER_4_0_0_GAME_MEMORY_OBSERVABILITY);
});

// --- the read module: fake SqlClient, no live database ----------------------

interface Recorded {
  sql: string;
  values: SqlValue[];
}

let calls: Recorded[] = [];
let versionRows: Record<string, unknown>[] = [];
let decisionRows: Record<string, unknown>[] = [];

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const text = strings.join("?");
  calls.push({ sql: text, values });
  if (text.includes("FROM corpus.racer_guidance_versions")) {
    return Promise.resolve(versionRows);
  }
  if (text.includes("FROM corpus.racer_guidance_decisions")) {
    return Promise.resolve(decisionRows);
  }
  return Promise.resolve([] as Record<string, unknown>[]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

beforeEach(() => {
  calls = [];
  versionRows = [];
  decisionRows = [];
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
});

test("getGuidanceVersion returns null when no row matches", async () => {
  const result = await getGuidanceVersion("racer/9.9.9");
  assert.equal(result, null);
});

test("getGuidanceVersion parses the observability jsonb whether the driver returns an object or a string", async () => {
  const observability = RACER_4_0_0_GAME_MEMORY_OBSERVABILITY;
  versionRows = [
    {
      version: "racer/4.0.0",
      guidance_text: RACER_4_0_0_TEXT,
      introduced_at: "2026-08-21T19:22:14.000Z",
      source_ref: "204de3780a1177614ef73af40285afda87efe784",
      game_memory_observability: observability, // object, as most drivers return jsonb
    },
  ];
  const asObject = await getGuidanceVersion("racer/4.0.0");
  assert.deepEqual(asObject?.game_memory_observability, observability);

  versionRows = [{ ...versionRows[0], game_memory_observability: JSON.stringify(observability) }];
  const asString = await getGuidanceVersion("racer/4.0.0");
  assert.deepEqual(asString?.game_memory_observability, observability);
});

test("listGuidanceDecisions returns an empty array for a version with zero decision events — the valid initial condition", async () => {
  decisionRows = [];
  const decisions = await listGuidanceDecisions("racer/4.0.0");
  assert.deepEqual(decisions, []);
});

test("listGuidanceDecisions surfaces a recorded decision without inventing a status for versions that have none", async () => {
  decisionRows = [
    {
      decision_id: "11111111-1111-1111-1111-111111111111",
      version: "racer/3.0.0",
      decision: "rejected",
      decided_at: "2026-01-01T00:00:00.000Z",
      decided_by: "zsolt",
      benchmark_run_id: null,
      notes: "superseded by racer/4.0.0",
    },
  ];
  const decisions = await listGuidanceDecisions("racer/3.0.0");
  assert.equal(decisions?.length, 1);
  assert.equal(decisions?.[0]?.decision, "rejected");
});

test("this module never issues an INSERT, UPDATE or DELETE — it is read-only", async () => {
  await getGuidanceVersion("racer/4.0.0");
  await listGuidanceDecisions("racer/4.0.0");
  for (const call of calls) {
    assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE)\b/i);
  }
});
