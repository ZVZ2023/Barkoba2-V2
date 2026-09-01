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

/** V2.8.1 — the revision counter's own KV key. See GameRecord.revision. */
function revisionKey(gameId: string): string {
  return `state:${gameId}:rev`;
}

/**
 * V2.8.1 — the short-lived advisory lock a /turn (or /correct) request holds
 * while it owns the right to mutate this game. Its ONLY purpose is to stop
 * two concurrent requests from both paying for a Racer call for the same
 * pending question; the revision CAS below is what actually protects the
 * data even if this were somehow bypassed.
 */
function turnLockKey(gameId: string): string {
  return `state:${gameId}:turnlock`;
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
    // V2.5-B3 — null means Anthropic, which is what every game before B3 was.
    racer_provider: null,
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
    // V2.8.1 — placeholder only; getGame() always overwrites this with the
    // live value from revisionKey below, which is what every route actually
    // reads. See GameRecord.revision.
    revision: 0,
    ...overrides,
  };

  await getKV().set(gameKey(gameId), record, env.gameTtlSeconds());
  // Every game, whatever mode created it, gets a revision counter — not just
  // the human-Composer/AI-Racer path /turn protects, so a future write path
  // can adopt the same CAS without a second initialization site to remember.
  await getKV().set(revisionKey(gameId), 0, env.gameTtlSeconds());
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
  // V2.5-B3. Games created before B3 live for up to GAME_TTL_SECONDS and were
  // all played by Anthropic, so null is the only correct backfill.
  if (record.racer_provider === undefined) record.racer_provider = null;
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
  // V2.8.1 — always the live value from its own key, never whatever was
  // baked into the blob at the last write. A game created before this field
  // existed has no revision key yet; getGameRevision's own default (0) is
  // the correct backfill, matching every other pre-existing-field normalize
  // above.
  record.revision = await getGameRevision(gameId);
  return record;
}

/** The live value of a game's revision counter — 0 if never initialized. */
export async function getGameRevision(gameId: string): Promise<number> {
  const value = await getKV().get<number>(revisionKey(gameId));
  return typeof value === "number" ? value : 0;
}

/**
 * V2.8.1 — acquire the per-game turn lock. Returns false if another request
 * already holds it; the caller must not proceed to a Racer call in that
 * case. Always release with releaseTurnLock, in a finally.
 */
export async function acquireTurnLock(gameId: string, ttlSeconds: number): Promise<boolean> {
  return getKV().acquireLock(turnLockKey(gameId), ttlSeconds);
}

export async function releaseTurnLock(gameId: string): Promise<void> {
  await getKV().releaseLock(turnLockKey(gameId));
}

export interface SaveIfRevisionMatchesResult {
  ok: boolean;
  /** The revision the write landed at (if ok), or the current canonical revision (if not — the caller's snapshot was stale). */
  revision: number;
}

/**
 * V2.8.1 — the ONLY write path that binds a mutation to the exact
 * server-side state it was computed against. Persists `record` only if the
 * game's revision is still exactly `expectedRevision` — see lib/kv.ts's
 * casSetWithRevision for the atomicity guarantee. Every other saveGame()
 * caller remains a blind overwrite and must not be used for anything that
 * needs this guarantee.
 *
 * Mirrors saveGame()'s own corpus-mirroring contract: Redis first and
 * awaited, corpus write-behind and never throws into the caller.
 */
export async function saveGameIfRevisionMatches(
  record: GameRecord,
  expectedRevision: number
): Promise<SaveIfRevisionMatchesResult> {
  const result = await getKV().casSetWithRevision(
    gameKey(record.game_id),
    revisionKey(record.game_id),
    expectedRevision,
    record,
    env.gameTtlSeconds()
  );

  if (!result.ok) {
    return { ok: false, revision: result.currentRevision };
  }

  try {
    await recordGameState(record);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] corpus hook raised unexpectedly (this is a defect):", err);
  }
  return { ok: true, revision: result.revision };
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
