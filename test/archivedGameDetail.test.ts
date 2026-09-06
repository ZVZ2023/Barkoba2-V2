import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getArchivedGameForOwner } from "../lib/corpus/gameCorpus";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";

// ---------------------------------------------------------------------------
// V2.8.8.3 — DURABLE COMPLETED-GAME DETAIL.
//
// Field problem: /game/[id] reads only the ~24h-TTL live Redis record.
// Once it expires, a completed game (already fully preserved in corpus)
// became permanently unopenable from Játékaim, even though the durable
// evidence was sitting right there. getArchivedGameForOwner is the
// corpus-backed fallback; these tests prove its OWN independent scoping
// (completed-only, owner-only) directly against a mocked SQL client — same
// scope/idiom as test/playerHistory.test.ts (no live Postgres here).
// ---------------------------------------------------------------------------

interface FakeGameRow {
  corpus_game_id: string;
  operational_game_id: string;
  lifecycle_state: string;
  created_at: string;
  composer_kind: string;
  racer_kind: string;
  experience_mode: string | null;
  max_questions: number;
  question_count: number;
  ambiguous_count: number;
  outcome: string | null;
  player_id: string | null;
  composer_player_id: string | null;
  racer_player_id: string | null;
  target: string | null;
  final_action: string | null;
  final_guess_text: string | null;
  adjudicator_verdict: string | null;
  adjudication_notes: string | null;
  integrity_verdict: string | null;
  integrity_notes: string | null;
  integrity_flagged_turns: number[] | null;
}

interface FakeTurnRow {
  corpus_game_id: string;
  branch: "main" | "abandoned";
  turn_index: number;
  turn_type: string;
  question_text: string | null;
  composer_response: string | null;
  ambiguous_explanation: string | null;
  clue_text: string | null;
  guess_text: string | null;
}

let games: FakeGameRow[];
let turns: FakeTurnRow[];

function game(overrides: Partial<FakeGameRow>): FakeGameRow {
  return {
    corpus_game_id: "corpus-1",
    operational_game_id: "00000000-0000-0000-0000-000000000001",
    lifecycle_state: "completed",
    created_at: "2026-09-01T10:00:00.000Z",
    composer_kind: "human",
    racer_kind: "ai",
    experience_mode: "friendly",
    max_questions: 20,
    question_count: 5,
    ambiguous_count: 0,
    outcome: "racer_incorrect",
    player_id: "a".repeat(32),
    composer_player_id: null,
    racer_player_id: null,
    target: "bicikli",
    final_action: "guess",
    final_guess_text: "biciklizni",
    adjudicator_verdict: "incorrect",
    adjudication_notes: "A tipp nem egyezik a célponttal.",
    integrity_verdict: null,
    integrity_notes: null,
    integrity_flagged_turns: null,
    ...overrides,
  };
}

function turn(overrides: Partial<FakeTurnRow>): FakeTurnRow {
  return {
    corpus_game_id: "corpus-1",
    branch: "main",
    turn_index: 1,
    turn_type: "question",
    question_text: "Fizikai tárgy?",
    composer_response: "YES",
    ambiguous_explanation: null,
    clue_text: null,
    guess_text: null,
    ...overrides,
  };
}

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const query = strings.join(" ");
  if (/FROM corpus\.games g/.test(query)) {
    const [gameId, p1, p2, p3] = values as string[];
    const row = games.find(
      (g) =>
        g.operational_game_id === gameId &&
        g.lifecycle_state === "completed" &&
        (g.player_id === p1 || g.composer_player_id === p2 || g.racer_player_id === p3)
    );
    return Promise.resolve((row ? [row] : []) as unknown as Record<string, unknown>[]);
  }
  if (/FROM corpus\.game_turns/.test(query)) {
    const [corpusGameId] = values as string[];
    const rows = turns
      .filter((t) => t.corpus_game_id === corpusGameId && t.branch === "main")
      .sort((a, b) => a.turn_index - b.turn_index);
    return Promise.resolve(rows as unknown as Record<string, unknown>[]);
  }
  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

beforeEach(() => {
  games = [];
  turns = [];
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
});

const GAME_ID = "00000000-0000-0000-0000-000000000001";
const PLAYER = "a".repeat(32);
const OTHER = "b".repeat(32);

// ---------------------------------------------------------------------------
// Owner access.
// ---------------------------------------------------------------------------

test("owner access: player_id match returns the record", async () => {
  games.push(game({ player_id: PLAYER }));
  turns.push(turn({}));
  const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
  assert.equal(result.status, "found");
  if (result.status === "found") {
    assert.equal(result.record.game_id, GAME_ID);
    assert.equal(result.record.target, "bicikli");
  }
});

test("owner access: composer_player_id match returns the record (player_id itself null/unlinked)", async () => {
  games.push(game({ player_id: null, composer_player_id: PLAYER, racer_player_id: OTHER, composer_kind: "human", racer_kind: "human" }));
  const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
  assert.equal(result.status, "found");
  if (result.status === "found") assert.equal(result.record.role, "composer");
});

test("owner access: racer_player_id match returns the record", async () => {
  games.push(game({ player_id: null, composer_player_id: OTHER, racer_player_id: PLAYER, composer_kind: "human", racer_kind: "human" }));
  const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
  assert.equal(result.status, "found");
  if (result.status === "found") assert.equal(result.record.role, "racer");
});

// ---------------------------------------------------------------------------
// Non-owner denial.
// ---------------------------------------------------------------------------

test("non-owner denial: a caller who was not part of this game gets not_found, indistinguishable from a nonexistent game", async () => {
  games.push(game({ player_id: PLAYER }));
  const result = await getArchivedGameForOwner(GAME_ID, OTHER);
  assert.equal(result.status, "not_found");
});

test("non-owner denial: a stranger with the exact game_id but no seat at all gets not_found", async () => {
  games.push(game({ player_id: null, composer_player_id: PLAYER, racer_player_id: PLAYER }));
  const result = await getArchivedGameForOwner(GAME_ID, OTHER);
  assert.equal(result.status, "not_found");
});

// ---------------------------------------------------------------------------
// Incomplete-target secrecy.
// ---------------------------------------------------------------------------

test("incomplete-target secrecy: an in_progress game is NEVER returned, even to its own owner -- the target must never leak before completion", async () => {
  games.push(game({ player_id: PLAYER, lifecycle_state: "in_progress", target: "titkos cél" }));
  const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
  assert.equal(result.status, "not_found");
});

test("incomplete-target secrecy: abandoned_inferred and stalled_resolving are also refused", async () => {
  for (const lifecycle_state of ["abandoned_inferred", "stalled_resolving", "expired_unresolved"]) {
    games = [game({ player_id: PLAYER, lifecycle_state })];
    const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
    assert.equal(result.status, "not_found", `${lifecycle_state} must be refused`);
  }
});

// ---------------------------------------------------------------------------
// Missing optional historical fields -- labelled, not silently blank.
// ---------------------------------------------------------------------------

test("missing optional historical fields: no game_targets/game_resolutions row -> target_retained/resolution_retained are false, not silently blank", async () => {
  games.push(
    game({
      player_id: PLAYER,
      target: null,
      final_action: null,
      final_guess_text: null,
      adjudicator_verdict: null,
      adjudication_notes: null,
    })
  );
  const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
  assert.equal(result.status, "found");
  if (result.status === "found") {
    assert.equal(result.record.target_retained, false);
    assert.equal(result.record.resolution_retained, false);
  }
});

test("missing optional historical fields: a pre-V2.8.8 game (experience_mode null) is handled like every other legacy field, not flagged as an anomaly", async () => {
  games.push(game({ player_id: PLAYER, experience_mode: null }));
  const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
  assert.equal(result.status, "found");
  if (result.status === "found") assert.equal(result.record.experience_mode, null);
});

test("detected wrong answers: integrity_flagged_turns passes through for the caller to cross-reference against the transcript", async () => {
  games.push(
    game({
      player_id: PLAYER,
      final_action: "concede",
      adjudicator_verdict: null,
      outcome: "racer_win_integrity_violation",
      integrity_verdict: "violated",
      integrity_notes: "A 3. kör válasza ellentmond a 7. körnek.",
      integrity_flagged_turns: [3, 7],
    })
  );
  const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
  assert.equal(result.status, "found");
  if (result.status === "found") {
    assert.deepEqual(result.record.integrity_flagged_turns, [3, 7]);
    assert.equal(result.record.integrity_verdict, "violated");
  }
});

// ---------------------------------------------------------------------------
// The transcript itself -- main branch only, in order.
// ---------------------------------------------------------------------------

test("the transcript is the main branch only, ordered by turn_index, abandoned turns excluded", async () => {
  games.push(game({ player_id: PLAYER }));
  turns.push(
    turn({ turn_index: 2, question_text: "second" }),
    turn({ turn_index: 1, question_text: "first" }),
    turn({ turn_index: 1, branch: "abandoned", question_text: "discarded by a correction" })
  );
  const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
  assert.equal(result.status, "found");
  if (result.status === "found") {
    assert.deepEqual(
      result.record.turns.map((t) => t.question_text),
      ["first", "second"]
    );
  }
});

test("hints (clue turns) are included in the transcript", async () => {
  games.push(game({ player_id: PLAYER }));
  turns.push(
    turn({ turn_index: 1, turn_type: "clue", question_text: null, clue_text: "Gondolj a méretére." })
  );
  const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
  assert.equal(result.status, "found");
  if (result.status === "found") assert.equal(result.record.turns[0]?.clue_text, "Gondolj a méretére.");
});

// ---------------------------------------------------------------------------
// A malformed / nonexistent game_id never leaks which case it was.
// ---------------------------------------------------------------------------

test("a nonexistent game_id returns not_found, same as a malformed one -- neither is distinguishable", async () => {
  const result = await getArchivedGameForOwner("00000000-0000-0000-0000-000000000099", PLAYER);
  assert.equal(result.status, "not_found");
});

test("corpus not configured returns not_found, never throws", async () => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  const result = await getArchivedGameForOwner(GAME_ID, PLAYER);
  assert.equal(result.status, "not_found");
});

// ---------------------------------------------------------------------------
// SOURCE: page.tsx wiring -- live KV behavior unchanged; corpus fallback is
// reached ONLY when KV has genuinely nothing.
// ---------------------------------------------------------------------------

const PAGE = readFileSync("app/game/[id]/page.tsx", "utf8");

test("SOURCE: the corpus fallback is only ever attempted when the live KV lookup returned nothing", () => {
  const at = PAGE.indexOf("getArchivedGameForOwner(params.id");
  assert.ok(at > 0);
  const guard = PAGE.slice(Math.max(0, at - 200), at);
  assert.match(guard, /if \(!game && identity\.kind === "identified"\) \{/);
});

test("SOURCE: decideGamePageAccess and the live rendering path are completely unchanged -- called with the exact same (identity, game) it always was", () => {
  assert.match(PAGE, /const decision = decideGamePageAccess\(identity, game\);/);
  // The archived branch RETURNS before this line when it fires, so the live
  // path below it never has to know the fallback exists.
  const archivedAt = PAGE.indexOf("ArchivedGameView");
  const decisionAt = PAGE.indexOf("const decision = decideGamePageAccess(identity, game);");
  assert.ok(archivedAt > 0 && archivedAt < decisionAt);
});

test("SOURCE: ArchivedGameView is a plain server component -- no \"use client\", no mutation, no polling", () => {
  const view = readFileSync("app/game/[id]/ArchivedGameView.tsx", "utf8");
  assert.doesNotMatch(view, /"use client"/);
  assert.doesNotMatch(view, /useState|useEffect|fetch\(/);
});

test("SOURCE: never reveal an incomplete game's secret target -- getArchivedGameForOwner's query itself gates on lifecycle_state = 'completed'", () => {
  const src = readFileSync("lib/corpus/gameCorpus.ts", "utf8");
  const fnAt = src.indexOf("export async function getArchivedGameForOwner");
  const fn = src.slice(fnAt, fnAt + 2000);
  assert.match(fn, /lifecycle_state = 'completed'/);
});
