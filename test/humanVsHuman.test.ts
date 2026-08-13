import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { awaitingRacer, isHumanVsHuman, isParticipant, requireSeat, resolveSeat } from "../lib/seats";
import { buildComposerView, buildGameView, isSeatsTurn, pendingQuestionIndex } from "../lib/gameView";
import { QUESTION_BUDGETS, recommendedBudget, resolveQuestionBudget } from "../lib/questionBudget";
import type { GameRecord, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.3 — the rules that must hold before two strangers share a game.
//
// Scoped to the critical gates only: role integrity, secret isolation, and
// whose turn it is. The narrowing and seat logic are pure functions precisely
// so they can be proven here rather than in a browser.
// ---------------------------------------------------------------------------

const COMPOSER = "a".repeat(32);
const RACER = "b".repeat(32);
const STRANGER = "c".repeat(32);

function entry(o: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(), turn_index: 1, turn_type: "question", racer_output_raw: "",
    question_text: "Fizikai tárgy?", guess_text: null, composer_response: null,
    ambiguous_explanation: null, guess_detector_flagged: false, guess_detector_method: null,
    guess_intent_outcome: null, clue_text: null, original_question_text: null,
    edit_status: null, edit_reason: null, ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(), quality_score: null, information_gain: null,
    strategy_classification: null, integrity_flag: null, confidence: null, latency_ms: null,
    ...o,
  };
}

function hhGame(o: Partial<GameRecord> = {}): GameRecord {
  return {
    game_id: randomUUID(), player_id: COMPOSER,
    composer_player_id: COMPOSER, racer_player_id: RACER, join_code: "ABCD2345",
    phase: "questioning", created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(), max_questions: 20, game_language: "hu",
    private_target: false, composer_kind: "human", racer_kind: "human",
    difficulty: null, clue_mode: null, question_count: 0, ambiguous_count: 0,
    qa_log: [], final_action: null, final_guess_text: null, result: null,
    integrity_notes: null, integrity_flagged_turns: null, adjudication_notes: null,
    adjudicator_verdict: null, integrity_verdict: null, adjudication_confidence: null,
    revealed_target: null, revealed_definition: null, revealed_granularity: null,
    revealed_modifiers: null, revealed_locked_at: null,
    corrections: [], abandoned_branches: [], clarification_prompt: null,
    ...o,
  };
}

// --- role integrity ---------------------------------------------------------

test("each participant resolves to their own seat", () => {
  const g = hhGame();
  assert.equal(resolveSeat(g, COMPOSER), "composer");
  assert.equal(resolveSeat(g, RACER), "racer");
});

test("a stranger holding the URL has no seat at all", () => {
  const g = hhGame();
  assert.equal(resolveSeat(g, STRANGER), null);
  assert.equal(resolveSeat(g, null), null);
  assert.equal(isParticipant(g, STRANGER), false);
});

test("Human↔Human never falls back to the one-human rule", () => {
  // A game still waiting for its Racer must not hand the empty seat to whoever
  // asks — that fallback is only safe in modes with exactly one human.
  const g = hhGame({ racer_player_id: null });
  assert.equal(resolveSeat(g, STRANGER), null);
});

test("the Racer cannot act as Composer, and vice versa", () => {
  const g = hhGame();
  assert.deepEqual(requireSeat(g, RACER, "composer"), {
    ok: false, seat: "racer", error: "wrong_seat",
  });
  assert.deepEqual(requireSeat(g, COMPOSER, "racer"), {
    ok: false, seat: "composer", error: "wrong_seat",
  });
});

test("a stranger and a wrong-seat participant are distinguished", () => {
  const g = hhGame();
  assert.equal(requireSeat(g, STRANGER, "racer").error, "not_a_participant");
  assert.equal(requireSeat(g, COMPOSER, "racer").error, "wrong_seat");
});

test("single-human modes keep working without recorded seats", () => {
  // Games created before 2.3.0.0 are still live in Redis for up to 24h.
  const legacy = hhGame({
    composer_kind: "human", racer_kind: "ai",
    composer_player_id: null, racer_player_id: null,
  });
  assert.equal(isHumanVsHuman(legacy), false);
  assert.equal(resolveSeat(legacy, STRANGER), "composer");
});

// --- SECRET ISOLATION — the highest-priority constraint ---------------------

test("the Racer view contains no target field, by shape", () => {
  const g = hhGame({
    qa_log: [entry({ composer_response: "YES" })],
    revealed_target: null,
  });
  const view = buildGameView(g, "racer");
  const serialized = JSON.stringify(view);

  assert.equal("secret" in view, false, "a Racer view must have no secret block");
  assert.doesNotMatch(serialized, /"secret"/);
  assert.doesNotMatch(serialized, /join_code/, "the invitation is Composer-only too");
});

test("a target present in the record still never reaches the Racer view", () => {
  // The strongest form of the guarantee: even if GameRecord holds target text,
  // the Racer projection is built field by field and cannot carry it.
  const g = hhGame({
    revealed_definition: "SECRET-DEFINITION",
    revealed_modifiers: "SECRET-MODIFIER",
    revealed_granularity: "generic_type",
  });
  const serialized = JSON.stringify(buildGameView(g, "racer"));
  assert.doesNotMatch(serialized, /SECRET-DEFINITION/);
  assert.doesNotMatch(serialized, /SECRET-MODIFIER/);
});

test("the Composer view carries the target and the invitation", () => {
  const g = hhGame();
  const view = buildComposerView(g, { target: "kanál", definition: "evőeszköz" });
  assert.equal(view.secret.target, "kanál");
  assert.equal(view.join_code, "ABCD2345");
});

test("after resolution the declassified target is visible to BOTH seats", () => {
  const g = hhGame({ phase: "complete", result: "racer_correct", revealed_target: "kanál" });
  assert.equal(buildGameView(g, "racer").revealed_target, "kanál");
});

// --- turn synchronisation ---------------------------------------------------

test("an unanswered question makes it the Composer's move", () => {
  const g = hhGame({ qa_log: [entry()] });
  assert.equal(pendingQuestionIndex(g), 1);
  assert.equal(isSeatsTurn(g, "composer"), true);
  assert.equal(isSeatsTurn(g, "racer"), false);
});

test("an answered question hands the move back to the Racer", () => {
  const g = hhGame({ qa_log: [entry({ composer_response: "YES" })] });
  assert.equal(pendingQuestionIndex(g), null);
  assert.equal(isSeatsTurn(g, "racer"), true);
  assert.equal(isSeatsTurn(g, "composer"), false);
});

test("nobody may act while the second player has not joined", () => {
  const g = hhGame({ racer_player_id: null });
  assert.equal(awaitingRacer(g), true);
  assert.equal(isSeatsTurn(g, "composer"), false);
  assert.equal(isSeatsTurn(g, "racer"), false);
});

test("nobody may act once the game is over", () => {
  const g = hhGame({ phase: "complete" });
  assert.equal(isSeatsTurn(g, "racer"), false);
  assert.equal(isSeatsTurn(g, "composer"), false);
});

// --- question budget: recommended, overridable, then authoritative ----------

test("each difficulty recommends one of the offered allowances", () => {
  for (const d of ["easy", "medium", "hard"] as const) {
    assert.ok(
      (QUESTION_BUDGETS as readonly number[]).includes(recommendedBudget(d)),
      `${d} must recommend an offered budget`
    );
  }
  // Harder means further to deduce, so more questions — not a stricter game.
  assert.ok(recommendedBudget("easy") < recommendedBudget("medium"));
  assert.ok(recommendedBudget("medium") < recommendedBudget("hard"));
});

test("the Composer's override wins over the recommendation", () => {
  assert.equal(resolveQuestionBudget("easy", 100), 100);
  assert.equal(resolveQuestionBudget("hard", 20), 20);
});

test("no override means the recommendation", () => {
  assert.equal(resolveQuestionBudget("medium", undefined), recommendedBudget("medium"));
  assert.equal(resolveQuestionBudget("medium", null), recommendedBudget("medium"));
});

test("a budget that is not on offer falls back instead of failing the game", () => {
  for (const bad of [0, -5, 21, 999, "50", NaN, {}]) {
    assert.equal(resolveQuestionBudget("hard", bad), recommendedBudget("hard"));
  }
});

test("the chosen budget is authoritative game state, not a display value", () => {
  // What creation resolves is what the record carries, and what the record
  // carries is what gameplay counts against.
  const chosen = resolveQuestionBudget("hard", 100);
  const g = hhGame({ max_questions: chosen, question_count: chosen });

  assert.equal(g.max_questions, 100);
  assert.equal(buildGameView(g, "racer").max_questions, 100);
  assert.equal(buildGameView(g, "racer").questions_remaining, 0);
});

test("the H↔H route enforces the budget it was given, whatever its size", () => {
  // The guard is `question_count >= max_questions`, so a 100-question game must
  // still be asking at 99 and out of questions at 100.
  const src = readFileSync("app/api/game/[id]/hh/turn/route.ts", "utf8");
  assert.match(src, /game\.question_count >= game\.max_questions/);
  assert.match(src, /out_of_questions/);

  const nearlyDone = hhGame({ max_questions: 100, question_count: 99 });
  assert.equal(buildGameView(nearlyDone, "racer").questions_remaining, 1);
});

test("creation resolves the budget before the Validator judges the target", () => {
  // A target reasonable inside 50 questions may not be inside 20, so the
  // Validator has to be told the allowance the game will actually use.
  const src = readFileSync("app/api/game/create/route.ts", "utf8");
  const budgetAt = src.indexOf("resolveQuestionBudget(humanDifficulty");
  const validatorAt = src.indexOf("runValidator(target");
  assert.ok(budgetAt > 0 && validatorAt > 0);
  assert.ok(budgetAt < validatorAt, "the budget must be resolved first");
  assert.match(src, /max_questions: maxQuestions,/);
});

// --- structural guards ------------------------------------------------------

/** Actual import statements only — these files discuss secretStore in comments. */
function importsSecretStore(src: string): boolean {
  return /^\s*import[\s\S]*?from\s+["'][^"']*secretStore["']/m.test(src);
}

test("the H↔H turn route never imports secretStore", () => {
  // A Human↔Human turn needs no target: the Composer supplies the answer and
  // the existing Adjudicator judges it later at /resolve.
  const src = readFileSync("app/api/game/[id]/hh/turn/route.ts", "utf8");
  assert.equal(importsSecretStore(src), false);
});

test("gameView never imports secretStore", () => {
  // The narrowing rule and the secret lookup must stay in different files.
  assert.equal(importsSecretStore(readFileSync("lib/gameView.ts", "utf8")), false);
});

test("the game page never imports secretStore", () => {
  // It did in the first draft, and check-isolation.mjs rejected it. The
  // approved scope widened the allowlist by exactly one entry: the view route.
  assert.equal(importsSecretStore(readFileSync("app/game/[id]/page.tsx", "utf8")), false);
});

test("exactly one V2.3 entry was added to the secret allowlist", () => {
  const src = readFileSync("scripts/check-isolation.mjs", "utf8");
  // Scoped to the PERMITTED block. The game page appears elsewhere in this file
  // — in QUARANTINED, which is where it belongs: quarantined FROM the secret.
  const permitted = src.slice(
    src.indexOf("const PERMITTED_SECRET_IMPORTERS"),
    src.indexOf("const QUARANTINED")
  );
  assert.ok(permitted.length > 0, "could not locate the allowlist block");
  assert.equal(
    (permitted.match(/"app\/api\/game\/\[id\]\/view\/route\.ts"/g) || []).length,
    1,
    "the view route, and nothing else"
  );
  assert.doesNotMatch(permitted, /"app\/game\/\[id\]\/page\.tsx"/);
});

test("the Composer secret getter is identity-gated inside secretStore", () => {
  const src = readFileSync("lib/secretStore.ts", "utf8");
  assert.match(src, /getSecretForComposer/);
  assert.match(src, /composer_player_id !== requestingPlayerId/);
});

test("migration 0003 is additive and keeps erasure working on finalized rows", () => {
  const m = readFileSync("migrations/0003_human_human_participants.sql", "utf8");
  assert.match(m, /ADD COLUMN IF NOT EXISTS composer_player_id/);
  assert.match(m, /ADD COLUMN IF NOT EXISTS racer_player_id/);
  assert.doesNotMatch(m, /DROP TABLE|DROP COLUMN/);
  // Without this the unlink would raise on an already-finalized H↔H game.
  assert.match(m, /- 'composer_player_id' - 'racer_player_id'/);
});
