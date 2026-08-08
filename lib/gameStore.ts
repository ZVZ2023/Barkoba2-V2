import { getKV } from "./kv";
import { env } from "./env";
import type { GameRecord } from "./types";

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
    phase: "pending_validation",
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    max_questions: env.maxQuestions(),
    game_language: "en",
    // 0.3.x = Human Composer vs AI Racer. Hardcoded on purpose: this records
    // the configuration, it does not select it. No code branches on these.
    composer_kind: "human",
    racer_kind: "ai",
    question_count: 0,
    ambiguous_count: 0,
    qa_log: [],
    final_action: null,
    final_guess_text: null,
    result: null,
    integrity_notes: null,
    integrity_flagged_turns: null,
    adjudication_notes: null,
    revealed_target: null,
    clarification_prompt: null,
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

export async function saveGame(record: GameRecord): Promise<void> {
  await getKV().set(gameKey(record.game_id), record, env.gameTtlSeconds());
}
