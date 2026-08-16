import { randomUUID } from "crypto";
import { getKV } from "./kv";
import { env } from "./env";
import { recordGameState } from "./corpus/gameCorpus";
import type { GameRecord, QuestionLogEntry } from "./types";

// ---------------------------------------------------------------------------
// Public game state only. This module has no import of secretStore.ts and
// must never gain one — that's what makes it safe for the Racer-facing API
// route to read freely.
// ---------------------------------------------------------------------------

function gameKey(gameId: string): string {
  return `state:${gameId}`;
}

export async function createGame(
  gameId: string,
  overrides: Partial<GameRecord> = {}
): Promise<GameRecord> {
  const now = new Date();
  const expires = new Date(now.getTime() + env.gameTtlSeconds() * 1000);

  const record: GameRecord = {
    game_id: gameId,
    player_id: null,
    composer_player_id: null,
    racer_player_id: null,
    join_code: null,
    phase: "pending_validation",
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    max_questions: env.maxQuestions(),
    game_language: "en",
    private_target: false,
    // 0.3.x = Human Composer vs AI Racer. Hardcoded on purpose: this records
    // the configuration, it does not select it. No code branches on these.
    composer_kind: "human",
    racer_kind: "ai",
    difficulty: null,
    clue_mode: null,
    question_count: 0,
    ambiguous_count: 0,
    qa_log: [],
    final_action: null,
    final_guess_text: null,
    result: null,
    integrity_notes: null,
    integrity_flagged_turns: null,
    adjudication_notes: null,
    adjudicator_verdict: null,
    integrity_verdict: null,
    adjudication_confidence: null,
    revealed_target: null,
    revealed_definition: null,
    revealed_granularity: null,
    revealed_modifiers: null,
    revealed_locked_at: null,
    corrections: [],
    abandoned_branches: [],
    clarification_prompt: null,
    // V2.5 — null unless /api/game/create accepted a secret-gated benchmark
    // header. Ordinary play never sets these.
    benchmark_case_id: null,
    benchmark_run_id: null,
    ...overrides,
  };

  await getKV().set(gameKey(gameId), record, env.gameTtlSeconds());
  return record;
}

export async function getGame(gameId: string): Promise<GameRecord | null> {
  const record = await getKV().get<GameRecord>(gameKey(gameId));
  if (!record) return null;
  // ambiguous_count was added in M3. Records created before it exist for up to
  // GAME_TTL_SECONDS, so normalize rather than trusting the field is present.
  if (typeof record.ambiguous_count !== "number") {
    record.ambiguous_count = 0;
  }
  // game_language was added in M3; pre-M3 records default to English.
  if (record.game_language !== "hu" && record.game_language !== "en") {
    record.game_language = "en";
  }
  // Resolution fields; older records live for up to GAME_TTL_SECONDS.
  if (record.integrity_flagged_turns === undefined) record.integrity_flagged_turns = null;
  if (record.adjudication_notes === undefined) record.adjudication_notes = null;
  if (record.revealed_target === undefined) record.revealed_target = null;
  // V2.2 resolution/declassification fields. Games created before 2.2.0.0 live
  // for up to GAME_TTL_SECONDS, so normalize rather than trust their presence.
  if (record.adjudicator_verdict === undefined) record.adjudicator_verdict = null;
  if (record.integrity_verdict === undefined) record.integrity_verdict = null;
  if (record.adjudication_confidence === undefined) record.adjudication_confidence = null;
  if (record.revealed_definition === undefined) record.revealed_definition = null;
  if (record.revealed_granularity === undefined) record.revealed_granularity = null;
  if (record.revealed_modifiers === undefined) record.revealed_modifiers = null;
  if (record.revealed_locked_at === undefined) record.revealed_locked_at = null;
  // Correction/rewind fields, added in 0.3.2.0.
  if (typeof record.private_target !== "boolean") record.private_target = false;
  if (record.player_id === undefined) record.player_id = null;
  // V2.3 seats. Games created before 2.3.0.0 live for up to GAME_TTL_SECONDS,
  // so normalize rather than trust their presence.
  if (record.composer_player_id === undefined) record.composer_player_id = null;
  if (record.racer_player_id === undefined) record.racer_player_id = null;
  if (record.join_code === undefined) record.join_code = null;
  if (record.difficulty === undefined) record.difficulty = null;
  if (record.clue_mode === undefined) record.clue_mode = null;
  if (!Array.isArray(record.corrections)) record.corrections = [];
  if (!Array.isArray(record.abandoned_branches)) record.abandoned_branches = [];
  // V2.5 benchmark identity. Games created before 2.5.0.0 live for up to
  // GAME_TTL_SECONDS, so normalize rather than trust their presence.
  if (record.benchmark_case_id === undefined) record.benchmark_case_id = null;
  if (record.benchmark_run_id === undefined) record.benchmark_run_id = null;
  // V2.5 per-turn provenance. Same TTL window, same reasoning — and note this
  // repairs the SHAPE only. A turn played before 2.5.0.0 had no provenance
  // observed, so it stays null forever. Filling it in from today's config
  // would be inventing evidence.
  // Abandoned branches are included: they are written to the corpus too, so a
  // missing field there would reach the writer exactly as one on the main log.
  for (const entry of [...(record.qa_log ?? []), ...(record.abandoned_branches ?? []).flat()]) {
    if (entry.model_id === undefined) entry.model_id = null;
    if (entry.model_provider === undefined) entry.model_provider = null;
    if (entry.prompt_version === undefined) entry.prompt_version = null;
    if (entry.answered_at === undefined) entry.answered_at = null;
    if (entry.pre_revision_question_text === undefined) {
      entry.pre_revision_question_text = null;
    }
  }
  // Participant kinds, added in 0.3.0.1. Every pre-existing game was
  // human-vs-AI, so that is the only correct backfill.
  if (record.composer_kind !== "human" && record.composer_kind !== "ai") {
    record.composer_kind = "human";
  }
  if (record.racer_kind !== "human" && record.racer_kind !== "ai") {
    record.racer_kind = "ai";
  }
  return record;
}

/**
 * Persist live game state — and, from V2.2, mirror it into the durable corpus.
 *
 * WHY THE CORPUS HOOK LIVES HERE RATHER THAN IN SIX ROUTE HANDLERS.
 *
 * Every turn-producing, correction and resolution path already funnels through
 * this one function: /ask, /turn, /clue, /correct and /resolve all end by
 * calling it, including the error paths that deliberately save a recorded
 * answer before returning 502. Wrapping the funnel is therefore the entire
 * change — the same argument NamespacedKV made for wrapping getKV(): the call
 * sites are untouched and cannot forget to apply it. Six copies of this call
 * would be six chances for a future route to silently stop recording history.
 *
 * ORDERING IS LOAD-BEARING. Redis is written and awaited FIRST. Redis remains
 * the authority for live gameplay; PostgreSQL is a write-behind mirror of it.
 * Nothing below this line can change what the player experiences.
 *
 * WHY AWAITED RATHER THAN FIRE-AND-FORGET: on serverless the function may
 * freeze the moment the response is returned, so a detached promise is not
 * reliably delivered — "fire and forget" would quietly mean "forget". The cost
 * is one HTTP round trip (~50ms) on turns that already spend seconds in model
 * calls.
 *
 * recordGameState never throws and never mutates the record.
 */
export async function saveGame(record: GameRecord): Promise<void> {
  await getKV().set(gameKey(record.game_id), record, env.gameTtlSeconds());

  try {
    await recordGameState(record);
  } catch (err) {
    // LAST-RESORT BUG BOUNDARY. A game must not fail because history did.
    //
    // recordGameState now handles connection AND write failures internally,
    // queueing them for replay, so reaching this line means a genuine defect
    // rather than an operational problem. Until 2.2.0.2 it also caught
    // malformed-connection-string throws from getSql(), which looked like a
    // safety net working and was in fact evidence being lost: nothing was
    // queued for replay. If this ever fires again, treat it as a bug report.
    // eslint-disable-next-line no-console
    console.error("[barkoba] corpus hook raised unexpectedly (this is a defect):", err);
  }
}


/**
 * A blank log entry. turn/ and ask/ each carry their own local copy of this
 * literal, written before there was a third caller; they are deliberately not
 * refactored here — changing two working routes to remove duplication is not a
 * trade worth making in a release candidate. New callers use this one.
 */
export function newLogEntry(turnIndex: number): QuestionLogEntry {
  return {
    id: randomUUID(),
    turn_index: turnIndex,
    turn_type: "question",
    racer_output_raw: "",
    question_text: null,
    guess_text: null,
    composer_response: null,
    ambiguous_explanation: null,
    guess_detector_flagged: false,
    guess_detector_method: null,
    guess_intent_outcome: null,
    clue_text: null,
    original_question_text: null,
    edit_status: null,
    edit_reason: null,
    ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(),
    // V2.5 provenance. Stamped by the route that authored the turn, if a model
    // authored it at all; a Human↔Human turn legitimately keeps all three null.
    model_id: null,
    model_provider: null,
    prompt_version: null,
    answered_at: null,
    pre_revision_question_text: null,
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
  };
}
