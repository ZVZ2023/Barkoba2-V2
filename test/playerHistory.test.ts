import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { listPlayerHistory } from "../lib/corpus/gameCorpus";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { PLAYER_HEADER } from "../lib/playerIdentity";
import { GET as readHistory } from "../app/api/player/history/route";

// ---------------------------------------------------------------------------
// V2.6.x — GET /api/player/history.
//
// SCOPE, STATED HONESTLY, same as test/corpusPersistence.test.ts: there is no
// PostgreSQL in this test environment. These tests verify the WHERE clause
// scopes to exactly one player_id, the role-derivation logic, and the route's
// authority/error handling — not that games_player_history is actually used
// by Postgres's planner, which requires a live Neon run.
// ---------------------------------------------------------------------------

interface GameRow {
  operational_game_id: string;
  player_id: string;
  created_at: string;
  lifecycle_state: string;
  outcome: string | null;
  composer_player_id: string | null;
  racer_player_id: string | null;
  composer_kind: string;
  racer_kind: string;
  /** V2.8.8.5 — added by the LEFT JOIN to game_targets/game_resolutions. */
  game_language: string;
  max_questions: number;
  question_count: number;
  target: string | null;
  final_guess_text: string | null;
}

let games: GameRow[];
/** How many times the list query itself was actually invoked -- V2.8.8.5's own query-efficiency proof (one call for the whole list, never one per card). */
let listQueryCalls = 0;

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const query = strings.join(" ");
  if (/FROM corpus\.games g/.test(query) && /WHERE g\.player_id =/.test(query)) {
    listQueryCalls += 1;
    const playerId = String(values[0]);
    const rows = games
      .filter((g) => g.player_id === playerId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return Promise.resolve(rows as unknown as Record<string, unknown>[]);
  }
  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

beforeEach(() => {
  games = [];
  listQueryCalls = 0;
  process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
});

function row(overrides: Partial<GameRow>): GameRow {
  return {
    operational_game_id: "00000000-0000-0000-0000-000000000001",
    player_id: "a".repeat(32),
    created_at: "2026-08-01T10:00:00.000Z",
    lifecycle_state: "completed",
    outcome: "racer_correct",
    composer_player_id: null,
    racer_player_id: null,
    composer_kind: "human",
    racer_kind: "ai",
    game_language: "hu",
    max_questions: 20,
    question_count: 12,
    target: "bicikli",
    final_guess_text: "bicikli",
    ...overrides,
  };
}

test("returns only the requested player's games, scoped by the WHERE clause", async () => {
  const mine = "a".repeat(32);
  const someoneElse = "b".repeat(32);
  games.push(
    row({ operational_game_id: "1", player_id: mine }),
    row({ operational_game_id: "2", player_id: someoneElse }),
    row({ operational_game_id: "3", player_id: mine })
  );

  const history = await listPlayerHistory(mine);
  assert.equal(history.ok, true);
  assert.equal(history.games.length, 2);
  assert.deepEqual(
    history.games.map((g) => g.game_id).sort(),
    ["1", "3"]
  );
});

test("orders newest first", async () => {
  const playerId = "c".repeat(32);
  games.push(
    row({ operational_game_id: "old", player_id: playerId, created_at: "2026-01-01T00:00:00.000Z" }),
    row({ operational_game_id: "new", player_id: playerId, created_at: "2026-06-01T00:00:00.000Z" })
  );

  const history = await listPlayerHistory(playerId);
  assert.deepEqual(history.games.map((g) => g.game_id), ["new", "old"]);
});

test("derives role from the named seat columns when present", async () => {
  const playerId = "d".repeat(32);
  const other = "e".repeat(32);
  games.push(
    row({ operational_game_id: "as-composer", player_id: playerId, composer_player_id: playerId, racer_player_id: other, composer_kind: "human", racer_kind: "human" }),
    row({ operational_game_id: "as-racer", player_id: playerId, composer_player_id: other, racer_player_id: playerId, composer_kind: "human", racer_kind: "human" })
  );

  const history = await listPlayerHistory(playerId);
  const byId = Object.fromEntries(history.games.map((g) => [g.game_id, g.role]));
  assert.equal(byId["as-composer"], "composer");
  assert.equal(byId["as-racer"], "racer");
});

test("falls back to composer_kind/racer_kind for pre-V2.3 rows with no seat columns", async () => {
  const playerId = "f".repeat(32);
  games.push(
    row({
      operational_game_id: "legacy-composer",
      player_id: playerId,
      composer_player_id: null,
      racer_player_id: null,
      composer_kind: "human",
      racer_kind: "ai",
    }),
    row({
      operational_game_id: "legacy-racer",
      player_id: playerId,
      composer_player_id: null,
      racer_player_id: null,
      composer_kind: "ai",
      racer_kind: "human",
    })
  );

  const history = await listPlayerHistory(playerId);
  const byId = Object.fromEntries(history.games.map((g) => [g.game_id, g.role]));
  assert.equal(byId["legacy-composer"], "composer");
  assert.equal(byId["legacy-racer"], "racer");
});

test("outcome and lifecycle_state pass through honestly for an unfinished game", async () => {
  const playerId = "1".repeat(32);
  games.push(
    row({
      operational_game_id: "abandoned",
      player_id: playerId,
      lifecycle_state: "abandoned_inferred",
      outcome: null,
    })
  );

  const history = await listPlayerHistory(playerId);
  assert.equal(history.games.length, 1);
  const [entry] = history.games;
  assert.equal(entry!.lifecycle_state, "abandoned_inferred");
  assert.equal(entry!.outcome, null);
});

// ---------------------------------------------------------------------------
// V2.8.8.5 — MEANINGFUL GAME-HISTORY CARDS.
// ---------------------------------------------------------------------------

test("completed-target visibility: a completed, owned game's target and final guess are returned", async () => {
  const playerId = "7".repeat(32);
  games.push(
    row({
      operational_game_id: "done",
      player_id: playerId,
      lifecycle_state: "completed",
      target: "bicikli",
      final_guess_text: "kerékpár",
      max_questions: 20,
      question_count: 14,
    })
  );
  const history = await listPlayerHistory(playerId);
  const [entry] = history.games;
  assert.equal(entry!.target, "bicikli");
  assert.equal(entry!.final_guess_text, "kerékpár");
  assert.equal(entry!.max_questions, 20);
  assert.equal(entry!.question_count, 14);
});

test("incomplete-target secrecy: an in_progress game's target/guess are NEVER returned, even though the row carries them (defense in depth against the join alone)", async () => {
  const playerId = "8".repeat(32);
  games.push(
    row({
      operational_game_id: "live",
      player_id: playerId,
      lifecycle_state: "in_progress",
      // Simulates the join returning a value even though this should be
      // structurally impossible in production (game_targets is only ever
      // written at declassification) -- proving the EXPLICIT lifecycle
      // re-check, not just trust in the join's natural behavior.
      target: "titkos cél",
      final_guess_text: "próbálkozás",
    })
  );
  const history = await listPlayerHistory(playerId);
  const [entry] = history.games;
  assert.equal(entry!.target, null, "target must never leak for a non-completed game, even if the join somehow returned one");
  assert.equal(entry!.final_guess_text, null);
});

test("incomplete-target secrecy: abandoned_inferred and stalled_resolving also never expose target/guess", async () => {
  const playerId = "9".repeat(32);
  for (const lifecycle_state of ["abandoned_inferred", "stalled_resolving", "expired_unresolved"]) {
    games = [row({ operational_game_id: "g", player_id: playerId, lifecycle_state, target: "x", final_guess_text: "y" })];
    const history = await listPlayerHistory(playerId);
    assert.equal(history.games[0]!.target, null, `${lifecycle_state} must never expose target`);
    assert.equal(history.games[0]!.final_guess_text, null, `${lifecycle_state} must never expose final_guess_text`);
  }
});

test("non-owner isolation: the WHERE clause itself, not application filtering, keeps another player's completed game (and its target) out of this list", async () => {
  const mine = "3".repeat(32);
  const other = "4".repeat(32);
  games.push(
    row({ operational_game_id: "mine", player_id: mine, target: "sajátom" }),
    row({ operational_game_id: "not-mine", player_id: other, target: "másé" })
  );
  const history = await listPlayerHistory(mine);
  assert.equal(history.games.length, 1);
  assert.equal(history.games[0]!.game_id, "mine");
  assert.doesNotMatch(JSON.stringify(history.games), /másé/);
});

test("missing historical fields: a completed game whose target/resolution row is itself anomalously absent reports null, not a fabricated value", async () => {
  const playerId = "5".repeat(32);
  games.push(
    row({
      operational_game_id: "gap",
      player_id: playerId,
      lifecycle_state: "completed",
      target: null,
      final_guess_text: null,
    })
  );
  const history = await listPlayerHistory(playerId);
  assert.equal(history.games[0]!.target, null);
  assert.equal(history.games[0]!.final_guess_text, null);
});

test("query efficiency: a list of many games costs exactly ONE query, never one per card", async () => {
  const playerId = "0".repeat(32);
  for (let i = 0; i < 12; i += 1) {
    games.push(row({ operational_game_id: `g${i}`, player_id: playerId }));
  }
  const history = await listPlayerHistory(playerId);
  assert.equal(history.games.length, 12);
  assert.equal(listQueryCalls, 1, "the whole list must be produced by exactly one query, regardless of how many games it returns");
});

test("V2.8.8.2 — a corpus read failure returns ok:false with an empty list, never silently ok:true", async () => {
  __setSqlClientForTests((() => Promise.reject(new Error("neon unavailable"))) as unknown as typeof fakeSql);
  const history = await listPlayerHistory("2".repeat(32));
  assert.equal(history.ok, false);
  assert.deepEqual(history.games, []);
});

test("V2.8.8.2 — corpus genuinely not configured is ok:true with an empty list, NOT a failure -- distinct from a real read failure", async () => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  const history = await listPlayerHistory("6".repeat(32));
  assert.equal(history.ok, true);
  assert.deepEqual(history.games, []);
  // Restore for afterEach's own (harmless, redundant) cleanup and any later test in this file.
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
});

test("GET /api/player/history refuses an unidentifiable caller", async () => {
  const response = await readHistory(
    new Request("https://barkoba.test/api/player/history") as Parameters<typeof readHistory>[0]
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, "identity_unavailable");
});

test("GET /api/player/history returns the caller's own games only", async () => {
  const playerId = "3".repeat(32);
  const other = "4".repeat(32);
  games.push(
    row({ operational_game_id: "mine-1", player_id: playerId, outcome: "racer_correct" }),
    row({ operational_game_id: "not-mine", player_id: other })
  );

  const response = await readHistory(
    new Request("https://barkoba.test/api/player/history", {
      headers: { [PLAYER_HEADER]: playerId },
    }) as Parameters<typeof readHistory>[0]
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.games.length, 1);
  assert.equal(body.games[0].game_id, "mine-1");
  assert.equal(body.games[0].outcome, "racer_correct");
});

test("GET /api/player/history reports unavailable rather than an empty list on a read failure", async () => {
  // Only the history query fails. accounts.players must still resolve so the
  // 503 below is proven to come from the history read, not from
  // resolveActingPlayer's own (correct, and separately tested) fail-closed
  // behavior on an unrelated account lookup.
  __setSqlClientForTests(((strings: TemplateStringsArray, ...values: SqlValue[]) => {
    const query = strings.join(" ");
    if (/FROM corpus\.games/.test(query)) return Promise.reject(new Error("neon unavailable"));
    return fakeSql(strings, ...values);
  }) as unknown as typeof fakeSql);
  const response = await readHistory(
    new Request("https://barkoba.test/api/player/history", {
      headers: { [PLAYER_HEADER]: "5".repeat(32) },
    }) as Parameters<typeof readHistory>[0]
  );
  assert.equal(response.status, 503);
});
