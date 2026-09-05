import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { acquireTurnLock, createGame, getGame, newLogEntry, releaseTurnLock, saveGame } from "../lib/gameStore";
import { POST as cluePOST } from "../app/api/game/[id]/clue/route";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();
process.env.ANTHROPIC_API_KEY = "test-key";

// ---------------------------------------------------------------------------
// V2.8.6 R2 — /clue server reliability: the SAME per-game turn lock /turn
// and /ask hold, CAS-bound saves, and a mandatory expected_revision on both
// directions.
//
// Direction B (human Composer fills clue text for the AI Racer's own
// pending request) makes NO model call and needs no secret, so it is
// exercised live, end-to-end, throughout this file. Direction A (human
// Racer spends a credit, AI Composer writes the clue) needs
// getSecretForAnswering to succeed — out of live-execution reach here for
// the same reason test/askReliability.test.ts's question path is (see that
// file's own module doc: no test file is on lib/secretStore.ts's importer
// allowlist). test/gameplayAuthorization.test.ts already proves direction
// A's auth gate and its no_clue_credit business check live; this file adds
// its lock/CAS wiring as a SOURCE-orchestration assertion instead.
// ---------------------------------------------------------------------------

const COMPOSER = testPlayerId("e");
const RACER = testPlayerId("f");

async function humanComposerGameWithPendingClue(overrides: Partial<Parameters<typeof createGame>[1]> = {}) {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: "en",
    composer_player_id: COMPOSER,
    racer_player_id: RACER,
    difficulty: "hard",
    clue_mode: "minimal",
    ...overrides,
  });
  const pending = newLogEntry(1);
  pending.turn_type = "clue";
  pending.clue_text = null;
  game.qa_log = [pending];
  await saveGame(game); // blind save — CAS revision key stays at 0
  return { gameId };
}

function req(path: string, gameId: string, body: unknown, playerId?: string) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(json));
  } else {
    headers["content-length"] = "0";
  }
  if (playerId) headers["x-bk-player"] = playerId;
  return new NextRequest(`http://localhost/api/game/${gameId}/${path}`, {
    method: "POST",
    headers,
    body: json,
  });
}

async function callClue(gameId: string, body: unknown, playerId?: string) {
  const res = await cluePOST(req("clue", gameId, body, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}

async function callTurn(gameId: string, body: unknown, playerId?: string) {
  const res = await turnPOST(req("turn", gameId, body, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}

// ---------------------------------------------------------------------------
// 1. Direction B, live: happy path, stale revision, duplicate submission.
// ---------------------------------------------------------------------------

test("direction B: writing the clue text succeeds and bumps the real CAS revision", async () => {
  const { gameId } = await humanComposerGameWithPendingClue();
  const res = await callClue(gameId, { clue_text: "Not in the kitchen.", expected_revision: 0 }, COMPOSER);
  assert.equal(res.status, 200);
  assert.equal(res.data.game.qa_log[0].clue_text, "Not in the kitchen.");
  assert.equal(res.data.game.revision, 1);
  const canonical = await getGame(gameId);
  assert.equal(canonical!.revision, 1);
});

test("direction B: stale revision is rejected without mutating", async () => {
  const { gameId } = await humanComposerGameWithPendingClue();
  const res = await callClue(gameId, { clue_text: "Not in the kitchen.", expected_revision: 5 }, COMPOSER);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "stale_turn");
  const canonical = await getGame(gameId);
  assert.equal(canonical!.qa_log[0]!.clue_text, null);
});

test("direction B: a duplicate submission after the request was already filled is rejected, only one write lands", async () => {
  const { gameId } = await humanComposerGameWithPendingClue();
  const body = { clue_text: "Not in the kitchen.", expected_revision: 0 };
  const first = await callClue(gameId, body, COMPOSER);
  assert.equal(first.status, 200);

  // The first write already resolved the pending clue request, so the
  // duplicate's own pre-lock direction check no longer finds one pending —
  // it correctly reports "nothing to fill" (no_clue_request) rather than a
  // generic stale_turn, and still carries the current `game` either way.
  const second = await callClue(gameId, { clue_text: "Try the garden instead.", expected_revision: 0 }, COMPOSER);
  assert.equal(second.status, 409);
  assert.equal(second.data.error, "no_clue_request");

  const canonical = await getGame(gameId);
  assert.equal(canonical!.qa_log[0]!.clue_text, "Not in the kitchen.", "the duplicate's text never overwrote the first write");
});

test("missing expected_revision on /clue is a 400, not a silent unsafe mutation", async () => {
  const { gameId } = await humanComposerGameWithPendingClue();
  const res = await callClue(gameId, { clue_text: "Not in the kitchen." }, COMPOSER);
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "missing_expected_revision");
  const canonical = await getGame(gameId);
  assert.equal(canonical!.qa_log[0]!.clue_text, null);
});

// ---------------------------------------------------------------------------
// 2. Lock held — direction B respects an externally-held lock, and (the
// cross-route requirement) a clue-held lock blocks a concurrent /turn.
// ---------------------------------------------------------------------------

test("lock held: direction B is rejected while the game's turn lock is already held, with no mutation", async () => {
  const { gameId } = await humanComposerGameWithPendingClue();
  const held = await acquireTurnLock(gameId, 30);
  assert.equal(held, true);
  try {
    const res = await callClue(gameId, { clue_text: "Not in the kitchen.", expected_revision: 0 }, COMPOSER);
    assert.equal(res.status, 409);
    assert.equal(res.data.error, "turn_in_progress");
    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log[0]!.clue_text, null);
  } finally {
    await releaseTurnLock(gameId);
  }
});

test("a clue-held lock blocks a concurrent /turn on the SAME game with 409 turn_in_progress and no mutation", async () => {
  const { gameId } = await humanComposerGameWithPendingClue();
  // Simulates a /clue direction-B call currently holding this game's lock —
  // proving /clue and /turn share the SAME lock key, not two independently
  // guarded mechanisms that could drift apart.
  const held = await acquireTurnLock(gameId, 30);
  assert.equal(held, true);
  try {
    const res = await callTurn(gameId, undefined, COMPOSER);
    assert.equal(res.status, 409);
    assert.equal(res.data.error, "turn_in_progress");
    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log.length, 1, "no new Racer turn was appended");
    assert.equal(canonical!.qa_log[0]!.clue_text, null, "the pending clue itself is untouched");
  } finally {
    await releaseTurnLock(gameId);
  }
});

test("a /turn-held lock blocks a concurrent /clue direction-B call on the SAME game", async () => {
  const { gameId } = await humanComposerGameWithPendingClue();
  const held = await acquireTurnLock(gameId, 30); // simulates /turn holding it
  assert.equal(held, true);
  try {
    const res = await callClue(gameId, { clue_text: "Not in the kitchen.", expected_revision: 0 }, COMPOSER);
    assert.equal(res.status, 409);
    assert.equal(res.data.error, "turn_in_progress");
  } finally {
    await releaseTurnLock(gameId);
  }
});

// ---------------------------------------------------------------------------
// 3. Direction A's lock/CAS wiring — SOURCE-orchestration assertion (see
// module doc: a live success test needs a real secret, deliberately out of
// test/ reach). Proves the credit spend and the model call both run AFTER
// the lock is held and the revision re-checked, and the CAS save follows
// the mutation.
// ---------------------------------------------------------------------------

test("direction A: SOURCE — the credit/model spend and the CAS save both run inside the held lock, after the post-lock revision re-check", () => {
  const src = readFileSync("app/api/game/[id]/clue/route.ts", "utf8");
  const lockAt = src.indexOf("acquireTurnLock(gameId, CLUE_TURN_LOCK_TTL_SECONDS)");
  const postLockRevisionCheckAt = src.indexOf("if (body.expected_revision !== game.revision) {\n      return staleTurn(game);\n    }");
  const directionAAt = src.indexOf("Direction A — the human Racer is spending a credit");
  const creditCheckAt = src.indexOf("clueCreditsAvailable(game) < 1");
  const requestClueAt = src.indexOf("requestClueFromComposer(");
  const saveAt = src.indexOf("saveGameIfRevisionMatches(game, revisionAtLockTime)", requestClueAt);
  assert.ok(lockAt >= 0 && postLockRevisionCheckAt > lockAt, "lock acquisition must precede the post-lock revision re-check");
  assert.ok(directionAAt > postLockRevisionCheckAt, "direction A's own logic must run after the post-lock revision re-check");
  assert.ok(creditCheckAt > directionAAt && requestClueAt > creditCheckAt, "credit check must precede the model call");
  assert.ok(saveAt > requestClueAt, "the CAS save must follow the model call, not precede it");
});
