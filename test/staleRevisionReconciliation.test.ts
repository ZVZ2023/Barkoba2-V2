import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createGame } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { GET as viewGET } from "../app/api/game/[id]/view/route";
import { anthropicAdapter } from "../lib/providers/anthropic";
import type { ToolCallResult } from "../lib/providers/types";
import { mergeViewIntoGame } from "../lib/turnRequestGuard";
import type { GameRecord } from "../lib/types";
import type { GameView } from "../lib/gameView";

// ---------------------------------------------------------------------------
// S1 REVIEW FOLLOW-UP — the stale-revision defect this file proves fixed.
//
// The S1 report originally claimed leaving GameRecord.revision untouched by
// mergeViewIntoGame() was safe because "the existing, unmodified stale_turn
// path already supplies the true value on the next mutation attempt." A
// review demanded that claim be tested, not re-argued. It was tested, against
// the REAL turn route and the REAL view route (no mocks on the server side;
// only the Racer LLM call is stubbed) — and found CONFIRMED DEFECT:
//
//   1. Server saves Q1, revision 0 -> 1.
//   2. Client's own /turn response is lost (transport failure, simulated).
//   3. Reconciliation reads GET /view and shows the saved Q1 -- but the OLD
//      mergeViewIntoGame preserved the client's stale revision (0).
//   4. The player answers. sendTurn() submits expected_revision: 0.
//   5. The REAL turn route rejects it: 409 stale_turn. The answer is NEVER
//      recorded.
//   6. GameClient's existing stale_turn handling does not resubmit
//      automatically -- it silently reconciles the screen back to the SAME
//      unanswered question and clears any typed IS-IS explanation. The
//      player must notice and answer again.
//
// The fix: GameView now carries `record_revision`, the actual
// GameRecord.revision, obtained from the SAME /view call reconciliation
// already makes (no second request). mergeViewIntoGame applies it. This file
// proves the corrected sequence: the player's answer is accepted on the
// FIRST submit, with no stale_turn round trip and no second Q1-generation
// call.
// ---------------------------------------------------------------------------

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

function viewRequest(gameId: string) {
  return new NextRequest(`http://localhost/api/game/${gameId}/view`, { method: "GET" });
}

async function callTurn(gameId: string, body?: Record<string, unknown>) {
  const res = await turnPOST(turnRequest(gameId, body), { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

async function callView(gameId: string) {
  const res = await viewGET(viewRequest(gameId), { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

/** Stub the Racer to return one fixed question per call, in order. Restores on cleanup. */
function stubRacerQuestions(questions: string[]) {
  const original = anthropicAdapter.callTool;
  let calls = 0;
  anthropicAdapter.callTool = (async () => {
    const q = questions[calls];
    calls += 1;
    return {
      output: { action: "question", question_text: q ?? `unexpected-call-${calls}`, guess_text: null, rationale: "test" },
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

async function makeGame() {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: "en",
  });
  return { gameId, game };
}

/**
 * V2.8.4 — Runtime Phase One v6.1. Every AI-Racer game now opens with up to
 * six deterministic, zero-provider classification turns before the model
 * Racer is ever reached. Answers all five spine questions NO (-> the
 * shortest path to Phase Two: Unclassified), then stubs and issues the one
 * real call that both completes Phase One and produces the first
 * model-driven question. Returns the resulting `{status, data}`, matching
 * this file's own "fresh game -> first racer turn" opener shape.
 */
async function fastForwardPastPhaseOne(gameId: string, openingQuestion: string) {
  let rev: number = (await callTurn(gameId)).data.game.revision; // Q1
  for (let i = 0; i < 4; i += 1) {
    const result = await callTurn(gameId, { answer: "NO", expected_revision: rev });
    assert.equal(result.status, 200, `phase one step ${i + 1} must succeed`);
    rev = result.data.game.revision;
  }
  const opener = stubRacerQuestions([openingQuestion]);
  const opening = await callTurn(gameId, { answer: "NO", expected_revision: rev });
  opener.restore();
  return opening;
}

test("CONFIRMED FIX: after reconciliation applies the real revision, the player's answer is accepted on the first submit — no stale_turn, no second Q1-generation call", async () => {
  const { gameId } = await makeGame();

  // Phase One's own five deterministic turns happen first (V2.8.4) -- this
  // test's actual subject, stale-revision reconciliation, is orthogonal to
  // whether the pending question is deterministic or model-driven, so it is
  // relocated to Phase One's real handoff turn rather than turn 1.
  const opening = await fastForwardPastPhaseOne(gameId, "Is the target real or has it ever existed in reality?");
  assert.equal(opening.status, 200);
  const revisionAtOpening = opening.data.game.revision;
  // The client's snapshot immediately BEFORE this turn's own question was
  // answered -- i.e. Phase One's final state, with the model-driven question
  // not yet appended. Reconstructed the same way a real client would have
  // held it: everything up to but not including the turn under test.
  const clientBefore: GameRecord = { ...opening.data.game, revision: opening.data.game.revision - 1, qa_log: opening.data.game.qa_log.slice(0, -1) };

  // Step 1 — server saves the opening question, revision N-1 -> N. A second,
  // distinct question is queued for whenever the answer below is accepted
  // and /turn generates the next turn in the same request — that is the
  // ordinary Q2 generation this test must distinguish from a DUPLICATE
  // opening-question attempt.
  const racer = stubRacerQuestions(["Is it a physical object?"]);

  // Step 2/3 — the client's own /turn response was lost (not modeled here —
  // that is a pure client-side transport event, already covered behaviorally
  // by test/turnRequestGuard.test.ts's Tests B/B2). What matters for THIS
  // test is what the client is left holding: the PRE-turn snapshot
  // (clientBefore) reconciled against a REAL GET /view read.
  const viewResult = await callView(gameId);
  assert.equal(viewResult.status, 200);
  const view = viewResult.data.view as GameView;
  assert.equal(view.record_revision, revisionAtOpening, "the view must expose the true server-side revision");

  const reconciled: GameRecord = mergeViewIntoGame(clientBefore, view);
  assert.equal(reconciled.revision, revisionAtOpening, "reconciliation must adopt the true revision, not the stale client one");
  assert.equal(reconciled.qa_log.length, clientBefore.qa_log.length + 1);
  assert.equal(reconciled.qa_log.at(-1)?.composer_response, null, "the opening question is pending, unanswered");

  // Step 4/5/6 — the player answers. sendTurn() would submit
  // expected_revision: reconciled.revision. This is now correct.
  const answer = await callTurn(gameId, { answer: "YES", expected_revision: reconciled.revision });

  assert.equal(answer.status, 200, "the FIRST submit must be accepted — no stale_turn round trip");
  assert.notEqual(answer.data.error, "stale_turn");
  assert.equal(
    answer.data.game.qa_log.at(-2)?.composer_response,
    "YES",
    "the answer must actually be recorded on the first try"
  );
  assert.equal(
    answer.data.game.qa_log.at(-2)?.question_text,
    "Is the target real or has it ever existed in reality?",
    "the opening question's own text must be unchanged -- not regenerated"
  );
  // Accepting the answer makes /turn generate the NEXT turn (Q2) in the same
  // request -- that is the route's ordinary one-call-per-turn behavior, not
  // a duplicate attempt at the opening question. Exactly 1 Racer call across
  // this whole test body: Q2. A second call would mean the opening question
  // was generated twice (a duplicate-generation defect); a stale_turn
  // rejection followed by a retry would also have shown up here as an extra
  // call, and did not.
  assert.equal(racer.callCount(), 1, "exactly one call for Q2 -- no re-attempt at the opening question, no stale_turn retry cycle");
  assert.equal(answer.data.game.qa_log.at(-1)?.question_text, "Is it a physical object?");
  racer.restore();
});

test("CONFIRMED FIX: a stale record_revision is still correctly rejected (V2.8.1 is not weakened)", async () => {
  // The other half of the guarantee: applying the REAL revision must not
  // make the stale_turn guard permissive. A genuinely stale
  // expected_revision (older than the current one) must still be rejected.
  const { gameId } = await makeGame();
  const racer = stubRacerQuestions(["Q1?", "Q2?"]);
  await callTurn(gameId); // revision -> 1
  await callTurn(gameId, { answer: "YES", expected_revision: 1 }); // revision -> 2, Q2 generated
  racer.restore();

  const stillStale = await callTurn(gameId, { answer: "NO", expected_revision: 1 }); // now actually stale
  assert.equal(stillStale.status, 409);
  assert.equal(stillStale.data.error, "stale_turn");
});
