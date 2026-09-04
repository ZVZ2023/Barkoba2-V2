import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createGame } from "../lib/gameStore";
import { GET as viewGET } from "../app/api/game/[id]/view/route";
import { __setSqlClientForTests, type SqlClient } from "../lib/corpus/db";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

// One test below installs a throwing SQL client and tears down
// DATABASE_URL/CORPUS_ENABLED afterward (to simulate a genuine outage
// cleanly) -- beforeEach re-applies the healthy baseline before every test
// so that teardown can never leave a LATER test running against a broken
// identity backend it never asked for.
beforeEach(() => {
  enableTestIdentityLookups();
});

// ---------------------------------------------------------------------------
// V2.8.6 R1 COMMIT 4 — /view, brought onto the same typed-identity +
// FIXED-NULL-SEAT-POLICY contract as /ask, /turn, /clue, /correct
// (R1 Commits 1 and 3). Human vs Human's existing behavior — the ONE mode
// this route already authorized before R1 — must be completely unaffected;
// see the dedicated test at the bottom of this file.
// ---------------------------------------------------------------------------

const COMPOSER = testPlayerId("a");
const RACER = testPlayerId("b");
const STRANGER = testPlayerId("c");

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

async function humanVsHumanGame(overrides: Partial<Parameters<typeof createGame>[1]> = {}) {
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

function viewReq(gameId: string, playerId?: string) {
  const headers: Record<string, string> = {};
  if (playerId) headers["x-bk-player"] = playerId;
  return new NextRequest(`http://localhost/api/game/${gameId}/view`, { method: "GET", headers });
}

async function callView(gameId: string, playerId?: string) {
  const res = await viewGET(viewReq(gameId, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}

test("401: /view refuses a caller presenting no identity at all", async () => {
  const { gameId } = await humanComposerGame();
  const res = await callView(gameId);
  assert.equal(res.status, 401);
  assert.equal(res.data.error, "unauthenticated");
  assert.equal(res.data.view, undefined, "no game data on an unauthorized response");
});

test("403: a leaked game id cannot be read by another session's real identity", async () => {
  const { gameId } = await humanComposerGame();
  const res = await callView(gameId, STRANGER);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "not_a_participant");
  assert.equal(res.data.view, undefined);
});

test("409 restart_required: a single-human game with no recorded seat fails closed, not open to whoever asks", async () => {
  const { gameId } = await humanComposerGame({ composer_player_id: null });
  const res = await callView(gameId, STRANGER);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "restart_required");
  assert.equal(res.data.view, undefined);
});

test("503 identity_unavailable: a backend outage is distinguished from an absent identity, no game data", async () => {
  const { gameId } = await humanComposerGame();
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  const throwingSql: SqlClient = Object.assign(
    async () => {
      throw new Error("simulated identity-store outage");
    },
    { transaction: async () => Promise.reject(new Error("simulated identity-store outage")) }
  );
  __setSqlClientForTests(throwingSql);
  try {
    const res = await callView(gameId, COMPOSER);
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "identity_unavailable");
    assert.equal(res.data.view, undefined);
  } finally {
    __setSqlClientForTests(null);
    delete process.env.DATABASE_URL;
    delete process.env.CORPUS_ENABLED;
  }
});

test("200: the real Composer (human-Composer mode) reads their own view", async () => {
  const { gameId } = await humanComposerGame();
  const res = await callView(gameId, COMPOSER);
  assert.equal(res.status, 200);
  assert.equal(res.data.view.seat, "composer");
});

test("200: the real Racer (AI-Composer mode) reads their own view", async () => {
  const { gameId } = await aiComposerGame();
  const res = await callView(gameId, RACER);
  assert.equal(res.status, 200);
  assert.equal(res.data.view.seat, "racer");
});

// ---------------------------------------------------------------------------
// Human vs Human — unaffected. This is the ONE mode /view already
// authorized before R1; resolveSeatStrict never falls back for it (same as
// resolveSeat), so every one of these outcomes must be identical to before.
// ---------------------------------------------------------------------------

test("Human vs Human: each participant still reads their own seat's view, unaffected by R1", async () => {
  const { gameId } = await humanVsHumanGame();
  const composerRes = await callView(gameId, COMPOSER);
  assert.equal(composerRes.status, 200);
  assert.equal(composerRes.data.view.seat, "composer");

  const racerRes = await callView(gameId, RACER);
  assert.equal(racerRes.status, 200);
  assert.equal(racerRes.data.view.seat, "racer");
});

test("Human vs Human: a stranger is still refused not_a_participant, unaffected by R1", async () => {
  const { gameId } = await humanVsHumanGame();
  const res = await callView(gameId, STRANGER);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "not_a_participant");
});

test("Human vs Human: an unfilled Racer seat is still not_a_participant for a stranger, never restart_required (never falls back, so nothing is 'unassigned')", async () => {
  const { gameId } = await humanVsHumanGame({ racer_player_id: null });
  const res = await callView(gameId, STRANGER);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "not_a_participant");
});
