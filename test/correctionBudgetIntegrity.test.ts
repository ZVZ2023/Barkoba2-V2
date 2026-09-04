import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createGame, getGame, newLogEntry, saveGame } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { POST as correctPOST } from "../app/api/game/[id]/correct/route";
import { effectiveConsumed } from "../lib/rewind";
import { anthropicAdapter } from "../lib/providers/anthropic";
import type { ToolCallResult } from "../lib/providers/types";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();
const TEST_COMPOSER_ID = testPlayerId("a");

// ---------------------------------------------------------------------------
// V2.8.4.2 — CORRECTION-BUDGET INTEGRITY, route-level. Same harness pattern
// as test/phaseOneIntegration.test.ts and test/turnBudgetIntegration.test.ts:
// the REAL route handlers, the REAL gameStore, the in-memory KV fallback,
// only the Racer LLM call mocked. Exclusively AI-Racer games reach these
// routes (GameClient.tsx is their only caller — see lib/rewind.ts's own
// module doc), so nothing here touches Human↔Human or AI-Composer play.
//
// Builds the "19 of 20 already consumed" state directly via gameStore rather
// than playing 19 real turns — this is the same fixture-construction
// convention test/phaseOneIntegration.test.ts's own V2.8.4.1 legacy-game test
// already uses, and is exactly what a durably-persisted mid-game state looks
// like on reload regardless of how it was reached.
// ---------------------------------------------------------------------------

function mockProviderOnce(questionText: string) {
  const original = anthropicAdapter.callTool;
  let calls = 0;
  anthropicAdapter.callTool = (async () => {
    calls += 1;
    return {
      output: { action: "question", question_text: questionText, guess_text: null, rationale: "test" },
      resolvedModel: "stub",
    } as ToolCallResult<unknown>;
  }) as typeof anthropicAdapter.callTool;
  return {
    callCount: () => calls,
    restore: () => {
      anthropicAdapter.callTool = original;
    },
  };
}

function failIfCalled() {
  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => {
    throw new Error("PROVIDER MUST NOT BE CALLED BY A REJECTED CORRECTION");
  }) as typeof anthropicAdapter.callTool;
  return {
    restore: () => {
      anthropicAdapter.callTool = original;
    },
  };
}

/** 19 answered questions, turn_index 1..19, each a real (model-authored) Phase Two turn. */
async function makeNineteenConsumedGame() {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: "en",
    composer_player_id: TEST_COMPOSER_ID,
  });
  const qaLog = [];
  for (let i = 1; i <= 19; i += 1) {
    const e = newLogEntry(i);
    e.question_text = `Q${i}?`;
    e.composer_response = "YES";
    e.answered_at = new Date().toISOString();
    e.model_id = "some-model";
    e.model_provider = "anthropic";
    e.prompt_version = "racer/4.0.0";
    qaLog.push(e);
  }
  game.qa_log = qaLog;
  game.question_count = 19;
  game.question_count_high_water_mark = 19;
  await saveGame(game);
  return gameId;
}

function turnRequest(gameId: string, body: Record<string, unknown> | undefined) {
  const json = body === undefined ? "" : JSON.stringify(body);
  return new NextRequest(`http://localhost/api/game/${gameId}/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": body === undefined ? "0" : String(Buffer.byteLength(json)),
      "x-bk-player": TEST_COMPOSER_ID,
    },
    body: body === undefined ? undefined : json,
  });
}

async function callTurn(gameId: string, body?: Record<string, unknown>) {
  const res = await turnPOST(turnRequest(gameId, body), { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

async function callCorrect(gameId: string, body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/game/${gameId}/correct`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bk-player": TEST_COMPOSER_ID },
    body: JSON.stringify(body),
  });
  const res = await correctPOST(req, { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

test("REQUIRED REGRESSION: Q3 correction is rejected (outside the latest-3 window) in a 19/20-consumed game", async () => {
  const gameId = await makeNineteenConsumedGame();
  const guard = failIfCalled();
  try {
    const result = await callCorrect(gameId, {
      turn_index: 3,
      answer: "NO",
      expected_log_length: 19,
    });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, "correction_window_closed");
    // Rejected outright: no mutation at all.
    const untouched = await getGame(gameId);
    assert.equal(untouched!.qa_log.length, 19);
    assert.equal(untouched!.question_count, 19);
  } finally {
    guard.restore();
  }
});

test("REQUIRED REGRESSION: Q17, Q18, Q19 are each eligible", async () => {
  for (const turnIndex of [17, 18, 19]) {
    const gameId = await makeNineteenConsumedGame();
    const result = await callCorrect(gameId, {
      turn_index: turnIndex,
      answer: "NO",
      expected_log_length: 19,
    });
    assert.equal(result.status, 200, `Q${turnIndex} should be an eligible correction: ${JSON.stringify(result.data)}`);
  }
});

test("REQUIRED REGRESSION: correcting the eligible Q17 does not reduce the consumed count below 19, and exactly one further question/guess remains", async () => {
  const gameId = await makeNineteenConsumedGame();
  const result = await callCorrect(gameId, {
    turn_index: 17,
    answer: "NO",
    expected_log_length: 19,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const corrected = result.data.game;
  // The correction discarded Q18 and Q19 -- the raw, recomputed count drops.
  assert.equal(corrected.qa_log.length, 17);
  assert.equal(corrected.question_count, 17, "recomputed question_count legitimately drops -- this is unchanged, correct behavior");
  // But the durable floor must not move.
  assert.equal(corrected.question_count_high_water_mark, 19, "already-consumed questions are never refunded");
  assert.equal(effectiveConsumed(corrected), 19, "the count that actually governs remaining budget holds at 19");
  assert.equal(20 - effectiveConsumed(corrected), 1, "only one further question/guess remains in a 20-question game");
});

test("REQUIRED REGRESSION: reload cannot restore refunded capacity -- the durable mark survives a fresh getGame() read", async () => {
  const gameId = await makeNineteenConsumedGame();
  const corrected = (await callCorrect(gameId, { turn_index: 17, answer: "NO", expected_log_length: 19 })).data.game;
  assert.equal(effectiveConsumed(corrected), 19);

  const reloaded = await getGame(gameId);
  assert.ok(reloaded);
  assert.equal(reloaded!.question_count, 17);
  assert.equal(reloaded!.question_count_high_water_mark, 19, "the mark must be durably persisted, not merely held in the correction response");
  assert.equal(effectiveConsumed(reloaded!), 19);
});

test("REQUIRED REGRESSION: exactly one more real question can still be generated and answered, and answering it immediately exhausts the budget and forces the final guess under the existing rules", async () => {
  const gameId = await makeNineteenConsumedGame();
  await callCorrect(gameId, { turn_index: 17, answer: "NO", expected_log_length: 19 });

  // The one remaining slot: a genuinely NEW question is generated (mocked).
  const mock = mockProviderOnce("Q20?");
  let opening;
  try {
    opening = await callTurn(gameId); // nothing pending -> auto-generates the 20th-ever question
    assert.equal(mock.callCount(), 1);
    assert.equal(opening.data.game.qa_log[17].question_text, "Q20?");
  } finally {
    mock.restore();
  }

  // Answering it is the exact instant the budget becomes exhausted (17
  // retained + this one new answer = 18 raw, but the durable mark advances
  // to 20 -- see the CONFIRMED-DEFECT-CLASS GUARD test above). forceFinal is
  // computed from that same, now-exhausted count in THIS SAME request, so
  // the existing rules already route straight to a forced final guess here
  // -- there is no separate "one more poll" needed to discover it is out of
  // budget, and no 21st question is ever asked.
  const mockGuess = mockProviderOnce("this should not be used as a question");
  let action: string | null = null;
  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => {
    action = "forced-guess-path-reached";
    return {
      output: { action: "guess", question_text: null, guess_text: "final guess", rationale: "forced" },
      resolvedModel: "stub",
    } as ToolCallResult<unknown>;
  }) as typeof anthropicAdapter.callTool;
  let afterAnswer;
  try {
    const res = await turnPOST(
      turnRequest(gameId, { answer: "YES", expected_revision: opening.data.game.revision }),
      { params: { id: gameId } }
    );
    afterAnswer = { status: res.status, data: await res.json() };
  } finally {
    anthropicAdapter.callTool = original;
    mockGuess.restore();
  }

  assert.equal(afterAnswer.status, 200, JSON.stringify(afterAnswer.data));
  const game = afterAnswer.data.game;
  assert.equal(game.question_count, 18, "17 retained + 1 genuinely new answer");
  // CONFIRMED-DEFECT-CLASS GUARD: the one new real answer must push the true
  // total from 19 to 20, not be silently absorbed by the stale mark from
  // before the correction (see lib/rewind.ts's advanceHighWaterMark doc).
  assert.equal(game.question_count_high_water_mark, 20);
  assert.equal(effectiveConsumed(game), 20, "the full original 20-question budget is now genuinely exhausted");
  assert.equal(action, "forced-guess-path-reached", "the existing forceFinal mechanism, fed the correct count, routes to a forced guess");
  assert.equal(game.phase, "resolving");
  assert.equal(game.final_action, "guess");

  // A further poll finds the game already past questioning -- there is no
  // 21st question and no route back into asking one.
  const polled = await callTurn(gameId);
  assert.equal(polled.status, 409);
  assert.equal(polled.data.error, "wrong_phase");
});
