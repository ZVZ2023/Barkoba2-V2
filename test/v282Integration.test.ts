import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createGame, getGame } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { anthropicAdapter } from "../lib/providers/anthropic";
import type { ToolCallResult } from "../lib/providers/types";

// ---------------------------------------------------------------------------
// V2.8.2 — proves the My Car Key integrity binding (V2.8.1) and the
// exact-duplicate-question guard (V2.8.2) coexist correctly in the merged
// /turn route, not just independently in their own test files.
// ---------------------------------------------------------------------------

async function makeGame() {
  const gameId = randomUUID();
  await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: "en",
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
    },
    body: body === undefined ? undefined : json,
  });
}

async function callTurn(gameId: string, body?: Record<string, unknown>) {
  const res = await turnPOST(turnRequest(gameId, body), { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

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

test("A. a stale human answer is rejected: zero mutation, zero Racer call, unaffected by the duplicate guard's presence", async () => {
  const gameId = await makeGame();
  const stub = stubRacerQuestions(["Q1?", "Q2?"]);
  try {
    const opening = await callTurn(gameId);
    const revisionAtQ1 = opening.data.game.revision;
    await callTurn(gameId, { answer: "YES", expected_revision: revisionAtQ1 }); // advances to Q2
    assert.equal(stub.callCount(), 2);

    const before = await getGame(gameId);
    const stale = await callTurn(gameId, { answer: "NO", expected_revision: revisionAtQ1 }); // stale

    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, "stale_turn");
    assert.equal(stub.callCount(), 2, "the stale request must never reach the Racer");

    const after = await getGame(gameId);
    assert.deepEqual(after, before, "zero mutation from the stale request");
  } finally {
    stub.restore();
  }
});

test("B. an accepted answer followed by a duplicate Racer candidate: answer commits, duplicate is blocked, a non-duplicate replacement lands, revision stays coherent", async () => {
  const gameId = await makeGame();
  // Q2 will be an exact duplicate of Q1 -- forces the guard to regenerate.
  // Q3 is the real, accepted replacement.
  const stub = stubRacerQuestions(["Q1?", "Q1?", "Q3?"]);
  try {
    const opening = await callTurn(gameId);
    assert.equal(opening.data.game.qa_log[0].question_text, "Q1?");
    const revisionAtQ1 = opening.data.game.revision;

    const answered = await callTurn(gameId, { answer: "YES", expected_revision: revisionAtQ1 });
    assert.equal(answered.status, 200, "the human answer must commit correctly");
    assert.equal(answered.data.game.qa_log[0].composer_response, "YES");
    assert.equal(
      answered.data.game.qa_log.at(-1).question_text,
      "Q3?",
      "the duplicate candidate (Q1? again) must have been blocked and replaced"
    );
    assert.equal(stub.callCount(), 3, "opening + blocked duplicate + accepted replacement");

    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log.length, 2, "no phantom third entry from the blocked duplicate");
    assert.equal(canonical!.qa_log[1]!.question_text, "Q3?");
    assert.equal(canonical!.qa_log[1]!.composer_response, null);
    assert.equal(
      canonical!.revision,
      answered.data.game.revision,
      "revision is coherent between the response and canonical state"
    );
    assert.notEqual(canonical!.revision, revisionAtQ1, "revision advanced exactly once for this request");
  } finally {
    stub.restore();
  }
});
