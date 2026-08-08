import type { GameRecord, RacerPublicState, RacerTranscriptTurn } from "./types";

// ---------------------------------------------------------------------------
// The narrowing boundary.
//
// This is the ONLY place GameRecord is converted into something the Racer can
// see. lib/prompts/racer.ts does not import GameRecord at all — it accepts
// RacerPublicState. That indirection is the point: if GameRecord ever grows a
// field that carries target information, the Racer does not inherit it
// silently. Someone has to come here and add it on purpose.
//
// This module must never import lib/secretStore.ts. scripts/check-isolation.mjs
// enforces that mechanically at build time.
// ---------------------------------------------------------------------------

export function toRacerPublicState(game: GameRecord): RacerPublicState {
  const transcript: RacerTranscriptTurn[] = [];

  for (const entry of game.qa_log) {
    if (entry.turn_type !== "question") continue;
    if (!entry.question_text) continue;
    transcript.push({
      turn_index: entry.turn_index,
      question: entry.question_text,
      answer: entry.composer_response,
      ambiguous_explanation: entry.ambiguous_explanation,
    });
  }

  return {
    question_count: game.question_count,
    max_questions: game.max_questions,
    questions_remaining: Math.max(0, game.max_questions - game.question_count),
    // Language of play only. "hu" vs "en" says nothing about what the target
    // is — it is a property of how the Composer typed, not of the secret.
    game_language: game.game_language,
    transcript,
  };
}
