import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_EXPERIENCE_MODE,
  EXPERIENCE_MODES,
  clueModeForExperienceMode,
  isExperienceMode,
} from "../lib/experienceMode";
import { cluesEnabled } from "../lib/clueCredits";
import { buildGameView } from "../lib/gameView";
import type { GameRecord } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.8 SLICE 1 — schema/types/migration/persistence.
//
// Covers: all four modes accepted/persisted, unknown mode rejected (pure
// classifier — the route-level 400 is covered in Slice 2's own test file),
// the preset mapping decision exactly as specified, legacy (NULL) games
// behaving identically to before V2.8.8, and the corpus/migration source
// itself.
// ---------------------------------------------------------------------------

function game(over: Partial<GameRecord> = {}): GameRecord {
  return {
    game_id: "g", phase: "questioning", created_at: "", expires_at: "",
    max_questions: 20, game_language: "hu", question_count: 0, ambiguous_count: 0,
    difficulty: "hard", clue_mode: "progressive", experience_mode: null,
    composer_kind: "ai", racer_kind: "human",
    qa_log: [], corrections: [], abandoned_branches: [], ...over,
  } as unknown as GameRecord;
}

test("all four experience modes are recognized, and only those four", () => {
  assert.deepEqual([...EXPERIENCE_MODES].sort(), ["competitive", "friendly", "humorous", "teaching"]);
  for (const m of EXPERIENCE_MODES) assert.equal(isExperienceMode(m), true);
});

test("unknown mode values are rejected by the pure classifier", () => {
  for (const bad of ["Competitive", "hard", "", null, undefined, 42, "verseny"]) {
    assert.equal(isExperienceMode(bad), false, String(bad));
  }
});

test("the new-game preset mapping matches the approved decision exactly", () => {
  assert.equal(clueModeForExperienceMode("competitive"), "none");
  assert.equal(clueModeForExperienceMode("friendly"), "minimal");
  assert.equal(clueModeForExperienceMode("teaching"), "progressive");
  assert.equal(clueModeForExperienceMode("humorous"), "minimal");
});

test("the visible new-game default is Friendly, never Competitive", () => {
  assert.equal(DEFAULT_EXPERIENCE_MODE, "friendly");
});

// ---------------------------------------------------------------------------
// cluesEnabled(): the new mode-aware branch, and the untouched legacy one.
// ---------------------------------------------------------------------------

test("a mode-bearing game: Competitive never enables clues, regardless of clue_mode or difficulty", () => {
  assert.equal(cluesEnabled(game({ experience_mode: "competitive", clue_mode: "progressive", difficulty: "hard" })), false);
  assert.equal(cluesEnabled(game({ experience_mode: "competitive", clue_mode: "minimal", difficulty: "easy" })), false);
});

test("a mode-bearing game: Friendly/Teaching/Humorous enable clues even on Easy/Medium -- hint availability no longer depends only on Hard difficulty", () => {
  for (const mode of ["friendly", "teaching", "humorous"] as const) {
    assert.equal(
      cluesEnabled(game({ experience_mode: mode, clue_mode: clueModeForExperienceMode(mode), difficulty: "easy" })),
      true,
      mode
    );
  }
});

test("a mode-bearing game with clue_mode somehow 'none' still disables clues (defense in depth)", () => {
  assert.equal(cluesEnabled(game({ experience_mode: "friendly", clue_mode: "none", difficulty: "hard" })), false);
});

test("a LEGACY game (experience_mode NULL) keeps the EXACT original difficulty-gated formula, unchanged", () => {
  assert.equal(cluesEnabled(game({ experience_mode: null, difficulty: "hard", clue_mode: "progressive" })), true);
  assert.equal(cluesEnabled(game({ experience_mode: null, difficulty: "hard", clue_mode: "none" })), false);
  assert.equal(cluesEnabled(game({ experience_mode: null, difficulty: "medium", clue_mode: "progressive" })), false);
  assert.equal(cluesEnabled(game({ experience_mode: null, difficulty: "easy", clue_mode: "progressive" })), false);
});

test("a fixture with NO experience_mode field at all (undefined, not null) is treated exactly like a legacy game -- an absent field must never be read as a mode-bearing one", () => {
  const legacyLikeFixture = {
    game_id: "g", phase: "questioning", created_at: "", expires_at: "",
    max_questions: 20, game_language: "hu", question_count: 0, ambiguous_count: 0,
    difficulty: "medium", clue_mode: "progressive",
    composer_kind: "ai", racer_kind: "human",
    qa_log: [], corrections: [], abandoned_branches: [],
    // experience_mode deliberately OMITTED
  } as unknown as GameRecord;
  assert.equal(cluesEnabled(legacyLikeFixture), false, "medium difficulty must still disable clues, exactly as before V2.8.8");
});

// ---------------------------------------------------------------------------
// GameView: experience_mode and the computed hint_credits_available.
// ---------------------------------------------------------------------------

test("buildGameView exposes experience_mode and a COMPUTED hint_credits_available, never a raw clue_mode/difficulty passthrough", () => {
  const g = game({ experience_mode: "friendly", clue_mode: "minimal", difficulty: "easy", question_count: 10 });
  const view = buildGameView(g, "composer");
  assert.equal(view.experience_mode, "friendly");
  assert.equal(view.hint_credits_available, 1, "1 credit earned at 10 questions, none spent");
  assert.equal("clue_mode" in view, false, "raw clue_mode must not leak into the view");
  assert.equal("difficulty" in view, false, "raw difficulty must not leak into the view");
});

test("buildGameView: Competitive always reports zero hint credits, however many questions have been asked", () => {
  const g = game({ experience_mode: "competitive", clue_mode: "none", question_count: 100 });
  assert.equal(buildGameView(g, "racer").hint_credits_available, 0);
});

test("buildGameView: a legacy (NULL) game reports experience_mode null", () => {
  const g = game({ experience_mode: null });
  assert.equal(buildGameView(g, "composer").experience_mode, null);
});

// ---------------------------------------------------------------------------
// Corpus/migration source.
// ---------------------------------------------------------------------------

test("lib/corpus/gameCorpus.ts: experience_mode is written on INSERT, absent from the UPDATE SET list -- immutable by construction, matching benchmark_case_id's own treatment", () => {
  const src = readFileSync("lib/corpus/gameCorpus.ts", "utf8");
  const insertAt = src.indexOf("INSERT INTO corpus.games (");
  const updateAt = src.indexOf("ON CONFLICT (operational_game_id) DO UPDATE SET");
  assert.ok(insertAt > 0 && updateAt > insertAt);
  const insertClause = src.slice(insertAt, updateAt);
  const updateClause = src.slice(updateAt, src.indexOf("`);", updateAt));
  assert.match(insertClause, /experience_mode/, "must be written on insert");
  assert.doesNotMatch(updateClause, /experience_mode\s*=/, "must never be rewritten by a re-sync");
});

test("migrations/0014_experience_mode.sql: additive, idempotent, no default, no NOT NULL, no backfill", () => {
  const src = readFileSync("migrations/0014_experience_mode.sql", "utf8");
  // Strip the (prose-heavy, --comment) lines first -- the doc comment itself
  // discusses "no default"/"NOT NULL" in prose, which would otherwise false-
  // positive against these same assertions.
  const sqlOnly = src.replace(/^--.*$/gm, "");
  assert.match(sqlOnly, /ADD COLUMN IF NOT EXISTS experience_mode text/);
  assert.doesNotMatch(sqlOnly, /DEFAULT/i, "no default -- NULL must mean 'no choice existed'");
  assert.doesNotMatch(sqlOnly, /NOT NULL/);
  assert.doesNotMatch(sqlOnly, /UPDATE\s+corpus\.games/i, "no backfill of existing rows");
  // The exact idempotent constraint-add shape migration 0013 already
  // established: DROP IF EXISTS before ADD, so a rerun (or a rerun after a
  // partial failure) cannot fail unpredictably.
  const dropAt = src.indexOf("DROP CONSTRAINT IF EXISTS games_experience_mode_known");
  const addAt = src.indexOf("ADD CONSTRAINT games_experience_mode_known CHECK");
  assert.ok(dropAt > 0 && addAt > dropAt, "must DROP IF EXISTS before ADD, exactly like migration 0013");
  assert.match(src, /'competitive', 'friendly', 'teaching', 'humorous'/);
});

test("lib/gameStore.ts: a KV record with no experience_mode field backfills to null, never to a chosen value", () => {
  const src = readFileSync("lib/gameStore.ts", "utf8");
  assert.match(src, /if \(record\.experience_mode === undefined\) \{\s*\n\s*record\.experience_mode = null;/);
});
