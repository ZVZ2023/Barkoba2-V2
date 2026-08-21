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
}

let games: GameRow[];

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const query = strings.join(" ");
  if (/FROM corpus\.games/.test(query) && /WHERE player_id =/.test(query)) {
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
  assert.ok(history);
  assert.equal(history!.length, 2);
  assert.deepEqual(
    history!.map((g) => g.game_id).sort(),
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
  assert.deepEqual(history!.map((g) => g.game_id), ["new", "old"]);
});

test("derives role from the named seat columns when present", async () => {
  const playerId = "d".repeat(32);
  const other = "e".repeat(32);
  games.push(
    row({ operational_game_id: "as-composer", player_id: playerId, composer_player_id: playerId, racer_player_id: other, composer_kind: "human", racer_kind: "human" }),
    row({ operational_game_id: "as-racer", player_id: playerId, composer_player_id: other, racer_player_id: playerId, composer_kind: "human", racer_kind: "human" })
  );

  const history = await listPlayerHistory(playerId);
  const byId = Object.fromEntries(history!.map((g) => [g.game_id, g.role]));
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
  const byId = Object.fromEntries(history!.map((g) => [g.game_id, g.role]));
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
  assert.equal(history?.length, 1);
  const [entry] = history!;
  assert.equal(entry!.lifecycle_state, "abandoned_inferred");
  assert.equal(entry!.outcome, null);
});

test("a corpus read failure returns null, not an empty list", async () => {
  __setSqlClientForTests((() => Promise.reject(new Error("neon unavailable"))) as unknown as typeof fakeSql);
  const history = await listPlayerHistory("2".repeat(32));
  assert.equal(history, null);
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
