import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createGame, getGame } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { derivePhaseOneState } from "../lib/phaseOne";
import { anthropicAdapter } from "../lib/providers/anthropic";
import type { ToolCallResult } from "../lib/providers/types";
import type { ComposerAnswer, QuestionLogEntry } from "../lib/types";

let idCounter = 0;

/** Same minimal-entry shape as test/phaseOne.test.ts's own local helper. */
function mkEntry(
  questionText: string,
  answer: ComposerAnswer | null,
  overrides: Partial<QuestionLogEntry> = {}
): QuestionLogEntry {
  idCounter += 1;
  return {
    id: `t${idCounter}`,
    turn_index: idCounter,
    turn_type: "question",
    racer_output_raw: "",
    question_text: questionText,
    guess_text: null,
    composer_response: answer,
    ambiguous_explanation: null,
    guess_detector_flagged: false,
    guess_detector_method: null,
    guess_intent_outcome: null,
    clue_text: null,
    timestamp: new Date().toISOString(),
    model_id: null,
    model_provider: null,
    prompt_version: null,
    answered_at: answer !== null ? new Date().toISOString() : null,
    pre_revision_question_text: null,
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
    original_question_text: null,
    edit_status: null,
    edit_reason: null,
    ambiguous_consumed_credit: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// V2.8.4 PHASE ONE — CONTINUOUS HANDOFF MICRO-CORRECTION.
//
// ROOT CAUSE THIS PROVES FIXED: derivePhaseOneState() used to re-inspect
// EVERY qa_log entry on every call, including ones written after Phase One
// had already completed. Its first check -- "entry.model_id !== null ->
// NOT_APPLICABLE" -- exists to recognize a game that never started inside
// the deterministic prefix, but it fired just as eagerly on a Phase Two
// model-authored entry AFTER a legitimate completion, wiping the already-
// locked sandbox/specificity back to null. Combined with the turn route's
// own `phaseOneState.complete && phaseOneState.sandbox !== null` gate (see
// app/api/game/[id]/turn/route.ts), this meant RacerPublicState.phase_one
// was populated on the FIRST Phase Two turn only -- every Phase Two turn
// after that lost the sandbox/specificity/contested-boundary context, in
// silent violation of "the current model Racer continues with the locked
// classification throughout Phase Two."
//
// Same harness pattern as test/phaseOneIntegration.test.ts: real route
// handlers, real gameStore, in-memory KV fallback, only the Racer's LLM call
// mocked.
// ---------------------------------------------------------------------------

async function makeGame(language: "en" | "hu" = "en") {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: language,
  });
  return { gameId, game };
}

function turnRequest(gameId: string, body: Record<string, unknown> | undefined) {
  const json = body === undefined ? "" : JSON.stringify(body);
  return new NextRequest(`http://localhost/api/game/${gameId}/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": body === undefined ? "0" : String(Buffer.byteLength(json)),
    },
    body: body === undefined ? undefined : json,
  });
}

async function callTurn(gameId: string, body?: Record<string, unknown>) {
  const res = await turnPOST(turnRequest(gameId, body), { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

async function answer(gameId: string, ans: "YES" | "NO" | "AMBIGUOUS", revision: number) {
  const result = await callTurn(gameId, { answer: ans, expected_revision: revision });
  assert.equal(result.status, 200, `answer(${ans}) should succeed: ${JSON.stringify(result.data)}`);
  return result.data.game;
}

/** Mocks a sequence of Racer replies, one per call, capturing each call's messages. */
function mockProviderSequence(questionTexts: string[]) {
  const original = anthropicAdapter.callTool;
  let calls = 0;
  const capturedMessagesByCall: unknown[][] = [];
  anthropicAdapter.callTool = (async (request: { messages: unknown[] }) => {
    const text = questionTexts[calls];
    calls += 1;
    capturedMessagesByCall.push(request.messages);
    return {
      output: { action: "question", question_text: text, guess_text: null, rationale: "test" },
      resolvedModel: "stub",
    } as ToolCallResult<unknown>;
  }) as typeof anthropicAdapter.callTool;
  return {
    callCount: () => calls,
    messagesForCall: (n: number) => capturedMessagesByCall[n] as Array<{ content: string }>,
    restore: () => {
      anthropicAdapter.callTool = original;
    },
  };
}

const LIVING_KIND_HANDOFF = "Deterministic opening classification: living (a kind/category, not one particular instance).";

/** Locks Living/kind and returns the game + revision positioned to answer Phase Two's first question. */
async function reachPhaseTwo(gameId: string) {
  const opening = await callTurn(gameId); // Q1
  let rev = opening.data.game.revision;
  const afterQ1 = await answer(gameId, "YES", rev); // locks Living
  rev = afterQ1.revision;
  assert.equal(afterQ1.qa_log[1].question_text, "Is it one particular living being?");

  const mock = mockProviderSequence(["Does it live in water?"]);
  let afterSpec;
  try {
    afterSpec = await answer(gameId, "NO", rev); // kind/category -> Phase One complete -> Phase Two turn #1
    assert.equal(mock.callCount(), 1);
    const joined = mock.messagesForCall(0).map((m) => m.content).join("\n");
    assert.match(joined, /Deterministic opening classification: living \(a kind\/category/);
  } finally {
    mock.restore();
  }
  return afterSpec;
}

// --- 1. Completed Phase One, no trailing entry -----------------------------

test("HANDOFF 1: completed Phase One with no trailing entry returns the expected summary", () => {
  // Exercised at the pure level in test/phaseOne.test.ts's REQUIRED 3; kept
  // here too as the baseline HANDOFF 2/3 build on by appending trailing
  // Phase Two entries.
  const log = [mkEntry("Is it alive?", "YES"), mkEntry("Is it one particular living being?", "NO")];
  const state = derivePhaseOneState(log, "en");
  assert.equal(state.complete, true);
  assert.equal(state.sandbox, "living");
  assert.equal(state.specificity, "kind");
});

test("HANDOFF 2 & 3 (pure): appending one, then several, model-authored Phase Two entries never changes the frozen summary", () => {
  const base = [mkEntry("Is it alive?", "YES"), mkEntry("Is it one particular living being?", "NO")];
  const before = derivePhaseOneState(base, "en");

  const modelEntry = (questionText: string, answer: ComposerAnswer | null) =>
    mkEntry(questionText, answer, { model_id: "some-model", model_provider: "anthropic", prompt_version: "racer/4.0.0" });

  const oneTrailing = [...base, modelEntry("Does it live in water?", "NO")];
  assert.deepEqual(derivePhaseOneState(oneTrailing, "en"), before);

  const manyTrailing = [
    ...base,
    modelEntry("Does it live in water?", "NO"),
    modelEntry("Is it a mammal?", "YES"),
    modelEntry("Is it a pet?", null), // pending, unanswered
  ];
  assert.deepEqual(derivePhaseOneState(manyTrailing, "en"), before);
});

// --- 2/3. Trailing Phase Two entries never change the summary (route level)

test("HANDOFF 2 & 3: two successive Phase Two turns both receive the identical phase_one handoff", async () => {
  const { gameId } = await makeGame("en");
  const afterTurn1 = await reachPhaseTwo(gameId);
  assert.equal(afterTurn1.qa_log[2].question_text, "Does it live in water?");
  assert.notEqual(afterTurn1.qa_log[2].model_id, null, "a real Phase Two turn must carry real provenance");

  // Answer Phase Two's first question -> triggers Phase Two's SECOND real
  // (mocked) turn. Before this fix, phase_one was already lost by this point.
  const mock2 = mockProviderSequence(["Is it a mammal?"]);
  let afterTurn2;
  try {
    afterTurn2 = await answer(gameId, "NO", afterTurn1.revision);
    assert.equal(mock2.callCount(), 1, "REQUIRED 8: exactly one provider call for this turn, no extras");
    const joined = mock2.messagesForCall(0).map((m) => m.content).join("\n");
    assert.match(
      joined,
      new RegExp(LIVING_KIND_HANDOFF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the SECOND Phase Two turn must still receive the identical locked classification"
    );
  } finally {
    mock2.restore();
  }
  assert.equal(afterTurn2.qa_log[3].question_text, "Is it a mammal?");

  // A third Phase Two turn, to prove this holds beyond just "the second one."
  const mock3 = mockProviderSequence(["Does it have fur?"]);
  try {
    const afterTurn3 = await answer(gameId, "YES", afterTurn2.revision);
    assert.equal(mock3.callCount(), 1);
    const joined = mock3.messagesForCall(0).map((m) => m.content).join("\n");
    assert.match(joined, /Deterministic opening classification: living \(a kind\/category/);
    assert.equal(afterTurn3.qa_log[4].question_text, "Does it have fur?");
  } finally {
    mock3.restore();
  }
});

// --- 5. Reload after multiple Phase Two turns preserves the handoff --------

test("HANDOFF 5: reloading the game after multiple Phase Two turns still derives the same locked classification", async () => {
  const { gameId } = await makeGame("en");
  const afterTurn1 = await reachPhaseTwo(gameId);

  const mock2 = mockProviderSequence(["Is it a mammal?"]);
  let afterTurn2;
  try {
    afterTurn2 = await answer(gameId, "NO", afterTurn1.revision);
  } finally {
    mock2.restore();
  }

  const mock3 = mockProviderSequence(["Does it have fur?"]);
  try {
    await answer(gameId, "YES", afterTurn2.revision);
  } finally {
    mock3.restore();
  }

  // Simulate a reload: re-fetch from the store (no in-memory position was
  // ever kept) and re-derive directly, exactly as the /turn route does on
  // its very next call.
  const reloaded = await getGame(gameId);
  assert.ok(reloaded);
  const state = derivePhaseOneState(reloaded!.qa_log, reloaded!.game_language);
  assert.equal(state.complete, true);
  assert.equal(state.sandbox, "living");
  assert.equal(state.specificity, "kind");
  assert.deepEqual(state.mixedSpineQuestions, []);
});

// --- 6. Legacy games are unaffected -----------------------------------------

test("HANDOFF 6: a legacy game whose first question is not the deterministic prefix remains NOT_APPLICABLE, unaffected by the fix", async () => {
  const { gameId } = await makeGame("en");
  const game = await getGame(gameId);
  assert.ok(game);
  game!.qa_log.push(
    mkEntry("What color is it?", "NO", {
      model_id: "some-legacy-model",
      model_provider: "anthropic",
      prompt_version: "racer/4.0.0",
      latency_ms: 500,
    })
  );
  const state = derivePhaseOneState(game!.qa_log, game!.game_language);
  assert.equal(state.complete, true);
  assert.equal(state.sandbox, null);
});

// --- 7. Correction/rewind back into Phase One still recomputes incomplete --

test("HANDOFF 7: correcting Q1 AFTER multiple Phase Two turns rewinds all the way back to the incomplete spine, not a frozen stale summary", async () => {
  const { gameId } = await makeGame("en");
  const afterTurn1 = await reachPhaseTwo(gameId);

  const mock2 = mockProviderSequence(["Is it a mammal?"]);
  let afterTurn2;
  try {
    afterTurn2 = await answer(gameId, "NO", afterTurn1.revision);
  } finally {
    mock2.restore();
  }
  assert.equal(afterTurn2.qa_log.length, 4);

  // Correct the ORIGINAL Q1 (YES -> NO). This must discard everything built
  // on top of it -- the specificity question and both Phase Two turns -- and
  // resume the spine at Q2, deterministically, with no provider call.
  const { POST: correctPOST } = await import("../app/api/game/[id]/correct/route");
  const correctReq = new NextRequest(`http://localhost/api/game/${gameId}/correct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turn_index: 1, answer: "NO", expected_log_length: afterTurn2.qa_log.length }),
  });
  const correctRes = await correctPOST(correctReq, { params: { id: gameId } });
  const correctData = await correctRes.json();
  assert.equal(correctRes.status, 200, JSON.stringify(correctData));
  assert.equal(correctData.game.qa_log.length, 1, "the specificity question and both Phase Two turns must be discarded");

  const state = derivePhaseOneState(correctData.game.qa_log, correctData.game.game_language);
  assert.equal(state.complete, false, "the corrected log must be recognized as incomplete again, not frozen complete");
  assert.equal(state.sandbox, null);
  assert.equal(state.nextQuestionText, "Is it a physical thing or substance?");
});

// --- 8. No extra provider call or telemetry from the fix --------------------

test("HANDOFF 8: no extra provider call is introduced across Phase One + two Phase Two turns", async () => {
  const { gameId } = await makeGame("en");
  const afterTurn1 = await reachPhaseTwo(gameId); // asserts exactly 1 call internally

  const mock2 = mockProviderSequence(["Is it a mammal?"]);
  try {
    await answer(gameId, "NO", afterTurn1.revision);
    assert.equal(mock2.callCount(), 1, "exactly one provider call for the second Phase Two turn -- no extra call from re-deriving phase_one");
  } finally {
    mock2.restore();
  }
});
