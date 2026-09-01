import { getSql, isCorpusConfigured, type SqlClient } from "./db";

// ---------------------------------------------------------------------------
// M3 — read-only full-transcript reconstruction for scoring against
// docs/racer-scorecard.md.
//
// WHY THIS IS A SEPARATE MODULE FROM lib/corpus/gameIntelligenceSignals.ts.
// M2's fetch* functions assemble AGGREGATE signals (counts, rates, a single
// resolved guidance version) — exactly what a deterministic evaluation needs
// and no more. The M0 scorecard needs the opposite shape: every individual
// turn, in order, with its question/guess text, composer response, and
// rationale, so a scorer can cite a specific turn_index. Reusing
// gameIntelligenceSignals.ts for that would mean widening an M2 module's
// contract for an M3 need; a new module keeps each milestone's read surface
// matched to what it actually asks for.
//
// EVERY QUERY HERE IS A SELECT. No INSERT, UPDATE, or DELETE — this module
// cannot mutate the evidence it reports on, and cannot write a new game.
//
// THIS MODULE MUST NEVER IMPORT secretStore, gameStore, OR ANY GAME LOGIC. It
// is listed in QUARANTINED in scripts/check-isolation.mjs, matching every
// other lib/corpus/*.ts module — the corpus, transcript export included, must
// be structurally incapable of reading the secret.
//
// NEVER THROWS. A read failure returns null; the caller decides what that means.
// ---------------------------------------------------------------------------

export interface TranscriptTurn {
  turn_index: number;
  branch: "main" | "abandoned";
  branch_seq: number | null;
  turn_type: string;
  actor: string;
  question_text: string | null;
  guess_text: string | null;
  clue_text: string | null;
  composer_response: string | null;
  ambiguous_explanation: string | null;
  guess_detector_flagged: boolean;
  guess_detector_method: string | null;
  guess_intent_outcome: string | null;
  original_question_text: string | null;
  edit_status: string | null;
  edit_reason: string | null;
  /**
   * The Racer's private working notes for this turn, extracted from
   * raw_output. Null when raw_output has no "rationale" key (e.g. a
   * Composer-answer turn never carries one) or is not a Racer-shaped record —
   * never fabricated when absent.
   */
  rationale: string | null;
  model_id: string | null;
  model_provider: string | null;
  prompt_version: string | null;
  occurred_at: string;
  answered_at: string | null;
  pre_revision_question_text: string | null;
}

export interface TranscriptTarget {
  target: string | null;
  definition: string | null;
  granularity: string | null;
  modifiers: string | null;
  locked_at: string | null;
}

export interface TranscriptResolution {
  final_action: string | null;
  final_guess_text: string | null;
  adjudicator_verdict: string | null;
  adjudicator_confidence: number | null;
  adjudication_notes: string | null;
  integrity_verdict: string | null;
  integrity_notes: string | null;
  integrity_flagged_turns: number[] | null;
  resolved_at: string | null;
}

export interface FullTranscript {
  corpus_game_id: string;
  operational_game_id: string;
  benchmark_case_id: string | null;
  benchmark_run_id: string | null;
  lifecycle_state: string;
  outcome: string | null;
  difficulty: string | null;
  game_language: string | null;
  max_questions: number;
  question_count: number;
  ambiguous_count: number;
  created_at: string | null;
  finalized_at: string | null;
  /** Null until the game has declassified its target (corpus.game_targets has no row yet). */
  target: TranscriptTarget | null;
  /** Null until the game has resolved (corpus.game_resolutions has no row yet). */
  resolution: TranscriptResolution | null;
  /** Main-branch turns only, ordered by turn_index ascending — the game as played. */
  turns: TranscriptTurn[];
  /** Rewound turns, ordered by branch_seq then turn_index — real evidence, kept structurally separate. */
  abandoned_turns: TranscriptTurn[];
}

function n(v: unknown): number {
  const num = Number(v);
  return Number.isFinite(num) ? num : 0;
}
function s(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/**
 * Extract the Racer's "rationale" from a turn's raw_output, however the
 * driver returned it. Never throws: an unparseable or missing value is a
 * quiet null, not an error, matching the module's read-only, never-fails
 * contract.
 */
function extractRationale(rawOutput: unknown): string | null {
  let parsed: unknown = rawOutput;
  if (typeof rawOutput === "string") {
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      return null;
    }
  }
  if (parsed && typeof parsed === "object" && "rationale" in parsed) {
    const value = (parsed as Record<string, unknown>).rationale;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function toTranscriptTurn(row: Record<string, unknown>): TranscriptTurn {
  const branch = row.branch === "abandoned" ? "abandoned" : "main";
  return {
    turn_index: n(row.turn_index),
    branch,
    branch_seq: row.branch_seq === null || row.branch_seq === undefined ? null : n(row.branch_seq),
    turn_type: String(row.turn_type),
    actor: String(row.actor),
    question_text: s(row.question_text),
    guess_text: s(row.guess_text),
    clue_text: s(row.clue_text),
    composer_response: s(row.composer_response),
    ambiguous_explanation: s(row.ambiguous_explanation),
    guess_detector_flagged: Boolean(row.guess_detector_flagged),
    guess_detector_method: s(row.guess_detector_method),
    guess_intent_outcome: s(row.guess_intent_outcome),
    original_question_text: s(row.original_question_text),
    edit_status: s(row.edit_status),
    edit_reason: s(row.edit_reason),
    rationale: extractRationale(row.raw_output),
    model_id: s(row.model_id),
    model_provider: s(row.model_provider),
    prompt_version: s(row.prompt_version),
    occurred_at: String(row.occurred_at),
    answered_at: s(row.answered_at),
    pre_revision_question_text: s(row.pre_revision_question_text),
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

/** Assemble one game's full transcript from its corpus.games row plus turns/target/resolution. */
async function assembleTranscript(
  sql: SqlClient,
  gameRow: Record<string, unknown>
): Promise<FullTranscript> {
  const corpusGameId = String(gameRow.corpus_game_id);

  const [turnRows, targetRows, resolutionRows] = await Promise.all([
    sql`
      SELECT turn_index, branch, branch_seq, turn_type, actor,
             question_text, guess_text, clue_text, composer_response,
             ambiguous_explanation, guess_detector_flagged, guess_detector_method,
             guess_intent_outcome, original_question_text, edit_status, edit_reason,
             raw_output, occurred_at,
             model_id, model_provider, prompt_version, answered_at,
             pre_revision_question_text
        FROM corpus.game_turns
       WHERE corpus_game_id = ${corpusGameId}::uuid
       ORDER BY turn_index ASC
    `,
    sql`
      SELECT target, definition, granularity, modifiers, locked_at
        FROM corpus.game_targets
       WHERE corpus_game_id = ${corpusGameId}::uuid
    `,
    sql`
      SELECT final_action, final_guess_text,
             adjudicator_verdict, adjudicator_confidence, adjudication_notes,
             integrity_verdict, integrity_notes, integrity_flagged_turns, resolved_at
        FROM corpus.game_resolutions
       WHERE corpus_game_id = ${corpusGameId}::uuid
    `,
  ]);

  const allTurns = turnRows.map(toTranscriptTurn);
  const turns = allTurns
    .filter((t) => t.branch === "main")
    .sort((a, b) => a.turn_index - b.turn_index);
  const abandonedTurns = allTurns
    .filter((t) => t.branch === "abandoned")
    .sort((a, b) => (a.branch_seq ?? 0) - (b.branch_seq ?? 0) || a.turn_index - b.turn_index);

  const targetRow = targetRows[0];
  const target: TranscriptTarget | null = targetRow
    ? {
        target: s(targetRow.target),
        definition: s(targetRow.definition),
        granularity: s(targetRow.granularity),
        modifiers: s(targetRow.modifiers),
        locked_at: s(targetRow.locked_at),
      }
    : null;

  const resolutionRow = resolutionRows[0];
  const resolution: TranscriptResolution | null = resolutionRow
    ? {
        final_action: s(resolutionRow.final_action),
        final_guess_text: s(resolutionRow.final_guess_text),
        adjudicator_verdict: s(resolutionRow.adjudicator_verdict),
        adjudicator_confidence:
          resolutionRow.adjudicator_confidence === null ||
          resolutionRow.adjudicator_confidence === undefined
            ? null
            : n(resolutionRow.adjudicator_confidence),
        adjudication_notes: s(resolutionRow.adjudication_notes),
        integrity_verdict: s(resolutionRow.integrity_verdict),
        integrity_notes: s(resolutionRow.integrity_notes),
        integrity_flagged_turns: Array.isArray(resolutionRow.integrity_flagged_turns)
          ? (resolutionRow.integrity_flagged_turns as unknown[]).map((v) => n(v))
          : null,
        resolved_at: s(resolutionRow.resolved_at),
      }
    : null;

  return {
    corpus_game_id: corpusGameId,
    operational_game_id: String(gameRow.operational_game_id),
    benchmark_case_id: s(gameRow.benchmark_case_id),
    benchmark_run_id: s(gameRow.benchmark_run_id),
    lifecycle_state: String(gameRow.lifecycle_state),
    outcome: s(gameRow.outcome),
    difficulty: s(gameRow.difficulty),
    game_language: s(gameRow.game_language),
    max_questions: n(gameRow.max_questions),
    question_count: n(gameRow.question_count),
    ambiguous_count: n(gameRow.ambiguous_count),
    created_at: s(gameRow.created_at),
    finalized_at: s(gameRow.finalized_at),
    target,
    resolution,
    turns,
    abandoned_turns: abandonedTurns,
  };
}

/**
 * One game's full transcript by its corpus_game_id (the row identity
 * corpus.games itself uses, and the id the M3 SOW's frozen evidence set
 * quotes directly).
 *
 * READ-ONLY. Issues no INSERT, UPDATE or DELETE.
 */
export async function fetchFullTranscriptByCorpusGameId(
  corpusGameId: string
): Promise<FullTranscript | null> {
  const sql = await resolveSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT corpus_game_id, operational_game_id, benchmark_case_id, benchmark_run_id,
             lifecycle_state, outcome, difficulty, game_language,
             max_questions, question_count, ambiguous_count, created_at, finalized_at
        FROM corpus.games
       WHERE corpus_game_id = ${corpusGameId}::uuid
    `;
    const row = rows[0];
    if (!row) return null;
    return await assembleTranscript(sql, row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] transcript export failed for corpus_game_id ${corpusGameId}:`, err);
    return null;
  }
}

/** One game's full transcript by its operational (Redis/game-URL) id. */
export async function fetchFullTranscriptByOperationalGameId(
  operationalGameId: string
): Promise<FullTranscript | null> {
  const sql = await resolveSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT corpus_game_id, operational_game_id, benchmark_case_id, benchmark_run_id,
             lifecycle_state, outcome, difficulty, game_language,
             max_questions, question_count, ambiguous_count, created_at, finalized_at
        FROM corpus.games
       WHERE operational_game_id = ${operationalGameId}::uuid
    `;
    const row = rows[0];
    if (!row) return null;
    return await assembleTranscript(sql, row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[barkoba] transcript export failed for operational game ${operationalGameId}:`,
      err
    );
    return null;
  }
}

/**
 * Every game tagged with this benchmark_run_id (migration 0005: a run groups
 * repeated plays of one case) — a list, for the frozen M1 run returns exactly
 * one transcript.
 */
export async function fetchFullTranscriptsByBenchmarkRunId(
  benchmarkRunId: string
): Promise<FullTranscript[] | null> {
  const sql = await resolveSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT corpus_game_id, operational_game_id, benchmark_case_id, benchmark_run_id,
             lifecycle_state, outcome, difficulty, game_language,
             max_questions, question_count, ambiguous_count, created_at, finalized_at
        FROM corpus.games
       WHERE benchmark_run_id = ${benchmarkRunId}::uuid
       ORDER BY created_at ASC
    `;
    const transcripts: FullTranscript[] = [];
    for (const row of rows) transcripts.push(await assembleTranscript(sql, row));
    return transcripts;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[barkoba] transcript export failed for benchmark_run_id ${benchmarkRunId}:`,
      err
    );
    return null;
  }
}

/**
 * TEMPORARY, added for a one-off player-facing evidence pull ("give me my
 * last N games"). The most recent N ORDINARY games — a human Composer
 * against the AI Racer, exactly the /compose journey — excluding anything
 * tagged as a benchmark/lab run. Not scoped to one player_id: this project
 * has no session available to resolve "which player is asking" from a
 * server-side script, so recency is the practical proxy. The caller is
 * expected to sanity-check the returned targets/timestamps against what the
 * requester actually remembers playing, and to exclude any entries that
 * are not theirs (e.g. this branch's own verification games).
 *
 * READ-ONLY, same contract as every function above.
 */
export async function fetchRecentOrdinaryGames(limit: number): Promise<FullTranscript[] | null> {
  const sql = await resolveSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT corpus_game_id, operational_game_id, benchmark_case_id, benchmark_run_id,
             lifecycle_state, outcome, difficulty, game_language,
             max_questions, question_count, ambiguous_count, created_at, finalized_at
        FROM corpus.games
       WHERE benchmark_case_id IS NULL
         AND composer_kind = 'human'
         AND racer_kind = 'ai'
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
    const transcripts: FullTranscript[] = [];
    for (const row of rows) transcripts.push(await assembleTranscript(sql, row));
    return transcripts;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] recent-ordinary-games export failed:`, err);
    return null;
  }
}
