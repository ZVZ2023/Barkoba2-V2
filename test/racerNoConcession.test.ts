import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createGame } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { anthropicAdapter } from "../lib/providers/anthropic";
import type { ToolCallRequest, ToolCallResult } from "../lib/providers/types";
import { runRacerTurn } from "../lib/prompts/racer";
import { toRacerPublicState } from "../lib/racerState";
import type { ComposerAnswer, GameRecord, QuestionLogEntry } from "../lib/types";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();
const TEST_COMPOSER_ID = testPlayerId("a");

// ---------------------------------------------------------------------------
// V2.8.4.3 — the no-concession final-action contract.
//
// THE INCIDENT: game e8709644-cb31-4b5b-b126-feddfff38220 ("PC"). After the
// 20-question budget was exhausted, the forced-final call's own schema still
// offered ["guess", "concede"], and the provider chose "concede" — a
// truthful "Az AI feladta. Nyertél." result the product rule now forbids
// outright: the Racer never voluntarily concedes, and the forced-final
// turn's only legal action is a guess. See lib/prompts/racer.ts's
// racer/4.0.1 doc and app/api/game/[id]/turn/route.ts's forceFinal wiring.
// ---------------------------------------------------------------------------

function entry(o: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(), turn_index: 1, turn_type: "question", racer_output_raw: "",
    question_text: "Is the target a physical object?", guess_text: null,
    composer_response: null, ambiguous_explanation: null,
    guess_detector_flagged: false, guess_detector_method: null,
    guess_intent_outcome: null, clue_text: null, original_question_text: null,
    edit_status: null, edit_reason: null, ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(),
    model_id: null, model_provider: null, prompt_version: null,
    answered_at: null, pre_revision_question_text: null,
    quality_score: null, information_gain: null, strategy_classification: null,
    integrity_flag: null, confidence: null, latency_ms: null,
    ...o,
  };
}

function fixtureGame(log: QuestionLogEntry[]): GameRecord {
  return {
    game_id: randomUUID(), revision: 0, player_id: null,
    composer_player_id: null, racer_player_id: null, join_code: null,
    phase: "questioning", created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(), max_questions: 20, game_language: "en",
    private_target: false, composer_kind: "human", racer_kind: "ai",
    racer_provider: null, difficulty: null, clue_mode: null,
    question_count: log.length, question_count_high_water_mark: log.length,
    ambiguous_count: 0, qa_log: log,
    final_action: null, final_guess_text: null, result: null,
    integrity_notes: null, integrity_flagged_turns: null, adjudication_notes: null,
    adjudicator_verdict: null, integrity_verdict: null, adjudication_confidence: null,
    revealed_target: null, revealed_definition: null, revealed_granularity: null,
    revealed_modifiers: null, revealed_locked_at: null,
    corrections: [], abandoned_branches: [], clarification_prompt: null,
    benchmark_case_id: null, benchmark_run_id: null,
  };
}

function answeredState(answer: ComposerAnswer) {
  return toRacerPublicState(
    fixtureGame([entry({ turn_index: 1, composer_response: answer, answered_at: new Date().toISOString() })])
  );
}

function stubOnce(output: unknown) {
  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => ({
    output,
    resolvedModel: "stub",
  })) as typeof anthropicAdapter.callTool;
  return () => {
    anthropicAdapter.callTool = original;
  };
}

async function captureSchema(forceFinal: boolean): Promise<Record<string, unknown>> {
  let captured: ToolCallRequest | null = null;
  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async (request: ToolCallRequest) => {
    captured = request;
    return {
      output: forceFinal
        ? { action: "guess", question_text: null, guess_text: "a hammer", rationale: "" }
        : { action: "question", question_text: "Is it alive?", guess_text: null, rationale: "" },
      resolvedModel: "stub",
    } as ToolCallResult<unknown>;
  }) as typeof anthropicAdapter.callTool;

  try {
    await runRacerTurn(answeredState("NO"), { forceFinal, provider: "anthropic" });
  } finally {
    anthropicAdapter.callTool = original;
  }
  assert.ok(captured, "the adapter was never called");
  return (captured as unknown as ToolCallRequest).inputSchema;
}

// --- 1 & 2: the schema itself --------------------------------------------

test("1. an ordinary turn's action schema excludes concede", async () => {
  const schema = await captureSchema(false);
  const properties = schema.properties as { action: { enum: string[] } };
  assert.deepEqual(properties.action.enum, ["question", "guess"]);
  assert.ok(!properties.action.enum.includes("concede"));
});

test("2. the forced-final schema permits exactly guess", async () => {
  const schema = await captureSchema(true);
  const properties = schema.properties as { action: { enum: string[] } };
  assert.deepEqual(properties.action.enum, ["guess"]);
});

// --- 5: a provider-returned concede is rejected, never persisted ----------

test("5. a provider-returned concede on an ordinary turn is rejected, not translated into a guess or accepted as-is", async () => {
  const restore = stubOnce({ action: "concede", question_text: null, guess_text: null, rationale: "giving up" });
  try {
    await assert.rejects(
      () => runRacerTurn(answeredState("NO"), { forceFinal: false, provider: "anthropic" }),
      /outside the permitted set/
    );
  } finally {
    restore();
  }
});

test("5b. a provider-returned concede on the forced-final turn is rejected the same way", async () => {
  const restore = stubOnce({ action: "concede", question_text: null, guess_text: null, rationale: "giving up" });
  try {
    await assert.rejects(
      () => runRacerTurn(answeredState("NO"), { forceFinal: true, provider: "anthropic" }),
      /outside the permitted set/
    );
  } finally {
    restore();
  }
});

test("a guess with no usable guess_text is rejected rather than fabricated from question_text", async () => {
  const restore = stubOnce({ action: "guess", question_text: "Is it a hammer?", guess_text: "   ", rationale: "" });
  try {
    await assert.rejects(
      () => runRacerTurn(answeredState("NO"), { forceFinal: true, provider: "anthropic" }),
      /refusing to fabricate/
    );
  } finally {
    restore();
  }
});

// --- 3, 4 & 6: route-level integration, the REAL turn handler -------------

async function makeSmallGame() {
  const gameId = randomUUID();
  await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 1,
    game_language: "en",
    composer_player_id: TEST_COMPOSER_ID,
  });
  return gameId;
}

function turnRequest(gameId: string, body?: Record<string, unknown>) {
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

test("3 & 4. answering the final allowed question is followed by exactly one forced guess turn — not another question — and question_count does not increment", async () => {
  // max_questions: 1 stands in for the 20-question production budget; the
  // route computes forceFinal the same way regardless of the configured
  // limit (effectiveConsumed(game) >= game.max_questions), and Phase One's
  // own deterministic opening question is what fills that first slot here.
  const gameId = await makeSmallGame();
  const opening = await callTurn(gameId); // Phase One's deterministic Q1
  const rev = opening.data.game.revision;

  const restore = stubOnce({ action: "guess", question_text: null, guess_text: "a hammer", rationale: "" });
  try {
    const res = await callTurn(gameId, { answer: "NO", expected_revision: rev });
    assert.equal(res.status, 200);
    const { game } = res.data;
    assert.equal(game.qa_log.length, 2, "exactly one turn follows the answered question");
    assert.equal(game.qa_log[1].turn_type, "guess", "the forced turn must be a guess, never a question or a concede");
    assert.equal(game.qa_log[1].guess_text, "a hammer");
    assert.equal(game.question_count, 1, "the forced-final guess must not be counted as a question");
    assert.equal(game.phase, "resolving");
    assert.equal(game.final_action, "guess");
    assert.equal(game.final_guess_text, "a hammer");
  } finally {
    restore();
  }
});

test("6. a forced-final provider failure surfaces the existing technical-recovery state, never a false victory", async () => {
  const gameId = await makeSmallGame();
  const opening = await callTurn(gameId);
  const rev = opening.data.game.revision;

  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => {
    throw new Error("simulated provider outage");
  }) as typeof anthropicAdapter.callTool;

  try {
    const res = await callTurn(gameId, { answer: "NO", expected_revision: rev });
    assert.equal(res.status, 502);
    assert.equal(res.data.error, "racer_unavailable");
    assert.equal(res.data.game.phase, "questioning", "must stay live, never resolve to a fabricated outcome");
    assert.equal(res.data.game.final_action, null);
    assert.equal(res.data.game.qa_log.length, 1, "no turn is fabricated from a failed call");
  } finally {
    anthropicAdapter.callTool = original;
  }
});

test("6b. a forced-final schema violation (provider still returns concede) also uses technical recovery, not a Setter win", async () => {
  const gameId = await makeSmallGame();
  const opening = await callTurn(gameId);
  const rev = opening.data.game.revision;

  const restore = stubOnce({ action: "concede", question_text: null, guess_text: null, rationale: "giving up" });
  try {
    const res = await callTurn(gameId, { answer: "NO", expected_revision: rev });
    assert.equal(res.status, 502);
    assert.equal(res.data.error, "racer_unavailable");
    assert.equal(res.data.game.phase, "questioning");
    assert.equal(res.data.game.final_action, null, "a rejected concede must never be recorded as any outcome");
    assert.equal(res.data.game.qa_log.length, 1);
  } finally {
    restore();
  }
});

// --- 7: historical stored concede games still render correctly ------------

test("7. historical concede games remain representable — RacerAction, resolveResult, and the turn/final_action shape all still accept 'concede'", () => {
  // No rendering harness exists in this repo (see resultScreenProfileLeak.test
  // .test's own note) — this is the source/type-contract equivalent: a stored
  // historical record with final_action/turn_type "concede" must still be a
  // structurally valid GameRecord/QuestionLogEntry, and ResultPanel's HEADLINE
  // table must still map the resulting outcome. The NEW-GAME action space no
  // longer offers "concede" (see the tests above) — this test pins that the
  // TYPE and the historical-rendering path were deliberately left alone.
  const g = fixtureGame([
    entry({ turn_index: 1, turn_type: "concede", question_text: null, composer_response: null }),
  ]);
  g.final_action = "concede";
  g.result = "composer_win_integrity_upheld";
  g.phase = "complete";
  assert.equal(g.qa_log[0]!.turn_type, "concede", "a historical concede turn_type must still type-check");
  assert.equal(g.final_action, "concede");

  const resultPanel = readFileSync("app/game/[id]/ResultPanel.tsx", "utf8");
  assert.match(resultPanel, /composer_win_integrity_upheld:\s*"Az AI feladta\. Nyertél\."/);
  assert.match(resultPanel, /game\.final_action === "concede"/, "the resolving-phase label still recognizes a concede in flight");
});
