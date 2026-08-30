import { getSql, isCorpusConfigured, type SqlClient } from "./db";

// ---------------------------------------------------------------------------
// M2 — Strategy Memory: the Racer Guidance catalog.
//
// READ-ONLY BY DESIGN. This module has no write function, on purpose — M2
// establishes the storage contract for guidance identity, provenance and
// promotion/rejection history, and nothing else. Populating a version row or
// deciding a promotion/rejection is out of scope here; migration 0012 seeds
// the one version that exists today, and a later milestone that actually
// makes a promotion/rejection decision is the first legitimate writer of
// corpus.racer_guidance_decisions.
//
// THIS MODULE MUST NEVER IMPORT secretStore, gameStore, OR ANY GAME LOGIC. It
// is listed in QUARANTINED in scripts/check-isolation.mjs, so that is
// mechanically enforced rather than promised here — matching every other
// lib/corpus/*.ts module.
//
// NEVER THROWS, matching gameCorpus.ts and gameContests.ts. A read failure
// returns null/[]; the caller decides what that means.
// ---------------------------------------------------------------------------

/**
 * Provenance classification for one conceptual Game Memory field, as declared
 * against a specific guidance version's own tool schema and system prompt —
 * never measured per game. See migration 0012's header for why this is a
 * per-version declaration rather than a per-game field.
 */
export type ObservabilityLabel =
  | "observed"
  | "deterministically_derived"
  | "not_observable"
  | "post_hoc_inference";

export interface GameMemoryObservability {
  evidence_ledger: ObservabilityLabel;
  remaining_budget: ObservabilityLabel;
  exclusions: ObservabilityLabel;
  uncertainty: ObservabilityLabel;
  candidate_hypotheses: ObservabilityLabel;
}

/**
 * The declaration seeded by migration 0012 for the currently shipped
 * guidance version. Kept here, alongside the type, so tests can pin the
 * migration's embedded jsonb against a single TypeScript source rather than a
 * second copy of the literal — see test/racerGuidanceCatalog.test.ts.
 *
 * `exclusions`/`uncertainty`/`candidate_hypotheses` are "not_observable"
 * because lib/prompts/racer.ts's turnInputSchema forces exactly four output
 * keys (action, question_text, guess_text, rationale) and CORE_RACER_RULES
 * itself instructs the model to hold KNOWN/UNKNOWN/HYPOTHESES state
 * internally and "emit only the resulting question or guess." Nothing about
 * this module or migration 0012 changes that prompt or that schema.
 */
export const RACER_4_0_0_GAME_MEMORY_OBSERVABILITY: GameMemoryObservability = {
  evidence_ledger: "observed",
  remaining_budget: "deterministically_derived",
  exclusions: "not_observable",
  uncertainty: "not_observable",
  candidate_hypotheses: "not_observable",
};

export interface GuidanceVersionRecord {
  version: string;
  guidance_text: string;
  introduced_at: string;
  source_ref: string | null;
  game_memory_observability: GameMemoryObservability;
}

export type GuidanceDecision = "promoted" | "rejected";

export interface GuidanceDecisionRecord {
  decision_id: string;
  version: string;
  decision: GuidanceDecision;
  decided_at: string;
  decided_by: string | null;
  benchmark_run_id: string | null;
  notes: string | null;
}

function s(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toVersionRecord(row: Record<string, unknown>): GuidanceVersionRecord {
  const observability =
    typeof row.game_memory_observability === "string"
      ? (JSON.parse(row.game_memory_observability) as GameMemoryObservability)
      : (row.game_memory_observability as GameMemoryObservability);

  return {
    version: String(row.version),
    guidance_text: String(row.guidance_text),
    introduced_at: s(row.introduced_at) ?? "",
    source_ref: s(row.source_ref),
    game_memory_observability: observability,
  };
}

function toDecisionRecord(row: Record<string, unknown>): GuidanceDecisionRecord {
  return {
    decision_id: String(row.decision_id),
    version: String(row.version),
    decision: row.decision === "rejected" ? "rejected" : "promoted",
    decided_at: s(row.decided_at) ?? "",
    decided_by: s(row.decided_by),
    benchmark_run_id: s(row.benchmark_run_id),
    notes: s(row.notes),
  };
}

async function resolveSql(): Promise<SqlClient | null> {
  if (!isCorpusConfigured()) return null;
  try {
    return getSql();
  } catch {
    return null;
  }
}

/** One guidance version's identity, provenance and observability declaration. */
export async function getGuidanceVersion(
  version: string
): Promise<GuidanceVersionRecord | null> {
  const sql = await resolveSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT version, guidance_text, introduced_at, source_ref, game_memory_observability
        FROM corpus.racer_guidance_versions
       WHERE version = ${version}
    `;
    const row = rows[0];
    return row ? toVersionRecord(row) : null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] guidance catalog read failed for version ${version}:`, err);
    return null;
  }
}

/**
 * Every promotion/rejection decision recorded for one version, oldest first.
 *
 * An empty array is the valid, expected result for any version that has never
 * been promoted or rejected — that absence IS the fact, not a null or a
 * default status standing in for one. See migration 0012's header.
 */
export async function listGuidanceDecisions(
  version: string
): Promise<GuidanceDecisionRecord[] | null> {
  const sql = await resolveSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT decision_id, version, decision, decided_at, decided_by, benchmark_run_id, notes
        FROM corpus.racer_guidance_decisions
       WHERE version = ${version}
       ORDER BY decided_at ASC
    `;
    return rows.map(toDecisionRecord);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] guidance decision read failed for version ${version}:`, err);
    return null;
  }
}
