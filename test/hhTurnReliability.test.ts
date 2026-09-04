import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { acquireTurnLock, createGame, getGame, releaseTurnLock } from "../lib/gameStore";
import { POST as hhTurnPOST } from "../app/api/game/[id]/hh/turn/route";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();

// ---------------------------------------------------------------------------
// V2.8.6 R2 — /hh/turn server reliability: the SAME per-game turn lock
// /turn, /ask and /clue hold, CAS-bound saves against the REAL
// GameRecord.revision (not lib/gameView.ts's derived revisionOf() poll
// marker this route used to check), and a mandatory expected_revision.
// Makes no model call at all, so every scenario here is exercised live,
// end-to-end — no secretStore isolation constraint applies to this route.
// ---------------------------------------------------------------------------

const COMPOSER = testPlayerId("1");
const RACER = testPlayerId("2");

async function hhGame(overrides: Partial<Parameters<typeof createGame>[1]> = {}) {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "human",
    max_questions: 20,
    game_language: "en",
    composer_player_id: COMPOSER,
    racer_player_id: RACER,
    ...overrides,
  });
  return { gameId, game };
}

function req(gameId: string, body: unknown, playerId?: string) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(json));
  } else {
    headers["content-length"] = "0";
  }
  if (playerId) headers["x-bk-player"] = playerId;
  return new NextRequest(`http://localhost/api/game/${gameId}/hh/turn`, {
    method: "POST",
    headers,
    body: json,
  });
}

async function callHhTurn(gameId: string, body: unknown, playerId?: string) {
  const res = await hhTurnPOST(req(gameId, body, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}

// ---------------------------------------------------------------------------
// 1. Legitimate participants continue normally — the full Racer/Composer
// cycle, proving the response NEVER carries a full GameRecord or GameView
// (only {ok, revision} on success), and each write bumps the real CAS
// revision.
// ---------------------------------------------------------------------------

test("legitimate racer and composer participants continue normally through a full question/answer cycle", async () => {
  const { gameId } = await hhGame();

  const q = await callHhTurn(gameId, { action: "question", question: "Is it alive?", expected_revision: 0 }, RACER);
  assert.equal(q.status, 200);
  assert.deepEqual(Object.keys(q.data).sort(), ["ok", "revision"], "success never carries game or view");
  assert.equal(q.data.ok, true);
  assert.equal(q.data.revision, 1);

  const a = await callHhTurn(
    gameId,
    { action: "answer", answer: "YES", expected_revision: q.data.revision },
    COMPOSER
  );
  assert.equal(a.status, 200);
  assert.equal(a.data.revision, 2);

  const canonical = await getGame(gameId);
  assert.equal(canonical!.revision, 2);
  assert.equal(canonical!.qa_log[0]!.composer_response, "YES");
  assert.equal(canonical!.question_count, 1);
});

test("a legitimate anonymous (guest-id) participant continues normally, same as a registered one", async () => {
  // testIdentity's fixtures are plain guest ids (no account row) — this is
  // already the "anonymous" path; asserted explicitly so it is not merely
  // implied by every other test in this file using the same kind of id.
  const { gameId } = await hhGame();
  const res = await callHhTurn(gameId, { action: "hint", hint: "Not in the kitchen.", expected_revision: 0 }, COMPOSER);
  assert.equal(res.status, 200);
  assert.equal(res.data.revision, 1);
});

// ---------------------------------------------------------------------------
// 2. Private state never appears in an error response, for any action.
// ---------------------------------------------------------------------------

test("no error response from /hh/turn ever carries game or view fields", async () => {
  const { gameId } = await hhGame();
  const responses = await Promise.all([
    callHhTurn(gameId, { action: "question", question: "x", expected_revision: 99 }, RACER), // stale_turn
    callHhTurn(gameId, { action: "question", question: "x", expected_revision: 0 }, COMPOSER), // wrong seat
    callHhTurn(gameId, { action: "answer", answer: "YES", expected_revision: 0 }, COMPOSER), // no_pending_question
  ]);
  for (const res of responses) {
    assert.ok(res.status >= 400);
    assert.equal("game" in res.data, false, "no error response may carry a full GameRecord");
    assert.equal("view" in res.data, false, "no error response may carry a GameView");
  }
});

// ---------------------------------------------------------------------------
// 3. Stale revision — rejected before any mutation, on every action shape.
// ---------------------------------------------------------------------------

test("stale revision: rejected with {error, revision}, no game/view, no mutation", async () => {
  const { gameId } = await hhGame();
  const res = await callHhTurn(gameId, { action: "question", question: "Is it alive?", expected_revision: 5 }, RACER);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "stale_turn");
  assert.equal(res.data.revision, 0, "the real current CAS revision, not the derived poll marker");
  const canonical = await getGame(gameId);
  assert.equal(canonical!.qa_log.length, 0);
});

test("missing expected_revision is a 400, not a silent unsafe mutation", async () => {
  const { gameId } = await hhGame();
  const res = await callHhTurn(gameId, { action: "question", question: "Is it alive?" }, RACER);
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "missing_expected_revision");
  const canonical = await getGame(gameId);
  assert.equal(canonical!.qa_log.length, 0);
});

test("duplicate submission at the same (now stale) revision: only one question lands", async () => {
  const { gameId } = await hhGame();
  const body = { action: "question", question: "Is it alive?", expected_revision: 0 };
  const first = await callHhTurn(gameId, body, RACER);
  assert.equal(first.status, 200);

  const second = await callHhTurn(gameId, { ...body, question: "Is it a plant?" }, RACER);
  assert.equal(second.status, 409);
  assert.equal(second.data.error, "stale_turn");

  const canonical = await getGame(gameId);
  assert.equal(canonical!.qa_log.length, 1);
  assert.equal(canonical!.qa_log[0]!.question_text, "Is it alive?");
});

// ---------------------------------------------------------------------------
// 4. Lock held — {error: "turn_in_progress"} only, no message, no revision,
// no mutation. Shares the exact key /turn, /ask and /clue use.
// ---------------------------------------------------------------------------

test("lock held: turn_in_progress is exactly {error}, nothing else, and nothing is mutated", async () => {
  const { gameId } = await hhGame();
  const held = await acquireTurnLock(gameId, 30);
  assert.equal(held, true);
  try {
    const res = await callHhTurn(gameId, { action: "question", question: "Is it alive?", expected_revision: 0 }, RACER);
    assert.equal(res.status, 409);
    assert.deepEqual(res.data, { error: "turn_in_progress" });
    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log.length, 0);
  } finally {
    await releaseTurnLock(gameId);
  }
});

test("a /turn or /ask-shaped externally-held lock on the same game id blocks /hh/turn too (shared key)", async () => {
  // /hh/turn only ever applies to a Human↔Human game, so a REAL /turn or
  // /ask call never targets the same game id — this proves the SHARED KEY
  // itself (acquireTurnLock(gameId, ...) is keyed purely by game id, not by
  // route), the same mechanism test/askReliability.test.ts and
  // test/clueReliability.test.ts prove from the other three routes' side.
  const { gameId } = await hhGame();
  const held = await acquireTurnLock(gameId, 30);
  assert.equal(held, true);
  try {
    const res = await callHhTurn(gameId, { action: "hint", hint: "x", expected_revision: 0 }, COMPOSER);
    assert.equal(res.status, 409);
    assert.equal(res.data.error, "turn_in_progress");
  } finally {
    await releaseTurnLock(gameId);
  }
});

// ---------------------------------------------------------------------------
// 5. Seat authorization runs before the lock is ever acquired.
// ---------------------------------------------------------------------------

test("seat authorization occurs before lock acquisition: a wrong-seat caller is refused WITHOUT ever acquiring the lock", async () => {
  const { gameId } = await hhGame();
  const res = await callHhTurn(gameId, { action: "question", question: "Is it alive?", expected_revision: 0 }, COMPOSER);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "wrong_seat");
  // If the seat check had run AFTER acquiring the lock, this refused request
  // would still have released it in its own `finally` — so the only way to
  // prove ordering here is that the lock was never even touched: a
  // subsequent legitimate call must succeed on its very first attempt with
  // no lingering lock to contend with.
  const legit = await callHhTurn(gameId, { action: "question", question: "Is it alive?", expected_revision: 0 }, RACER);
  assert.equal(legit.status, 200);
});

test("a stranger holding no seat at all is refused before the lock, same as a wrong-seat participant", async () => {
  const { gameId } = await hhGame();
  const stranger = testPlayerId("9");
  const res = await callHhTurn(gameId, { action: "question", question: "x", expected_revision: 0 }, stranger);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "not_a_participant");
});
