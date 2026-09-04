import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { decideGamePageAccess } from "../lib/seats";
import { stripRacerOutputRaw } from "../lib/gameView";
import type { IdentityResolution } from "../lib/actingPlayer";
import type { GameRecord, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.6 R1 COMMIT 4 — app/game/[id]/page.tsx's own access decision,
// extracted as decideGamePageAccess (lib/seats.ts) so it is unit-testable
// without a Next.js request context (no such harness exists in this
// project — see lib/turnRequestGuard.ts's own module doc for the identical
// reasoning). page.tsx itself is asserted separately, by source, as this
// codebase's own established idiom for exactly this kind of file
// (test/avatarHeader.test.ts, test/composerAuthority.test.ts).
// ---------------------------------------------------------------------------

const COMPOSER = "a".repeat(32);
const RACER = "b".repeat(32);
const STRANGER = "c".repeat(32);

function entry(o: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(),
    turn_index: 1,
    turn_type: "question",
    racer_output_raw: JSON.stringify({ action: "question", rationale: "internal reasoning here" }),
    question_text: "Is it alive?",
    guess_text: null,
    composer_response: "YES",
    ambiguous_explanation: null,
    guess_detector_flagged: false,
    guess_detector_method: null,
    timestamp: new Date().toISOString(),
    guess_intent_outcome: null,
    clue_text: null,
    ambiguous_consumed_credit: false,
    original_question_text: null,
    edit_status: null,
    edit_reason: null,
    model_id: null,
    model_provider: null,
    prompt_version: null,
    answered_at: null,
    pre_revision_question_text: null,
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
    ...o,
  };
}

function game(o: Partial<GameRecord> = {}): GameRecord {
  return {
    game_id: "g1",
    revision: 0,
    player_id: null,
    composer_player_id: null,
    racer_player_id: null,
    join_code: null,
    phase: "questioning",
    created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(),
    max_questions: 20,
    game_language: "hu",
    private_target: false,
    composer_kind: "human",
    racer_kind: "ai",
    racer_provider: null,
    difficulty: null,
    clue_mode: null,
    question_count: 0,
    question_count_high_water_mark: 0,
    ambiguous_count: 0,
    qa_log: [],
    final_action: null,
    final_guess_text: null,
    result: null,
    integrity_notes: null,
    integrity_flagged_turns: null,
    adjudication_notes: null,
    adjudicator_verdict: null,
    integrity_verdict: null,
    adjudication_confidence: null,
    revealed_target: null,
    revealed_definition: null,
    revealed_granularity: null,
    revealed_modifiers: null,
    revealed_locked_at: null,
    corrections: [],
    abandoned_branches: [],
    clarification_prompt: null,
    benchmark_case_id: null,
    benchmark_run_id: null,
    ...o,
  };
}

const identified = (playerId: string): IdentityResolution => ({ kind: "identified", playerId });
const absent: IdentityResolution = { kind: "absent" };
const backendDown: IdentityResolution = { kind: "backend_unavailable" };

// --- backend / absent, independent of any game ------------------------------

test("backend_unavailable always wins, regardless of the game", () => {
  assert.deepEqual(decideGamePageAccess(backendDown, null), { kind: "service_unavailable" });
  assert.deepEqual(decideGamePageAccess(backendDown, game({ composer_player_id: COMPOSER })), {
    kind: "service_unavailable",
  });
});

test("absent identity is not_found regardless of the game, and indistinguishable from a missing game", () => {
  assert.deepEqual(decideGamePageAccess(absent, null), { kind: "not_found" });
  assert.deepEqual(decideGamePageAccess(absent, game({ composer_player_id: COMPOSER })), {
    kind: "not_found",
  });
});

test("a missing game with an identified caller is still not_found", () => {
  assert.deepEqual(decideGamePageAccess(identified(COMPOSER), null), { kind: "not_found" });
});

// --- single-human modes ------------------------------------------------------

test("the real Composer (human-Composer mode) is granted single_human access", () => {
  const g = game({ composer_kind: "human", racer_kind: "ai", composer_player_id: COMPOSER });
  assert.deepEqual(decideGamePageAccess(identified(COMPOSER), g), {
    kind: "single_human",
    requiredSeat: "composer",
  });
});

test("the real Racer (AI-Composer mode) is granted single_human access", () => {
  const g = game({ composer_kind: "ai", racer_kind: "human", racer_player_id: RACER });
  assert.deepEqual(decideGamePageAccess(identified(RACER), g), {
    kind: "single_human",
    requiredSeat: "racer",
  });
});

test("a stranger with a leaked game id is not_found on a properly-seated single-human game", () => {
  const g = game({ composer_kind: "human", racer_kind: "ai", composer_player_id: COMPOSER });
  assert.deepEqual(decideGamePageAccess(identified(STRANGER), g), { kind: "not_found" });
});

test("FIXED NULL-SEAT POLICY: a single-human game with no recorded seat is restart_required, not granted to whoever asks", () => {
  const g = game({ composer_kind: "human", racer_kind: "ai", composer_player_id: null });
  assert.deepEqual(decideGamePageAccess(identified(STRANGER), g), {
    kind: "restart_required",
    requiredSeat: "composer",
  });
  // Not even the game's own creator is assigned it retroactively -- there is
  // no recorded creator to compare against in the first place.
  assert.deepEqual(decideGamePageAccess(identified(COMPOSER), g), {
    kind: "restart_required",
    requiredSeat: "composer",
  });
});

// --- Human vs Human — unchanged behavior preserved ---------------------------

test("Human vs Human: each participant is granted their own seat", () => {
  const g = game({ composer_kind: "human", racer_kind: "human", composer_player_id: COMPOSER, racer_player_id: RACER });
  assert.deepEqual(decideGamePageAccess(identified(COMPOSER), g), { kind: "human_vs_human", seat: "composer" });
  assert.deepEqual(decideGamePageAccess(identified(RACER), g), { kind: "human_vs_human", seat: "racer" });
});

test("Human vs Human: a stranger is not_found, even with an unfilled Racer seat (never falls back)", () => {
  const g = game({ composer_kind: "human", racer_kind: "human", composer_player_id: COMPOSER, racer_player_id: null });
  assert.deepEqual(decideGamePageAccess(identified(STRANGER), g), { kind: "not_found" });
});

// --- stripRacerOutputRaw ------------------------------------------------------

test("stripRacerOutputRaw blanks every qa_log entry's racer_output_raw and nothing else", () => {
  const g = game({ qa_log: [entry({ turn_index: 1 }), entry({ turn_index: 2, question_text: "Q2?" })] });
  const stripped = stripRacerOutputRaw(g);
  assert.equal(stripped.qa_log.length, 2);
  for (const e of stripped.qa_log) assert.equal(e.racer_output_raw, "");
  assert.equal(stripped.qa_log[0]!.question_text, "Is it alive?");
  assert.equal(stripped.qa_log[1]!.question_text, "Q2?");
  // Original untouched.
  assert.notEqual(g.qa_log[0]!.racer_output_raw, "");
});

// ---------------------------------------------------------------------------
// page.tsx source assertions — the wiring itself. Real execution of the
// decision logic is proven above; this proves the page actually uses it.
// ---------------------------------------------------------------------------

const GAME_PAGE = readFileSync("app/game/[id]/page.tsx", "utf8");

test("SOURCE: page.tsx resolves typed identity and feeds decideGamePageAccess, not the old permissive resolveSeat fallback", () => {
  assert.match(GAME_PAGE, /resolveActingPlayerIdentity/);
  assert.match(GAME_PAGE, /decideGamePageAccess/);
  assert.doesNotMatch(GAME_PAGE, /\bresolveSeat\(/, "must not call the non-strict resolver directly");
});

test("SOURCE: page.tsx strips racer_output_raw before any single-human client component renders", () => {
  assert.match(GAME_PAGE, /stripRacerOutputRaw/);
});

test("SOURCE: page.tsx still resolves the account header state for GameClient (avatarHeader.test.ts's own contract)", () => {
  assert.match(GAME_PAGE, /resolveAccountHeaderState/);
});

test("SOURCE: page.tsx renders a distinct panel for service_unavailable and restart_required, never the raw GameRecord", () => {
  const serviceBranch = GAME_PAGE.slice(
    GAME_PAGE.indexOf('decision.kind === "service_unavailable"'),
    GAME_PAGE.indexOf('decision.kind === "not_found"')
  );
  assert.match(serviceBranch, /<ServiceUnavailablePanel \/>/);

  const restartBranch = GAME_PAGE.slice(
    GAME_PAGE.indexOf('decision.kind === "restart_required"'),
    GAME_PAGE.indexOf('decision.kind === "human_vs_human"')
  );
  assert.match(restartBranch, /<RestartRequiredPanel \/>/);
  assert.doesNotMatch(restartBranch, /initialGame|initialView/, "must never pass game content to a restart panel");
});
