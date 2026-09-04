import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createGame, newLogEntry, saveGame } from "../lib/gameStore";
import { POST as askPOST } from "../app/api/game/[id]/ask/route";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { POST as cluePOST } from "../app/api/game/[id]/clue/route";
import { POST as correctPOST } from "../app/api/game/[id]/correct/route";
import { __setSqlClientForTests, type SqlClient } from "../lib/corpus/db";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();

// ---------------------------------------------------------------------------
// V2.8.6 R1 SECURITY COMMIT — /ask, /turn, /clue (both directions) and
// /correct never checked who was calling them. Any caller who knew or
// guessed game_id could read private game state or act in either seat. This
// file proves the retrofit: every route now resolves a real identity and
// requires it to own the seat the action needs, and every EXISTING
// 403/409 contract (wrong game mode, wrong phase, etc.) still fires exactly
// as before — the new check is additive, not a replacement for those.
// ---------------------------------------------------------------------------

const COMPOSER = testPlayerId("a"); // owns the human-Composer game below
const RACER = testPlayerId("b"); // owns the AI-Composer game's human Racer seat
const STRANGER = testPlayerId("c"); // owns neither — a leaked-id attacker stand-in

async function humanComposerGame(overrides: Partial<Parameters<typeof createGame>[1]> = {}) {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: "en",
    composer_player_id: COMPOSER,
    ...overrides,
  });
  return { gameId, game };
}

async function aiComposerGame(overrides: Partial<Parameters<typeof createGame>[1]> = {}) {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "ai",
    racer_kind: "human",
    max_questions: 20,
    game_language: "en",
    racer_player_id: RACER,
    ...overrides,
  });
  return { gameId, game };
}

function req(path: string, body: unknown, playerId?: string, method = "POST") {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(json));
  } else if (method === "POST") {
    headers["content-length"] = "0";
  }
  if (playerId) headers["x-bk-player"] = playerId;
  return new NextRequest(`http://localhost${path}`, { method, headers, body: json });
}

async function callAsk(gameId: string, body: unknown, playerId?: string) {
  const res = await askPOST(req(`/api/game/${gameId}/ask`, body, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}
async function callTurn(gameId: string, body: unknown, playerId?: string) {
  const res = await turnPOST(req(`/api/game/${gameId}/turn`, body, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}
async function callClue(gameId: string, body: unknown, playerId?: string) {
  const res = await cluePOST(req(`/api/game/${gameId}/clue`, body, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}
async function callCorrect(gameId: string, body: unknown, playerId?: string) {
  const res = await correctPOST(req(`/api/game/${gameId}/correct`, body, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}

// ---------------------------------------------------------------------------
// 1. No identity at all -> 401, stable error code, on every route.
// ---------------------------------------------------------------------------

test("401: /ask refuses a caller presenting no identity at all", async () => {
  const { gameId } = await aiComposerGame();
  const res = await callAsk(gameId, { question: "Is it alive?" });
  assert.equal(res.status, 401);
  assert.equal(res.data.error, "unauthenticated");
});

test("401: /turn refuses a caller presenting no identity at all", async () => {
  const { gameId } = await humanComposerGame();
  const res = await callTurn(gameId, undefined);
  assert.equal(res.status, 401);
  assert.equal(res.data.error, "unauthenticated");
});

test("401: /correct refuses a caller presenting no identity at all", async () => {
  const { gameId } = await humanComposerGame();
  const res = await callCorrect(gameId, { turn_index: 1, answer: "NO" });
  assert.equal(res.status, 401);
  assert.equal(res.data.error, "unauthenticated");
});

test("401: /clue refuses a caller presenting no identity at all (direction A)", async () => {
  const { gameId } = await aiComposerGame({ difficulty: "hard", clue_mode: "minimal" });
  const res = await callClue(gameId, {});
  assert.equal(res.status, 401);
  assert.equal(res.data.error, "unauthenticated");
});

// ---------------------------------------------------------------------------
// 2. A real identity that owns neither seat -> 403, on every route. This is
// also the "leaked game id from another session" scenario: STRANGER holds a
// perfectly valid identity and a perfectly valid game of their own, and
// tries to act on someone else's game id instead.
// ---------------------------------------------------------------------------

test("403: a leaked game id cannot be acted on by another session's real identity (/ask)", async () => {
  const { gameId: leakedGameId } = await aiComposerGame(); // owned by RACER
  await aiComposerGame({ racer_player_id: STRANGER }); // STRANGER's own, unrelated game exists too
  const res = await callAsk(leakedGameId, { question: "Is it alive?" }, STRANGER);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "not_a_participant");
});

test("403: a leaked game id cannot be acted on by another session's real identity (/turn)", async () => {
  const { gameId: leakedGameId } = await humanComposerGame(); // owned by COMPOSER
  await humanComposerGame({ composer_player_id: STRANGER }); // STRANGER's own, unrelated game
  const res = await callTurn(leakedGameId, undefined, STRANGER);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "not_a_participant");
});

test("403: a leaked game id cannot be acted on by another session's real identity (/correct)", async () => {
  const { gameId, game } = await humanComposerGame();
  const e = newLogEntry(1);
  e.question_text = "Is it alive?";
  e.composer_response = "YES";
  e.answered_at = new Date().toISOString();
  game.qa_log = [e];
  game.question_count = 1;
  await saveGame(game);

  const res = await callCorrect(gameId, { turn_index: 1, answer: "NO", expected_log_length: 1 }, STRANGER);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "not_a_participant");
  // and nothing was mutated by the refused attempt:
  assert.equal(res.data.game, undefined);
});

test("403: a leaked game id cannot be acted on by another session's real identity (/clue, direction A)", async () => {
  const { gameId } = await aiComposerGame({ difficulty: "hard", clue_mode: "minimal" });
  const res = await callClue(gameId, {}, STRANGER);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "not_a_participant");
});

test("403: a leaked game id cannot be acted on by another session's real identity (/clue, direction B)", async () => {
  const { gameId, game } = await humanComposerGame({ difficulty: "hard", clue_mode: "minimal" });
  const pending = newLogEntry(1);
  pending.turn_type = "clue";
  pending.clue_text = null;
  game.qa_log = [pending];
  await saveGame(game);

  const res = await callClue(gameId, { clue_text: "Not in the kitchen." }, STRANGER);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "not_a_participant");
});

// ---------------------------------------------------------------------------
// 3. Correct seat -> the route's ORDINARY behavior continues past the new
// gate. Each test drives the request far enough to reach the next
// PRE-EXISTING check or a real state change, proving auth is additive.
// ---------------------------------------------------------------------------

test("200: the real Racer's own /ask concession is accepted (correct seat, existing behavior)", async () => {
  const { gameId } = await aiComposerGame();
  // V2.8.6 R2 — expected_revision is now required on every /ask mutation; a
  // freshly created game starts at revision 0.
  const res = await callAsk(gameId, { concede: true, expected_revision: 0 }, RACER);
  assert.equal(res.status, 200);
  assert.equal(res.data.game.phase, "resolving");
  assert.equal(res.data.game.final_action, "concede");
});

test("200: the real Composer's own /turn bare poll is accepted (correct seat, existing behavior)", async () => {
  const { gameId } = await humanComposerGame();
  const res = await callTurn(gameId, undefined, COMPOSER);
  assert.equal(res.status, 200);
  assert.ok(res.data.game.qa_log.length >= 1, "Phase One's deterministic opening question is still produced");
});

test("200: the real Composer's own /correct rewinds an answer (correct seat, existing behavior)", async () => {
  const { gameId, game } = await humanComposerGame();
  const e = newLogEntry(1);
  e.question_text = "Is it alive?";
  e.composer_response = "YES";
  e.answered_at = new Date().toISOString();
  game.qa_log = [e];
  game.question_count = 1;
  await saveGame(game);

  const res = await callCorrect(gameId, { turn_index: 1, answer: "NO", expected_log_length: 1 }, COMPOSER);
  assert.equal(res.status, 200);
  assert.equal(res.data.game.qa_log[0].composer_response, "NO");
});

test("409 no_clue_credit: the real Racer passes the /clue auth gate and reaches the EXISTING credit check", async () => {
  // Deliberately zero credits (question_count defaults to 0): proves the
  // request cleared authorization and was stopped by the pre-existing
  // business rule, not by the new check.
  const { gameId } = await aiComposerGame({ difficulty: "hard", clue_mode: "minimal" });
  // V2.8.6 R2 — expected_revision is now required on every /clue mutation.
  const res = await callClue(gameId, { expected_revision: 0 }, RACER);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "no_clue_credit");
});

test("200: the real Composer writes clue text for the AI Racer's own pending request (/clue direction B)", async () => {
  const { gameId, game } = await humanComposerGame({ difficulty: "hard", clue_mode: "minimal" });
  const pending = newLogEntry(1);
  pending.turn_type = "clue";
  pending.clue_text = null;
  game.qa_log = [pending];
  await saveGame(game);

  const res = await callClue(gameId, { clue_text: "Not in the kitchen.", expected_revision: 0 }, COMPOSER);
  assert.equal(res.status, 200);
  assert.equal(res.data.game.qa_log[0].clue_text, "Not in the kitchen.");
});

// ---------------------------------------------------------------------------
// 4. Wrong game mode -> the EXISTING 403/409 contract fires unchanged, ahead
// of (or instead of) the new auth gate.
// ---------------------------------------------------------------------------

test("409 wrong_mode: /ask on an AI-Racer game is refused exactly as before, even for that game's real Composer", async () => {
  const { gameId } = await humanComposerGame(); // racer_kind: "ai" -- /ask does not apply here
  const res = await callAsk(gameId, { question: "x" }, COMPOSER);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "wrong_mode");
});

test("409 no_clue_request: /clue direction-A gate on an AI-Racer game is refused exactly as before", async () => {
  const { gameId } = await humanComposerGame({ difficulty: "hard", clue_mode: "minimal" }); // racer_kind: "ai"
  const res = await callClue(gameId, {}, COMPOSER);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "no_clue_request");
});

// ---------------------------------------------------------------------------
// 5. Legacy null seat (an AI-Composer or human-Composer game that predates
// this fix, or a defect that left a seat unrecorded) -> FAIL CLOSED. No
// caller, including a real, validly-shaped identity, is assigned the seat
// retroactively; the response is a stable "restart required" state, and the
// only thing logged is the game id and the condition, never game content.
// ---------------------------------------------------------------------------

test("409 restart_required: an AI-Composer game with no recorded racer seat fails closed on /ask", async () => {
  const { gameId } = await aiComposerGame({ racer_player_id: null }); // simulates a pre-R1 record
  const res = await callAsk(gameId, { question: "Is it alive?" }, RACER);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "restart_required");
});

test("409 restart_required: an AI-Composer game with no recorded racer seat fails closed on /clue direction A", async () => {
  const { gameId } = await aiComposerGame({ racer_player_id: null, difficulty: "hard", clue_mode: "minimal" });
  const res = await callClue(gameId, {}, RACER);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "restart_required");
});

test("409 restart_required: a human-Composer game with no recorded composer seat fails closed on /turn", async () => {
  const { gameId } = await humanComposerGame({ composer_player_id: null });
  const res = await callTurn(gameId, undefined, COMPOSER);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "restart_required");
});

test("409 restart_required: a human-Composer game with no recorded composer seat fails closed on /correct", async () => {
  const { gameId, game } = await humanComposerGame({ composer_player_id: null });
  const e = newLogEntry(1);
  e.question_text = "Is it alive?";
  e.composer_response = "YES";
  e.answered_at = new Date().toISOString();
  game.qa_log = [e];
  game.question_count = 1;
  await saveGame(game);

  const res = await callCorrect(gameId, { turn_index: 1, answer: "NO", expected_log_length: 1 }, COMPOSER);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "restart_required");
});

test("the legacy-seat warning logs only the game id and the condition, never qa_log/target content", async () => {
  const { gameId } = await aiComposerGame({ racer_player_id: null });
  const original = console.warn;
  const logged: unknown[][] = [];
  // eslint-disable-next-line no-console
  console.warn = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    await callAsk(gameId, { question: "Is it alive?" }, RACER);
  } finally {
    console.warn = original;
  }
  assert.equal(logged.length, 1, "exactly one warning for the one refused attempt");
  const message = String(logged[0]![0]);
  assert.match(message, new RegExp(gameId), "must identify which game, for operability");
  assert.doesNotMatch(message, /qa_log|question_text|composer_response|target|clue_text/i);
});

// ---------------------------------------------------------------------------
// 6. New AI-Composer creation records the racer seat. Source-structure
// assertion, same idiom as test/publicRacerAuthority.test.ts: the create
// route needs a live KV, secret store, Validator and Composer-target model
// call to execute end-to-end, so nothing here invokes it — a source match is
// a weaker claim than an executed one, stated plainly rather than implied.
// ---------------------------------------------------------------------------

const CREATE_ROUTE_SRC = readFileSync("app/api/game/create/route.ts", "utf8");

test("SOURCE: the ai_composer creation branch records racer_player_id from the resolved caller", () => {
  const aiComposerBranchStart = CREATE_ROUTE_SRC.indexOf('body.mode === "ai_composer"');
  assert.ok(aiComposerBranchStart >= 0, "could not locate the ai_composer branch");
  const aiComposerBranch = CREATE_ROUTE_SRC.slice(aiComposerBranchStart, aiComposerBranchStart + 4000);
  assert.match(
    aiComposerBranch,
    /racer_player_id:\s*playerId,/,
    "a new AI-Composer game must record the human Racer's resolved identity, not leave the seat unset"
  );
});

// ---------------------------------------------------------------------------
// 7. V2.8.6 R1 COMMIT 3 — the identity backend itself failing (distinct from
// nobody presenting an identity at all) must surface as 503
// identity_unavailable, never as 401, and never reach the seat check or
// touch game content.
// ---------------------------------------------------------------------------

function installThrowingIdentityBackend(): { restore: () => void } {
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  const throwingSql: SqlClient = Object.assign(
    async () => {
      throw new Error("simulated identity-store outage");
    },
    { transaction: async () => Promise.reject(new Error("simulated identity-store outage")) }
  );
  __setSqlClientForTests(throwingSql);
  return {
    restore: () => {
      __setSqlClientForTests(null);
      delete process.env.DATABASE_URL;
      delete process.env.CORPUS_ENABLED;
    },
  };
}

test("503 identity_unavailable: /ask distinguishes a backend outage from an absent identity", async () => {
  const { gameId } = await aiComposerGame();
  const backend = installThrowingIdentityBackend();
  try {
    const res = await callAsk(gameId, { question: "Is it alive?" }, RACER);
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "identity_unavailable");
  } finally {
    backend.restore();
  }
});

test("503 identity_unavailable: /turn distinguishes a backend outage from an absent identity", async () => {
  const { gameId } = await humanComposerGame();
  const backend = installThrowingIdentityBackend();
  try {
    const res = await callTurn(gameId, undefined, COMPOSER);
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "identity_unavailable");
  } finally {
    backend.restore();
  }
});

test("503 identity_unavailable: /correct distinguishes a backend outage from an absent identity", async () => {
  const { gameId } = await humanComposerGame();
  const backend = installThrowingIdentityBackend();
  try {
    const res = await callCorrect(gameId, { turn_index: 1, answer: "NO", expected_log_length: 1 }, COMPOSER);
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "identity_unavailable");
  } finally {
    backend.restore();
  }
});

test("503 identity_unavailable: /clue distinguishes a backend outage from an absent identity", async () => {
  const { gameId } = await aiComposerGame({ difficulty: "hard", clue_mode: "minimal" });
  const backend = installThrowingIdentityBackend();
  try {
    const res = await callClue(gameId, {}, RACER);
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "identity_unavailable");
  } finally {
    backend.restore();
  }
});
