import { getSql, isCorpusConfigured, type SqlClient } from "./db";
import { enqueuePending, claimBatch, removePending } from "./pendingQueue";
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
}

function toTurnRow(
  game: GameRecord,
  entry: QuestionLogEntry,
  branch: "main" | "abandoned"
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
  const main = game.qa_log.map((e) => toTurnRow(game, e, "main"));
  const abandoned = game.abandoned_branches.flatMap((branch) =>
    branch.map((e) => toTurnRow(game, e, "abandoned"))
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

async function syncGame(sql: SqlClient, game: GameRecord): Promise<void> {
  const life = deriveLifecycle(game);
  const version = getAppVersion();

  const rows = await sql`
    INSERT INTO corpus.games (
      operational_game_id, player_id, app_version, commit_sha,
      composer_kind, racer_kind, difficulty, clue_mode, game_language,
      max_questions, private_target,
      lifecycle_state, outcome, termination_reason, last_phase,
      question_count, ambiguous_count,
      created_at, last_activity_at, finalized_at, collection_context
    ) VALUES (
      ${game.game_id}, ${game.player_id}, ${version.version}, ${version.commit},
      ${game.composer_kind}, ${game.racer_kind}, ${game.difficulty}, ${game.clue_mode},
      ${game.game_language}, ${game.max_questions}, ${game.private_target},
      ${life.lifecycle_state}, ${life.outcome}, ${life.termination_reason}, ${game.phase},
      ${game.question_count}, ${game.ambiguous_count},
      ${game.created_at}, ${lastActivityAt(game)}, ${life.finalized_at},
      ${env.collectionContext()}
    )
    ON CONFLICT (operational_game_id) DO UPDATE SET
      player_id          = EXCLUDED.player_id,
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
    RETURNING corpus_game_id
  `;

  const corpusGameId = rows[0]?.corpus_game_id as string | undefined;
  if (!corpusGameId) throw new Error("corpus: games upsert returned no id");

  const turns = buildTurnRows(game);

  if (turns.length > 0) {
    // Demote rewound turns FIRST, as their own statement. The partial unique
    // index on (corpus_game_id, turn_index) WHERE branch='main' means a new
    // main turn cannot be inserted at an index an old main turn still occupies.
    // Doing this in one combined statement would depend on row processing order
    // inside ON CONFLICT, which is not a guarantee worth relying on.
    const abandonedIds = turns.filter((t) => t.branch === "abandoned").map((t) => t.turn_id);
    if (abandonedIds.length > 0) {
      await sql`
        UPDATE corpus.game_turns SET branch = 'abandoned'
        WHERE corpus_game_id = ${corpusGameId}
          AND turn_id = ANY(${abandonedIds}::uuid[])
      `;
    }

    // One round trip for every turn. jsonb_to_recordset rather than a
    // constructed multi-row VALUES list: one bound parameter, explicit column
    // types, and no string building anywhere near user text.
    await sql`
      INSERT INTO corpus.game_turns (
        turn_id, corpus_game_id, turn_index, branch, turn_type, actor,
        question_text, guess_text, clue_text, composer_response,
        ambiguous_explanation, guess_detector_flagged, guess_detector_method,
        guess_intent_outcome, original_question_text, edit_status, edit_reason,
        raw_output, occurred_at
      )
      SELECT
        t.turn_id, ${corpusGameId}::uuid, t.turn_index, t.branch, t.turn_type, t.actor,
        t.question_text, t.guess_text, t.clue_text, t.composer_response,
        t.ambiguous_explanation, t.guess_detector_flagged, t.guess_detector_method,
        t.guess_intent_outcome, t.original_question_text, t.edit_status, t.edit_reason,
        t.raw_output, t.occurred_at
      FROM jsonb_to_recordset(${JSON.stringify(turns)}::jsonb) AS t(
        turn_id uuid, turn_index integer, branch text, turn_type text, actor text,
        question_text text, guess_text text, clue_text text, composer_response text,
        ambiguous_explanation text, guess_detector_flagged boolean,
        guess_detector_method text, guess_intent_outcome text,
        original_question_text text, edit_status text, edit_reason text,
        raw_output jsonb, occurred_at timestamptz
      )
      ON CONFLICT (turn_id) DO UPDATE SET
        branch                 = EXCLUDED.branch,
        question_text          = EXCLUDED.question_text,
        composer_response      = EXCLUDED.composer_response,
        ambiguous_explanation  = EXCLUDED.ambiguous_explanation,
        original_question_text = EXCLUDED.original_question_text,
        edit_status            = EXCLUDED.edit_status,
        edit_reason            = EXCLUDED.edit_reason,
        raw_output             = EXCLUDED.raw_output
    `;
  }

  if (game.corrections.length > 0) {
    await sql`
      INSERT INTO corpus.game_corrections (
        corpus_game_id, turn_index, from_answer, to_answer, discarded_turns, occurred_at
      )
      SELECT ${corpusGameId}::uuid, c.turn_index, c.from_answer, c.to_answer,
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
    `;
  }

  // Target metadata exists only once the game legitimately declassified it.
  if (game.revealed_target) {
    await sql`
      INSERT INTO corpus.game_targets (
        corpus_game_id, target, definition, granularity, modifiers, locked_at
      ) VALUES (
        ${corpusGameId}, ${game.revealed_target}, ${game.revealed_definition},
        ${game.revealed_granularity}, ${game.revealed_modifiers}, ${game.revealed_locked_at}
      )
      ON CONFLICT (corpus_game_id) DO NOTHING
    `;
  }

  if (game.phase === "complete") {
    await sql`
      INSERT INTO corpus.game_resolutions (
        corpus_game_id, final_action, final_guess_text,
        adjudicator_verdict, adjudicator_confidence, adjudication_notes,
        integrity_verdict, integrity_notes, integrity_flagged_turns, resolved_at
      ) VALUES (
        ${corpusGameId}, ${game.final_action}, ${game.final_guess_text},
        ${game.adjudicator_verdict}, ${game.adjudication_confidence},
        ${game.adjudication_notes}, ${game.integrity_verdict}, ${game.integrity_notes},
        ${game.integrity_flagged_turns}, ${new Date().toISOString()}
      )
      ON CONFLICT (corpus_game_id) DO NOTHING
    `;
  }
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
  if (!isCorpusConfigured()) return "disabled";
  if (!hasPreservableEvidence(game)) return "below_threshold";

  const sql = getSql();
  if (!sql) return "disabled";

  try {
    await syncGame(sql, game);
    // Clearing a prior deferral is best-effort: if it fails the worst outcome
    // is one redundant, idempotent replay later.
    await removePending(game.game_id).catch(() => undefined);
    return "written";
  } catch (err) {
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
    const rows = await sql`
      UPDATE corpus.games SET player_id = NULL
       WHERE player_id = ${playerId}
       RETURNING corpus_game_id
    `;
    return rows.length;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] corpus unlink failed for player ${playerId}:`, err);
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
}

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
  const report: ReconcileReport = { replayed: 0, droppedExpired: 0, swept: 0 };
  if (!isCorpusConfigured()) return report;

  const sql = getSql();
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

  return report;
}
