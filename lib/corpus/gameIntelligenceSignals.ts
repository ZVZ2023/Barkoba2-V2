import { getSql, isCorpusConfigured, type SqlClient } from "./db";
import {
  getGuidanceVersion,
  listGuidanceDecisions,
  type GameMemoryObservability,
} from "./racerGuidanceCatalog";

// ---------------------------------------------------------------------------
// M2 — deterministic evaluation signals over already-recorded corpus evidence.
//
// EVERY SIGNAL HERE IS ARITHMETIC OVER ALREADY-OBSERVED CORPUS COLUMNS. No
// model call, no LLM judge, no I/O beyond reading corpus.* — matching the
// approved M2 design's explicit instruction not to default to an LLM judge for
// anything mechanically determinable. computeDeterministicSignals() is a pure
// function precisely so it is unit-testable without a database — see
// test/gameIntelligenceSignals.test.ts.
//
// THIS MODULE MUST NEVER IMPORT secretStore, gameStore, OR ANY GAME LOGIC. It
// is listed in QUARANTINED in scripts/check-isolation.mjs, matching every
// other lib/corpus/*.ts module. It reads the durable corpus and nothing else.
//
// NEVER THROWS. A read failure returns null; the caller decides what that means.
// ---------------------------------------------------------------------------

export interface DeterministicSignalInputs {
  max_questions: number;
  question_count: number;
  ambiguous_count: number;
  /** Count of main-branch turns with guess_detector_flagged = true. */
  flagged_turn_count: number;
  correction_count: number;
}

export interface DeterministicSignals {
  /**
   * max_questions - question_count, at the point the game left the
   * questioning phase. Equal to RacerPublicState.questions_remaining at that
   * moment (lib/racerState.ts) — reconstructed here because that value is
   * never itself persisted; only the two counters it is computed from are.
   * DETERMINISTICALLY_DERIVED, per the M2 provenance map.
   */
  budget_headroom: number;
  /**
   * Mirrors the engine's own forceFinal test (app/api/game/[id]/turn/route.ts:
   * `question_count >= max_questions`) exactly, over the same two OBSERVED
   * counters. True means the final action was reached only because the
   * question budget was exhausted, not chosen with budget still available.
   */
  forced_final: boolean;
  /** null when question_count is 0 — nothing to rate. */
  guess_detector_flag_rate: number | null;
  ambiguous_rate: number | null;
  correction_count: number;
}

export function computeDeterministicSignals(
  input: DeterministicSignalInputs
): DeterministicSignals {
  const { max_questions, question_count, ambiguous_count, flagged_turn_count, correction_count } =
    input;

  return {
    budget_headroom: max_questions - question_count,
    forced_final: question_count >= max_questions,
    guess_detector_flag_rate: question_count > 0 ? flagged_turn_count / question_count : null,
    ambiguous_rate: question_count > 0 ? ambiguous_count / question_count : null,
    correction_count,
  };
}

export interface GuidanceUsage {
  version: string;
  /** False when a turn's prompt_version has no matching catalog row (migration 0012 not yet seeded for it, or an older, uncataloged version). */
  found_in_catalog: boolean;
  game_memory_observability: GameMemoryObservability | null;
  /** Count of promotion/rejection decisions recorded for this version. Zero is the valid, expected value for a version still being evaluated. */
  decision_count: number;
}

export interface GameIntelligenceRecord {
  corpus_game_id: string;
  operational_game_id: string;
  benchmark_case_id: string | null;
  benchmark_run_id: string | null;
  lifecycle_state: string;
  outcome: string | null;
  max_questions: number;
  question_count: number;
  ambiguous_count: number;
  signals: DeterministicSignals;
  /**
   * The guidance version identified from the latest main-branch ai_racer turn
   * with a non-null prompt_version. Zero or one entries — a list only for
   * shape stability, not because more than one is ever expected under the
   * current single-version-per-game invariant.
   */
  guidance_versions_used: string[];
  guidance: GuidanceUsage[];
}

function n(v: unknown): number {
  const num = Number(v);
  return Number.isFinite(num) ? num : 0;
}
function s(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

async function resolveSql(): Promise<SqlClient | null> {
  if (!isCorpusConfigured()) return null;
  try {
    return getSql();
  } catch {
    return null;
  }
}

/** Assemble one game's record from its corpus.games row plus derived counts. */
async function assembleRecord(
  sql: SqlClient,
  gameRow: Record<string, unknown>
): Promise<GameIntelligenceRecord> {
  const corpusGameId = String(gameRow.corpus_game_id);

  const [flaggedRows, correctionRows, versionRows] = await Promise.all([
    sql`
      SELECT count(*)::int AS n
        FROM corpus.game_turns
       WHERE corpus_game_id = ${corpusGameId}::uuid
         AND branch = 'main'
         AND guess_detector_flagged
    `,
    sql`
      SELECT count(*)::int AS n
        FROM corpus.game_corrections
       WHERE corpus_game_id = ${corpusGameId}::uuid
    `,
    // M2 CLOSEOUT FIX — identify the guidance version from the LATEST
    // main-branch ai_racer turn with a non-null prompt_version, rather than
    // the set of every distinct value ever seen. The earlier DISTINCT form
    // matched the live-verified proof query's *result* for a single-version
    // game, but the design-phase query it was modeled on separately tried to
    // reconstruct the final turn via a join to corpus.game_resolutions.
    // final_action + max(turn_index), which returns no row whenever that
    // join's assumptions don't hold. This query needs no join to
    // game_resolutions or final_action at all: turn_index DESC + LIMIT 1
    // deterministically picks the version in effect when the game left the
    // questioning phase, exactly matching the verified live semantics.
    sql`
      SELECT prompt_version
        FROM corpus.game_turns
       WHERE corpus_game_id = ${corpusGameId}::uuid
         AND branch = 'main'
         AND actor = 'ai_racer'
         AND prompt_version IS NOT NULL
       ORDER BY turn_index DESC
       LIMIT 1
    `,
  ]);

  const maxQuestions = n(gameRow.max_questions);
  const questionCount = n(gameRow.question_count);
  const ambiguousCount = n(gameRow.ambiguous_count);
  const flaggedCount = n(flaggedRows[0]?.n);
  const correctionCount = n(correctionRows[0]?.n);

  const signals = computeDeterministicSignals({
    max_questions: maxQuestions,
    question_count: questionCount,
    ambiguous_count: ambiguousCount,
    flagged_turn_count: flaggedCount,
    correction_count: correctionCount,
  });

  const guidanceVersionsUsed = versionRows.map((r) => String(r.prompt_version));

  const guidance: GuidanceUsage[] = [];
  for (const version of guidanceVersionsUsed) {
    const catalogRow = await getGuidanceVersion(version);
    const decisions = await listGuidanceDecisions(version);
    guidance.push({
      version,
      found_in_catalog: catalogRow !== null,
      game_memory_observability: catalogRow?.game_memory_observability ?? null,
      decision_count: decisions?.length ?? 0,
    });
  }

  return {
    corpus_game_id: corpusGameId,
    operational_game_id: String(gameRow.operational_game_id),
    benchmark_case_id: s(gameRow.benchmark_case_id),
    benchmark_run_id: s(gameRow.benchmark_run_id),
    lifecycle_state: String(gameRow.lifecycle_state),
    outcome: s(gameRow.outcome),
    max_questions: maxQuestions,
    question_count: questionCount,
    ambiguous_count: ambiguousCount,
    signals,
    guidance_versions_used: guidanceVersionsUsed,
    guidance,
  };
}

/**
 * Every game tagged with this benchmark_run_id. A run groups repeated plays
 * of one case (migration 0005), so this is a list — for the frozen M1 run it
 * returns exactly one record.
 *
 * READ-ONLY. Issues no INSERT, UPDATE or DELETE against corpus.* — this
 * function cannot mutate the evidence it reports on.
 */
export async function fetchGameIntelligenceByBenchmarkRun(
  benchmarkRunId: string
): Promise<GameIntelligenceRecord[] | null> {
  const sql = await resolveSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT corpus_game_id, operational_game_id, benchmark_case_id, benchmark_run_id,
             lifecycle_state, outcome, max_questions, question_count, ambiguous_count
        FROM corpus.games
       WHERE benchmark_run_id = ${benchmarkRunId}::uuid
       ORDER BY created_at ASC
    `;
    const records: GameIntelligenceRecord[] = [];
    for (const row of rows) records.push(await assembleRecord(sql, row));
    return records;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[barkoba] game intelligence read failed for benchmark_run_id ${benchmarkRunId}:`,
      err
    );
    return null;
  }
}

/** One game by its operational (Redis/game-URL) id. */
export async function fetchGameIntelligenceByOperationalGameId(
  operationalGameId: string
): Promise<GameIntelligenceRecord | null> {
  const sql = await resolveSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT corpus_game_id, operational_game_id, benchmark_case_id, benchmark_run_id,
             lifecycle_state, outcome, max_questions, question_count, ambiguous_count
        FROM corpus.games
       WHERE operational_game_id = ${operationalGameId}::uuid
    `;
    const row = rows[0];
    if (!row) return null;
    return await assembleRecord(sql, row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[barkoba] game intelligence read failed for game ${operationalGameId}:`,
      err
    );
    return null;
  }
}
