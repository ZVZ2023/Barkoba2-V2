import {
  getSql,
  isCorpusConfigured,
  corpusConfigStatus,
  type CorpusConfigReason,
  type SqlClient,
} from "./db";
import { enqueuePending, claimBatch, removePending } from "./pendingQueue";
import { unlinkPlayerContests } from "./gameContests";
import { env } from "../env";
import { getAppVersion } from "../appVersion";
import type { GameRecord, QuestionLogEntry } from "../types";

// ---------------------------------------------------------------------------
// V2.2 — THE CORPUS WRITE SEAM.
//
// The only module in the codebase permitted to write durable game history,
// mirroring secretStore and playerStore. Everything else calls recordGameState.
//
// THIS MODULE MUST NEVER IMPORT secretStore. It reads ONLY public GameRecord
// state, including the `revealed_*` fields written at the single
// declassification point in /api/game/[id]/resolve. That is decision M.3(a):
// the isolation invariant is preserved, and the accepted cost is that a game
// which never resolved carries no target metadata, because its target was never
// legitimately declassified.
//
// scripts/check-isolation.mjs lists this module as QUARANTINED, so the above is
// mechanically enforced and not a promise in a comment.
//
// THREE RULES THIS MODULE OBEYS ABSOLUTELY:
//
//   1. It never throws. A corpus failure must never break a game.
//   2. It never mutates GameRecord. It is strictly downstream of saveGame().
//   3. It never reports success it did not achieve. A failed write is queued
//      for replay, not swallowed silently.
// ---------------------------------------------------------------------------

export type CorpusOutcome = "disabled" | "below_threshold" | "written" | "deferred";

/**
 * Once per runtime instance. A 20-question game would otherwise log the same
 * configuration fact twenty times, which is how a signal becomes noise.
 */
let gatedWarningEmitted = false;

/** Test seam so each case starts from a clean slate. Not used in production. */
export function __resetCorpusWarnings(): void {
  gatedWarningEmitted = false;
}

function warnGatedOnce(reason: CorpusConfigReason): void {
  if (gatedWarningEmitted) return;
  gatedWarningEmitted = true;

  const advice: Record<CorpusConfigReason, string> = {
    ready: "",
    no_database_url:
      "DATABASE_URL is not visible to this runtime. Check it is scoped to this " +
      "environment, then redeploy — env changes do not reach a running deployment.",
    invalid_database_url:
      "DATABASE_URL is present but the driver cannot use it. GET /api/version " +
      "reports corpus.database_url_problem with the specific shape fault " +
      "(surrounding quotes and a `psql '...'` dashboard copy are the usual two).",
    flag_unset:
      "CORPUS_ENABLED is not set. This is the shipped default; set it to 'true' " +
      "and redeploy to begin recording.",
    flag_not_enabled:
      "CORPUS_ENABLED is set but does not read as true (a stray quote, space or " +
      "capital?). Accepted values: true, 1, yes, on.",
  };

  // eslint-disable-next-line no-console
  console.warn(
    `[barkoba] CORPUS DISABLED — a qualifying game was NOT recorded. ` +
      `reason=${reason}. ${advice[reason]}`
  );
}

/**
 * THE PRESERVATION THRESHOLD (approved: option B).
 *
 * A game enters the corpus once it contains at least one COMPLETED
 * question/answer interaction — a question turn that actually received a
 * Composer answer. Before that a game contains no reasoning path: nothing was
 * asked and answered, so there is nothing for "what was known → what was asked
 * → what answer arrived" to reconstruct.
 *
 * Note what this deliberately does NOT require: completion. A game abandoned
 * after three answered questions is preserved. `complete` and `worth
 * preserving` are different questions and this function only asks the second.
 */
export function hasPreservableEvidence(game: GameRecord): boolean {
  return game.qa_log.some(
    (e) => e.turn_type === "question" && e.composer_response !== null
  );
}

export interface LifecycleView {
  lifecycle_state: string;
  outcome: string | null;
  finalized_at: string | null;
  termination_reason: string | null;
}

/**
 * Lifecycle and outcome are orthogonal, so an unresolved game never has to
 * invent an outcome and a finished game never has to hide its outcome inside a
 * lifecycle enum.
 *
 * Only `complete` is terminal at write time. `resolving` is a legitimate
 * transient state during play — it is reclassified as stalled only by
 * reconciliation, and only after it has stopped changing.
 */
export function deriveLifecycle(game: GameRecord): LifecycleView {
  if (game.phase === "complete") {
    return {
      lifecycle_state: "completed",
      outcome: game.result,
      finalized_at: new Date().toISOString(),
      termination_reason: game.final_action ? `final_action_${game.final_action}` : null,
    };
  }
  return {
    lifecycle_state: "in_progress",
    outcome: null,
    finalized_at: null,
    termination_reason: null,
  };
}

/** Who produced this turn's content. Derived from the seats the record already carries. */
function actorFor(game: GameRecord, entry: QuestionLogEntry): string {
  // A clue is the Composer steering; everything else is the Racer moving.
  if (entry.turn_type === "clue") return `${game.composer_kind}_composer`;
  return `${game.racer_kind}_racer`;
}

interface TurnRow {
  turn_id: string;
  turn_index: number;
  branch: "main" | "abandoned";
  /**
   * V2.5 — which rewind discarded this turn. 1-based, null on the main branch.
   *
   * GameRecord.abandoned_branches is an array of arrays, and this module used
   * to flatten it into one undifferentiated bucket. turn_index legitimately
   * repeats across branches, so with two or more corrections the discarded runs
   * could not be told apart afterwards. occurred_at does not separate them
   * either: an abandoned turn carries its ORIGINAL creation time, not its
   * discard time, so overlapping index ranges interleave.
   */
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
  raw_output: unknown;
  occurred_at: string;
  // --- V2.5 provenance -----------------------------------------------------
  model_id: string | null;
  model_provider: string | null;
  prompt_version: string | null;
  answered_at: string | null;
  pre_revision_question_text: string | null;
}

function toTurnRow(
  game: GameRecord,
  entry: QuestionLogEntry,
  branch: "main" | "abandoned",
  branchSeq: number | null
): TurnRow {
  let raw: unknown = null;
  if (entry.racer_output_raw) {
    // racer_output_raw is a JSON string in every current writer, but it is
    // ultimately model-adjacent text. Preserve it as a JSON string rather than
    // dropping the evidence if it does not parse.
    try {
      raw = JSON.parse(entry.racer_output_raw);
    } catch {
      raw = { unparsed: entry.racer_output_raw };
    }
  }

  return {
    turn_id: entry.id,
    turn_index: entry.turn_index,
    branch,
    branch_seq: branchSeq,
    turn_type: entry.turn_type,
    actor: actorFor(game, entry),
    question_text: entry.question_text,
    guess_text: entry.guess_text,
    clue_text: entry.clue_text,
    composer_response: entry.composer_response,
    ambiguous_explanation: entry.ambiguous_explanation,
    guess_detector_flagged: Boolean(entry.guess_detector_flagged),
    guess_detector_method: entry.guess_detector_method,
    guess_intent_outcome: entry.guess_intent_outcome,
    original_question_text: entry.original_question_text,
    edit_status: entry.edit_status,
    edit_reason: entry.edit_reason,
    raw_output: raw,
    occurred_at: entry.timestamp,
    // V2.5. Null on every turn played before 2.5.0.0 and null forever on those
    // turns — nothing observed them, and inventing a value would be worse than
    // recording none. `?? null` because a record recovered from Redis may
    // predate the field entirely.
    model_id: entry.model_id ?? null,
    model_provider: entry.model_provider ?? null,
    prompt_version: entry.prompt_version ?? null,
    answered_at: entry.answered_at ?? null,
    pre_revision_question_text: entry.pre_revision_question_text ?? null,
  };
}

/**
 * Every turn the record still holds, main branch and abandoned branches alike.
 *
 * Abandoned turns are real evidence: they show what the Racer inferred from an
 * answer later found to be wrong. They are preserved, and they are kept
 * structurally separate so they can never be mistaken for the game as played.
 */
export function buildTurnRows(game: GameRecord): TurnRow[] {
  const main = game.qa_log.map((e) => toTurnRow(game, e, "main", null));
  // V2.5: the ARRAY POSITION is the branch identity. corrections are appended
  // newest-last and so are abandoned_branches, so index i here is the i-th
  // rewind of this game. 1-based, to match turn_index and the corrections log.
  const abandoned = game.abandoned_branches.flatMap((branch, i) =>
    branch.map((e) => toTurnRow(game, e, "abandoned", i + 1))
  );
  return [...abandoned, ...main];
}

/** The most recent activity the record can evidence, for abandonment inference. */
function lastActivityAt(game: GameRecord): string {
  const last = game.qa_log[game.qa_log.length - 1];
  return last?.timestamp ?? game.created_at;
}

// ---------------------------------------------------------------------------
// The write itself.
// ---------------------------------------------------------------------------

/** Postgres array literal, e.g. {1,2}. The HTTP driver sends params as text, so a
 *  raw JS array would arrive as JSON `[1,2]` and fail to cast. */
function pgArray(values: readonly (string | number)[] | null): string | null {
  return values && values.length > 0 ? `{${values.join(",")}}` : null;
}

/**
 * Write a game's entire durable record as ONE atomic transaction.
 *
 * WHY THIS SHAPE — the 2.2.0.2 production defect.
 *
 * This used to be six sequential auto-committing statements. A completed game
 * wrote its `games` row and 16 `game_turns` rows, then stopped: no target row,
 * no resolution row, and a `corpus.games` row permanently claiming
 * `lifecycle_state='completed'`. Anything that interrupts the sequence —
 * a raised statement, or the serverless invocation ending when the player
 * switched away mid-resolve — leaves a half-written record that nothing
 * detects and nothing repairs.
 *
 * HOW THE PARENT ID IS RESOLVED WITHOUT `RETURNING`.
 *
 * `sql.transaction()` is NON-INTERACTIVE: it takes a static array, so a value
 * returned by one statement cannot be fed to the next. Every child statement
 * therefore looks the parent up by the operational id, which is UNIQUE:
 *
 *     (SELECT corpus_game_id FROM corpus.games WHERE operational_game_id = $1)
 *
 * That is safe because the statements run in order, in one transaction, on one
 * session — so the upsert at index 0 is visible to every statement after it.
 * Migration 0001 already proved both properties against live Neon: it applied
 * 26 statements in one transaction where `CREATE INDEX` depended on a table
 * created two statements earlier and `CREATE TRIGGER` on a function created
 * two statements before that.
 *
 * The subquery yields NULL if the parent is somehow absent, which violates the
 * child's NOT NULL and rolls the whole transaction back — failing loudly and
 * atomically rather than writing another partial record.
 */
async function syncGame(sql: SqlClient, game: GameRecord): Promise<void> {
  const life = deriveLifecycle(game);
  const version = getAppVersion();
  const turns = buildTurnRows(game);
  const statements: Promise<Record<string, unknown>[]>[] = [];

  // Index 0. Every statement below resolves its parent through this row.
  statements.push(sql`
    INSERT INTO corpus.games (
      operational_game_id, player_id, composer_player_id, racer_player_id,
      app_version, commit_sha,
      composer_kind, racer_kind, difficulty, clue_mode, game_language,
      max_questions, private_target,
      lifecycle_state, outcome, termination_reason, last_phase,
      question_count, ambiguous_count,
      created_at, last_activity_at, finalized_at, collection_context,
      benchmark_case_id, benchmark_run_id
    ) VALUES (
      ${game.game_id}, ${game.player_id},
      ${game.composer_player_id}, ${game.racer_player_id},
      ${version.version}, ${version.commit},
      ${game.composer_kind}, ${game.racer_kind}, ${game.difficulty}, ${game.clue_mode},
      ${game.game_language}, ${game.max_questions}, ${game.private_target},
      ${life.lifecycle_state}, ${life.outcome}, ${life.termination_reason}, ${game.phase},
      ${game.question_count}, ${game.ambiguous_count},
      ${game.created_at}, ${lastActivityAt(game)}, ${life.finalized_at},
      ${env.collectionContext()},
      ${game.benchmark_case_id}, ${game.benchmark_run_id}
    )
    -- V2.5: the two benchmark columns are ABSENT from this set-list on purpose.
    -- They are settled at creation and never change, and corpus.games is
    -- immutable once finalized — a re-sync that tried to rewrite them would
    -- raise and roll back the whole transaction, taking the repair pass with it.
    ON CONFLICT (operational_game_id) DO UPDATE SET
      player_id          = EXCLUDED.player_id,
      composer_player_id = EXCLUDED.composer_player_id,
      -- The Racer seat fills mid-game, after the first sync, so this must be
      -- part of the update and not only the insert.
      racer_player_id    = EXCLUDED.racer_player_id,
      lifecycle_state    = EXCLUDED.lifecycle_state,
      outcome            = EXCLUDED.outcome,
      termination_reason = EXCLUDED.termination_reason,
      last_phase         = EXCLUDED.last_phase,
      question_count     = EXCLUDED.question_count,
      ambiguous_count    = EXCLUDED.ambiguous_count,
      last_activity_at   = EXCLUDED.last_activity_at,
      -- finalized_at is write-once: a retried resolve must not move the moment
      -- the game became history.
      finalized_at       = COALESCE(corpus.games.finalized_at, EXCLUDED.finalized_at)
  `);

  if (turns.length > 0) {
    // Demote rewound turns FIRST, as their own statement. The partial unique
    // index on (corpus_game_id, turn_index) WHERE branch='main' means a new
    // main turn cannot be inserted at an index an old main turn still occupies.
    //
    // Ordered array position is what guarantees this. It is also why a
    // data-modifying CTE was rejected as the alternative design: CTEs all see
    // the same snapshot and their side-effect order is unspecified, so
    // demote-before-upsert could not be expressed at all.
    //
    // V2.5-B5 — THIS STATEMENT ALSO CARRIES branch_seq, AND HAS TO.
    //
    // It used to set `branch` alone, over `turn_id = ANY(array)`. That shape
    // cannot express branch_seq at all: every turn in the batch needs its OWN
    // sequence number, and one array update has one value for all of them.
    // Combined with branch_seq being absent from the upsert's DO UPDATE below,
    // the column could never be written for a turn that already existed — which
    // is every abandoned turn, since a turn is only demoted after it was
    // recorded as main. Production confirmed it: 6 abandoned turns, 6 nulls.
    //
    // A per-turn join fixes both halves. COALESCE keeps it write-once: an
    // already-numbered branch is never renumbered by a later re-sync.
    const abandoned = turns.filter((t) => t.branch === "abandoned");
    if (abandoned.length > 0) {
      statements.push(sql`
        UPDATE corpus.game_turns AS g
           SET branch = 'abandoned',
               branch_seq = COALESCE(g.branch_seq, d.branch_seq)
          FROM jsonb_to_recordset(${JSON.stringify(
            abandoned.map((t) => ({ turn_id: t.turn_id, branch_seq: t.branch_seq }))
          )}::jsonb) AS d(turn_id uuid, branch_seq integer)
         WHERE g.turn_id = d.turn_id
           AND g.corpus_game_id =
                 (SELECT corpus_game_id FROM corpus.games
                   WHERE operational_game_id = ${game.game_id}::uuid)
      `);
    }

    // jsonb_to_recordset rather than a constructed multi-row VALUES list: one
    // bound parameter, explicit column types, and no string building anywhere
    // near user text.
    statements.push(sql`
      INSERT INTO corpus.game_turns (
        turn_id, corpus_game_id, turn_index, branch, branch_seq, turn_type, actor,
        question_text, guess_text, clue_text, composer_response,
        ambiguous_explanation, guess_detector_flagged, guess_detector_method,
        guess_intent_outcome, original_question_text, edit_status, edit_reason,
        raw_output, occurred_at,
        model_id, model_provider, prompt_version, answered_at,
        pre_revision_question_text
      )
      SELECT
        t.turn_id,
        (SELECT corpus_game_id FROM corpus.games
          WHERE operational_game_id = ${game.game_id}::uuid),
        t.turn_index, t.branch, t.branch_seq, t.turn_type, t.actor,
        t.question_text, t.guess_text, t.clue_text, t.composer_response,
        t.ambiguous_explanation, t.guess_detector_flagged, t.guess_detector_method,
        t.guess_intent_outcome, t.original_question_text, t.edit_status, t.edit_reason,
        t.raw_output, t.occurred_at,
        t.model_id, t.model_provider, t.prompt_version, t.answered_at,
        t.pre_revision_question_text
      FROM jsonb_to_recordset(${JSON.stringify(turns)}::jsonb) AS t(
        turn_id uuid, turn_index integer, branch text, branch_seq integer,
        turn_type text, actor text,
        question_text text, guess_text text, clue_text text, composer_response text,
        ambiguous_explanation text, guess_detector_flagged boolean,
        guess_detector_method text, guess_intent_outcome text,
        original_question_text text, edit_status text, edit_reason text,
        raw_output jsonb, occurred_at timestamptz,
        model_id text, model_provider text, prompt_version text,
        answered_at timestamptz, pre_revision_question_text text
      )
      -- ---------------------------------------------------------------------
      -- V2.5-B5: TWO KINDS OF COLUMN, AND THE DIFFERENCE IS WHEN THE VALUE IS
      -- KNOWN — not whether it is new.
      --
      -- reject_finalized_turn_mutation (0002) permits a no-op re-sync of a
      -- finalized game's turns and raises on any real change. That produces the
      -- rule:
      --
      --   INSERT-ONLY — model_id, model_provider, prompt_version,
      --   pre_revision_question_text. All are known when the row is created,
      --   and the first two can legitimately DIFFER on a later re-sync (the env
      --   override may have moved, the prompt version may have been bumped).
      --   Updating them would raise and roll back the whole transaction,
      --   including the repair pass that re-sync exists for. COALESCE would be
      --   wrong here even if it were safe: writing today's model id onto a turn
      --   played before capture existed asserts a fact nobody observed.
      --
      --   WRITE-ONCE-LATER — answered_at, branch_seq. Neither is knowable when
      --   the row is inserted. answered_at arrives on the NEXT request;
      --   branch_seq is assigned when a rewind happens. V2.5-3 swept both into
      --   the insert-only rule and they were therefore never written at all —
      --   production showed answered_at on turn 1 only (an artefact of the
      --   preservation threshold) and branch_seq null on 6 of 6 abandoned turns.
      --
      -- COALESCE gives write-once: null becomes a value exactly once and never
      -- changes, so a re-sync is a genuine no-op and the trigger passes. Both
      -- fields are only ever set while the game is still in the questioning
      -- phase, so the
      -- transition always lands before finalization, while the trigger is
      -- dormant. This is the same pattern corpus.games already uses for
      -- finalized_at above — not a new idea, one that was applied too narrowly.
      --
      -- ACCEPTED, BOUNDED RISK: a game finalized BEFORE this change, still in
      -- Redis (<24h), re-synced AFTER it, would have its nulls filled on a
      -- finalized row and raise. Non-destructive — nothing is written, the
      -- failure is logged, the record is unharmed — and the window self-clears
      -- with the Redis TTL. Chosen over permanently complicating this
      -- statement with a not-finalized guard.
      -- ---------------------------------------------------------------------
      ON CONFLICT (turn_id) DO UPDATE SET
        branch                 = EXCLUDED.branch,
        question_text          = EXCLUDED.question_text,
        composer_response      = EXCLUDED.composer_response,
        ambiguous_explanation  = EXCLUDED.ambiguous_explanation,
        original_question_text = EXCLUDED.original_question_text,
        edit_status            = EXCLUDED.edit_status,
        edit_reason            = EXCLUDED.edit_reason,
        raw_output             = EXCLUDED.raw_output,
        answered_at            = COALESCE(corpus.game_turns.answered_at, EXCLUDED.answered_at),
        branch_seq             = COALESCE(corpus.game_turns.branch_seq, EXCLUDED.branch_seq)
    `);
  }

  if (game.corrections.length > 0) {
    statements.push(sql`
      INSERT INTO corpus.game_corrections (
        corpus_game_id, turn_index, from_answer, to_answer, discarded_turns, occurred_at
      )
      SELECT (SELECT corpus_game_id FROM corpus.games
               WHERE operational_game_id = ${game.game_id}::uuid),
             c.turn_index, c.from_answer, c.to_answer,
             c.discarded_turns, c.occurred_at
      FROM jsonb_to_recordset(${JSON.stringify(
        game.corrections.map((c) => ({
          turn_index: c.turn_index,
          from_answer: c.from,
          to_answer: c.to,
          discarded_turns: c.discarded_turns,
          occurred_at: c.at,
        }))
      )}::jsonb) AS c(
        turn_index integer, from_answer text, to_answer text,
        discarded_turns integer, occurred_at timestamptz
      )
      ON CONFLICT ON CONSTRAINT game_corrections_identity DO NOTHING
    `);
  }

  // Target metadata exists only once the game legitimately declassified it.
  if (game.revealed_target) {
    statements.push(sql`
      INSERT INTO corpus.game_targets (
        corpus_game_id, target, definition, granularity, modifiers, locked_at
      )
      SELECT (SELECT corpus_game_id FROM corpus.games
               WHERE operational_game_id = ${game.game_id}::uuid),
             ${game.revealed_target}, ${game.revealed_definition},
             ${game.revealed_granularity}, ${game.revealed_modifiers},
             ${game.revealed_locked_at}::timestamptz
      ON CONFLICT (corpus_game_id) DO NOTHING
    `);
  }

  if (game.phase === "complete") {
    statements.push(sql`
      INSERT INTO corpus.game_resolutions (
        corpus_game_id, final_action, final_guess_text,
        adjudicator_verdict, adjudicator_confidence, adjudication_notes,
        integrity_verdict, integrity_notes, integrity_flagged_turns, resolved_at
      )
      SELECT (SELECT corpus_game_id FROM corpus.games
               WHERE operational_game_id = ${game.game_id}::uuid),
             ${game.final_action}, ${game.final_guess_text},
             ${game.adjudicator_verdict}, ${game.adjudication_confidence},
             ${game.adjudication_notes}, ${game.integrity_verdict}, ${game.integrity_notes},
             ${pgArray(game.integrity_flagged_turns)}::integer[],
             ${new Date().toISOString()}::timestamptz
      ON CONFLICT (corpus_game_id) DO NOTHING
    `);
  }

  // ONE transaction. Either the whole record lands or none of it does.
  await sql.transaction(statements);
}

/**
 * Make the durable record match this GameRecord.
 *
 * FULL-STATE SYNC rather than per-turn deltas, on purpose. The engine mutates
 * turns in place — an accepted question edit rewrites question_text and
 * composer_response on an existing entry, and a rewind moves turns to another
 * branch. A delta writer would have to know which of those happened; a
 * full-state sync simply cannot get it wrong, and idempotency makes replaying
 * it free. The cost is re-sending the transcript on each save, which is
 * negligible at any volume the daily model-call ceiling permits.
 *
 * NEVER THROWS.
 */
export async function recordGameState(game: GameRecord): Promise<CorpusOutcome> {
  const qualifies = hasPreservableEvidence(game);
  const status = corpusConfigStatus();

  if (!status.configured) {
    // THE SIGNAL THAT WAS MISSING ON 2.2.0.0.
    //
    // A game containing real evidence just went unrecorded. Previously this
    // path returned silently, so the only externally visible symptom was an
    // empty corpus table with nothing anywhere to explain it. Now it says so,
    // once per runtime instance — once, because a 20-question game would
    // otherwise print this twenty times and turn a signal into noise.
    if (qualifies) warnGatedOnce(status.reason);
    return "disabled";
  }
  if (!qualifies) return "below_threshold";

  try {
    // getSql() MUST be inside this try. neon() throws when the connection
    // string is malformed — quotes kept from a copy-paste, a `psql '...'`
    // dashboard prefix, a missing username. On 2.2.0.1 that throw escaped
    // recordGameState entirely: it landed in saveGame's last-resort catch, so
    // the game was never queued for replay and the evidence became
    // unrecoverable rather than merely delayed. A connection failure is a
    // corpus write failure and has to be handled like one.
    const sql = getSql();
    if (!sql) return "disabled";

    await syncGame(sql, game);
    // Clearing a prior deferral is best-effort: if it fails the worst outcome
    // is one redundant, idempotent replay later.
    await removePending(game.game_id).catch(() => undefined);
    return "written";
  } catch (err) {
    // Covers both failure modes: could not connect, and could not write. The
    // searchable token stays "corpus write failed" so existing runbooks hold.
    // eslint-disable-next-line no-console
    console.error(`[barkoba] corpus write failed for ${game.game_id}:`, err);
    try {
      await enqueuePending(game.game_id);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[barkoba] corpus: could not queue game for replay:", game.game_id);
    }
    return "deferred";
  }
}

/**
 * Player deletion — INTERIM PRE-PUBLIC POLICY.
 *
 * Detaches every preserved game from a Player by setting player_id to NULL. The
 * games themselves survive as research evidence.
 *
 * THIS IS NOT ANONYMIZATION AND MUST NOT BE DESCRIBED AS SUCH. The questions,
 * guesses and targets are the player's own free text and can carry personal
 * information with no identifier attached to it — Barkóba's own field
 * benchmarks are "my left ear" and "MuShu, one specific dog". Unlinking removes
 * the pointer, not the content. /privacy says exactly this, in those terms.
 *
 * The permanent public erasure model is deliberately NOT decided here. The
 * schema keeps stronger semantics available: cascade deletion already works via
 * ON DELETE CASCADE, and pseudonymization would be a column change, not a
 * redesign.
 *
 * player_id is one of only two fields the immutability trigger lets through on
 * a finalized game — erasure has to remain possible on finished evidence, or
 * deletion would be a promise the schema forbids keeping.
 *
 * NEVER THROWS. Identity deletion must succeed even when the corpus is down.
 */
export async function unlinkPlayer(playerId: string): Promise<number | null> {
  if (!isCorpusConfigured()) return null;
  const sql = getSql();
  if (!sql) return null;

  try {
    // V2.3: all THREE id columns, together. Clearing only player_id would leave
    // an erased player still linked as Composer or Racer — deletion would be a
    // promise the schema quietly broke.
    const rows = await sql`
      UPDATE corpus.games
         SET player_id          = CASE WHEN player_id          = ${playerId} THEN NULL ELSE player_id          END,
             composer_player_id = CASE WHEN composer_player_id = ${playerId} THEN NULL ELSE composer_player_id END,
             racer_player_id    = CASE WHEN racer_player_id    = ${playerId} THEN NULL ELSE racer_player_id    END
       WHERE player_id = ${playerId}
          OR composer_player_id = ${playerId}
          OR racer_player_id = ${playerId}
       RETURNING corpus_game_id
    `;

    // V2.6: contests carry their own linkage and must be cleared by the SAME
    // call. A contest is filed against a game the player may no longer be
    // linked to, so the game sweep above cannot reach it — and a deletion that
    // left a player_id sitting on a contest row would be the exact failure
    // migration 0003 widened its trigger to prevent for the seat columns:
    // the request appears to succeed and the link survives.
    //
    // Best-effort and separately caught. The contest table is newer than the
    // erasure guarantee, and a failure here must not roll back the unlink that
    // already succeeded — a partial erasure is strictly better than none, and
    // it is logged loudly rather than swallowed.
    try {
      await unlinkPlayerContests(sql, playerId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[barkoba] corpus: games unlinked for player ${playerId} but CONTEST unlink failed:`,
        err
      );
    }

    return rows.length;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] corpus unlink failed for player ${playerId}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Player-facing game history.
//
// Read-only, and scoped by construction: it takes exactly one player_id and
// the WHERE clause is that same literal, so this can never return another
// player's games. Uses games_player_history — the partial index migration
// 0001 already built for exactly this query, unused until now.
//
// NEVER THROWS, matching every other function in this module. A read failure
// returns null; the caller (the route) is the one place that turns that into
// an HTTP response.
// ---------------------------------------------------------------------------

const PLAYER_HISTORY_LIMIT = 100;

export interface PlayerHistoryEntry {
  game_id: string;
  created_at: string;
  lifecycle_state: string;
  outcome: string | null;
  /**
   * Which seat this player occupied. Exact for every game recorded since
   * migration 0003 via composer_player_id/racer_player_id. Pre-V2.3 rows
   * never had those columns populated, so they fall back to the
   * single-human-seat convention those games always followed
   * (composer_kind/racer_kind never both "human" before Human-vs-Human
   * existed). Null only if neither can determine it.
   */
  role: "composer" | "racer" | null;
}

export async function listPlayerHistory(playerId: string): Promise<PlayerHistoryEntry[] | null> {
  if (!isCorpusConfigured()) return null;
  const sql = getSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT operational_game_id, created_at, lifecycle_state, outcome,
             composer_player_id, racer_player_id, composer_kind, racer_kind
        FROM corpus.games
       WHERE player_id = ${playerId}
       ORDER BY created_at DESC
       LIMIT ${PLAYER_HISTORY_LIMIT}
    `;

    return rows.map((row) => {
      let role: "composer" | "racer" | null = null;
      if (row.composer_player_id === playerId) role = "composer";
      else if (row.racer_player_id === playerId) role = "racer";
      else if (row.composer_player_id === null && row.racer_player_id === null) {
        if (row.composer_kind === "human" && row.racer_kind !== "human") role = "composer";
        else if (row.racer_kind === "human" && row.composer_kind !== "human") role = "racer";
      }
      return {
        game_id: String(row.operational_game_id),
        created_at:
          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        lifecycle_state: String(row.lifecycle_state),
        outcome: typeof row.outcome === "string" ? row.outcome : null,
        role,
      };
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] corpus: player history read failed for ${playerId}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Opportunistic reconciliation.
//
// Two jobs, neither of which needs a scheduler and neither of which may ever
// delay a player:
//
//   1. REPLAY — retry games whose corpus write failed, while Redis still holds
//      the authoritative record. This is what turns a Neon outage into delayed
//      evidence rather than lost evidence.
//   2. SWEEP — reclassify games that stopped changing. Pure SQL, no Redis read:
//      a row still 'in_progress' long after its last activity was abandoned or
//      stalled, and last_phase says honestly which.
//
// Deliberately NOT a job queue and deliberately not Vercel Cron. The trade-off
// is that reconciliation only happens when someone starts a game — acceptable
// while Barkóba is played daily, and the obvious upgrade path is a scheduled
// caller of this same function.
// ---------------------------------------------------------------------------

export interface ReconcileReport {
  replayed: number;
  droppedExpired: number;
  swept: number;
  /** Partial historical records completed from the still-live Redis game. */
  repaired: number;
  /** Detected as partial but no longer repairable — Redis has expired them. */
  unrepairable: number;
}

/**
 * THE COMPLETENESS INVARIANT.
 *
 * A game recorded as `completed` must also have a resolution row, and — because
 * resolving is exactly the moment the target is declassified — a target row.
 * Both are written by the same sync as the parent, so a `completed` parent
 * without them means the write was interrupted partway.
 *
 * That state is impossible by intent and perfectly legal by schema. Nothing
 * detected it until a manual COUNT(*) found one in production: 1 game, 16
 * turns, 0 targets, 0 resolutions, lifecycle 'completed'. The sweep could never
 * have found it either, because the sweep only looks at 'in_progress' rows.
 *
 * Returns the OPERATIONAL ids, because that is what Redis is keyed by and
 * repair means re-syncing from the live game.
 */
const INCOMPLETE_LIMIT = 20;

/**
 * `loadGame` is injected rather than imported so this module never depends on
 * gameStore — which keeps the corpus a leaf of the dependency graph and keeps
 * the isolation checker's job simple.
 *
 * NEVER THROWS.
 */
export async function reconcileOpportunistically(
  loadGame: (id: string) => Promise<GameRecord | null>
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    replayed: 0,
    droppedExpired: 0,
    swept: 0,
    repaired: 0,
    unrepairable: 0,
  };
  if (!isCorpusConfigured()) return report;

  // Same reasoning as recordGameState: neon() can throw on a malformed
  // connection string, and reconciliation must degrade quietly rather than
  // propagate into the request that triggered it.
  let sql: SqlClient | null;
  try {
    sql = getSql();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] corpus reconcile: could not create a client:", err);
    return report;
  }
  if (!sql) return report;

  try {
    const batch = await claimBatch(env.corpusReconcileBatch());
    for (const gameId of batch) {
      const game = await loadGame(gameId).catch(() => null);
      if (!game) {
        // Redis no longer has it. Retrying forever would be a slow leak, and
        // there is nothing left to replay from.
        await removePending(gameId).catch(() => undefined);
        report.droppedExpired += 1;
        continue;
      }
      const outcome = await recordGameState(game);
      if (outcome === "written") report.replayed += 1;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] corpus replay pass failed:", err);
  }

  try {
    const staleSeconds = env.gameTtlSeconds();
    const swept = await sql`
      UPDATE corpus.games
         SET lifecycle_state = CASE
               WHEN last_phase = 'resolving' THEN 'stalled_resolving'
               ELSE 'abandoned_inferred'
             END,
             termination_reason = COALESCE(termination_reason, 'no_activity_before_state_expiry')
       WHERE lifecycle_state = 'in_progress'
         AND finalized_at IS NULL
         AND last_activity_at < now() - make_interval(secs => ${staleSeconds})
       RETURNING corpus_game_id
    `;
    report.swept = swept.length;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] corpus sweep failed:", err);
  }

  // -------------------------------------------------------------------------
  // REPAIR PASS — complete partial historical records.
  //
  // Runs after replay and sweep because it is the only pass that can fix a
  // record already marked 'completed'. Re-syncing is safe and idempotent: the
  // parent upsert is a no-op, turns re-write identically (permitted since
  // migration 0002), and the missing target and resolution rows are inserted.
  // -------------------------------------------------------------------------
  try {
    const incomplete = await sql`
      SELECT g.operational_game_id
        FROM corpus.games g
        LEFT JOIN corpus.game_resolutions r USING (corpus_game_id)
        LEFT JOIN corpus.game_targets     t USING (corpus_game_id)
       WHERE g.lifecycle_state = 'completed'
         AND (r.corpus_game_id IS NULL OR t.corpus_game_id IS NULL)
       ORDER BY g.finalized_at DESC
       LIMIT ${INCOMPLETE_LIMIT}
    `;

    for (const row of incomplete) {
      const operationalId = String(row.operational_game_id);
      const live = await loadGame(operationalId).catch(() => null);

      if (!live) {
        // Redis has expired the source. The record stays partial and stays
        // visible to this query, which is the honest outcome: it is counted,
        // not hidden, and never silently "fixed" with invented data.
        report.unrepairable += 1;
        continue;
      }

      const outcome = await recordGameState(live);
      if (outcome === "written") {
        report.repaired += 1;
        // eslint-disable-next-line no-console
        console.warn(`[barkoba] corpus: repaired partial record for ${operationalId}`);
      }
    }

    if (report.unrepairable > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[barkoba] corpus: ${report.unrepairable} partial record(s) can no longer be ` +
          `repaired — the source game has left Redis. They remain queryable as ` +
          `completed games missing a resolution or target row.`
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] corpus repair pass failed:", err);
  }

  return report;
}
