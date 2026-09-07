import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CORE_RACER_RULES,
  RACER_PROMPT_VERSION,
  buildGuessIntentMessage,
  buildRacerTurnMessage,
} from "../lib/prompts/racer";
import { toRacerPublicState } from "../lib/racerState";
import { resultCopy } from "../lib/resultCopy";
import { EXPERIENCE_MODE_STRATEGY_TIP_HU, EXPERIENCE_MODES } from "../lib/experienceMode";
import type { ExperienceMode, GameRecord, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.8 COMPLETION — "mode cannot be only a hint label".
//
// This covers the two mechanisms added to close that gap: (1) the AI
// Racer's own question-generation prompt now carries presentation tone,
// wired through RacerPublicState and verified never to disturb the
// byte-verified CORE_RACER_RULES block or the version-stamping guarantee;
// (2) terminal/result headline copy now varies by mode across all three
// directions, with detail/won/verdict left untouched. Also proves the
// deliberate scope limits: Competitive/legacy/Teaching share the baseline
// terminal copy, buildGuessIntentMessage carries no tone framing, and no
// truth/adjudication/integrity code path gained an experienceMode parameter.
// ---------------------------------------------------------------------------

function entry(o: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(), turn_index: 1, turn_type: "question", racer_output_raw: "",
    question_text: "Is the target a physical object?", guess_text: null,
    composer_response: null, ambiguous_explanation: null,
    guess_detector_flagged: false, guess_detector_method: null,
    guess_intent_outcome: null, clue_text: null, original_question_text: null,
    edit_status: null, edit_reason: null, ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(),
    model_id: null, model_provider: null, prompt_version: null,
    answered_at: null, pre_revision_question_text: null,
    quality_score: null, information_gain: null, strategy_classification: null,
    integrity_flag: null, confidence: null, latency_ms: null,
    ...o,
  };
}

function game(experienceMode: ExperienceMode | null, log: QuestionLogEntry[] = []): GameRecord {
  return {
    game_id: randomUUID(), revision: 0, player_id: null,
    composer_player_id: null, racer_player_id: null, join_code: null,
    phase: "questioning", created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(), max_questions: 20, game_language: "en",
    private_target: false, composer_kind: "human", racer_kind: "ai",
    racer_provider: null, racer_engine_tier: null, difficulty: null, clue_mode: null, experience_mode: experienceMode,
    question_count: log.length, question_count_high_water_mark: log.length, ambiguous_count: 0, qa_log: log,
    final_action: null, final_guess_text: null, result: null,
    integrity_notes: null, integrity_flagged_turns: null, adjudication_notes: null,
    adjudicator_verdict: null, integrity_verdict: null, adjudication_confidence: null,
    revealed_target: null, revealed_definition: null, revealed_granularity: null,
    revealed_modifiers: null, revealed_locked_at: null,
    corrections: [], abandoned_branches: [], clarification_prompt: null,
    benchmark_case_id: null, benchmark_run_id: null,
  };
}

const RACER_SRC = readFileSync("lib/prompts/racer.ts", "utf8");

// ---------------------------------------------------------------------------
// 1. The AI Racer's OWN question-generation prompt now carries mode tone.
// ---------------------------------------------------------------------------

test("every experience mode has an explicit RACER_MODE_TONE entry, including Competitive", () => {
  const at = RACER_SRC.indexOf("const RACER_MODE_TONE");
  assert.ok(at > 0);
  const block = RACER_SRC.slice(at, at + 1500);
  for (const mode of EXPERIENCE_MODES) {
    assert.match(block, new RegExp(`${mode}:`), `${mode} must have its own tone entry`);
  }
  assert.match(block, /Neutral and concise/, "Competitive gets an explicit neutral/concise entry, not silence");
});

test("buildRacerTurnMessage: a mode-bearing game carries its tone framing", () => {
  for (const mode of EXPERIENCE_MODES) {
    const state = toRacerPublicState(game(mode));
    const content = buildRacerTurnMessage(state, { forceFinal: false, clueAvailable: false });
    assert.match(content, /TONE:/, `${mode} must carry a TONE line`);
  }
});

test("buildRacerTurnMessage: a legacy game (no experience_mode) carries NO tone framing at all", () => {
  const state = toRacerPublicState(game(null));
  const content = buildRacerTurnMessage(state, { forceFinal: false, clueAvailable: false });
  assert.doesNotMatch(content, /TONE:/);
});

test("buildRacerTurnMessage: Humorous tone explicitly forbids distorting the question's meaning", () => {
  const state = toRacerPublicState(game("humorous"));
  const content = buildRacerTurnMessage(state, { forceFinal: false, clueAvailable: false });
  assert.match(content, /must never blur, hedge, or change what is actually being asked/);
});

test("buildRacerTurnMessage: Teaching tone forbids exposing private reasoning or splitting into two questions", () => {
  const state = toRacerPublicState(game("teaching"));
  const content = buildRacerTurnMessage(state, { forceFinal: false, clueAvailable: false });
  assert.match(content, /Never reveal your private reasoning or working notes, never turn one question into two/);
});

test("CORE_RACER_RULES remains byte-verified and untouched by the tone addition", () => {
  const state = toRacerPublicState(game("humorous"));
  const content = buildRacerTurnMessage(state, { forceFinal: false, clueAvailable: false });
  assert.ok(content.includes(CORE_RACER_RULES));
  assert.ok(
    content.endsWith(`${CORE_RACER_RULES}\n\nTake your turn.`),
    "the strategy block must still be the last thing before the instruction, regardless of mode"
  );
});

test("no version bump: RACER_PROMPT_VERSION is unchanged by the tone addition", () => {
  assert.equal(RACER_PROMPT_VERSION, "racer/5.0.0");
});

test("SOURCE: renderModeTone is wired into buildRacerTurnMessage but NOT into buildGuessIntentMessage (disclosed limitation)", () => {
  const turnFnAt = RACER_SRC.indexOf("export function buildRacerTurnMessage");
  const intentFnAt = RACER_SRC.indexOf("export function buildGuessIntentMessage");
  assert.ok(turnFnAt > 0 && intentFnAt > turnFnAt);
  const turnFn = RACER_SRC.slice(turnFnAt, intentFnAt);
  const intentFn = RACER_SRC.slice(intentFnAt, intentFnAt + 1200);
  assert.match(turnFn, /renderModeTone\(state\)/);
  assert.doesNotMatch(intentFn, /renderModeTone/);
});

test("buildGuessIntentMessage: no TONE line reaches the disambiguation path", () => {
  const state = toRacerPublicState(game("humorous", [entry({ composer_response: "NO" })]));
  const content = buildGuessIntentMessage(state, "Is the target GPT-4?");
  assert.doesNotMatch(content, /TONE:/);
});

// ---------------------------------------------------------------------------
// 2. Terminal/result copy varies by mode -- headline only, never the verdict.
// ---------------------------------------------------------------------------

test("resultCopy: 2-argument call sites are byte-identical to before this completion pass", () => {
  // Same literal assertions as test/humanVsHuman.test.ts's own pins.
  assert.equal(resultCopy("racer_incorrect", "composer").headline, "NYERTÉL!");
  assert.equal(resultCopy("racer_correct", "racer").headline, "ELTALÁLTAD!");
  assert.equal(resultCopy("racer_correct", "composer").headline, "VESZTETTÉL");
  assert.equal(resultCopy("composer_win_integrity_upheld", "racer").headline, "FELADTAD");
});

test("resultCopy: Friendly and Humorous vary the headline without touching detail or won", () => {
  for (const mode of ["friendly", "humorous"] as ExperienceMode[]) {
    const base = resultCopy("racer_correct", "racer");
    const withMode = resultCopy("racer_correct", "racer", mode);
    assert.notEqual(withMode.headline, "", `${mode} must produce a real headline`);
    assert.equal(withMode.detail, base.detail, `${mode} must not change detail`);
    assert.equal(withMode.won, base.won, `${mode} must not change won`);
  }
});

test("resultCopy: Competitive and Teaching (and legacy/null) share the baseline headline exactly", () => {
  const base = resultCopy("racer_incorrect", "composer");
  assert.equal(resultCopy("racer_incorrect", "composer", "competitive").headline, base.headline);
  assert.equal(resultCopy("racer_incorrect", "composer", "teaching").headline, base.headline);
  assert.equal(resultCopy("racer_incorrect", "composer", null).headline, base.headline);
});

test("resultCopy: the integrity-violation outcome keeps neutral wording in every mode", () => {
  const base = resultCopy("racer_win_integrity_violation", "racer");
  for (const mode of ["friendly", "humorous", "teaching", "competitive"] as ExperienceMode[]) {
    assert.equal(resultCopy("racer_win_integrity_violation", "racer", mode).headline, base.headline);
  }
});

const RESULT_PANEL_SRC = readFileSync("app/game/[id]/ResultPanel.tsx", "utf8");
const RACER_CLIENT_SRC = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");

test("SOURCE: ResultPanel.tsx (GameClient) has distinct Friendly/Humorous headline maps and a mode-aware selector", () => {
  assert.match(RESULT_PANEL_SRC, /const HEADLINE_FRIENDLY/);
  assert.match(RESULT_PANEL_SRC, /const HEADLINE_HUMOROUS/);
  assert.match(RESULT_PANEL_SRC, /function headlineFor\(game: GameRecord\)/);
  assert.match(RESULT_PANEL_SRC, /\{headlineFor\(game\)\}/);
});

test("SOURCE: RacerClient.tsx has distinct Friendly/Humorous headline maps and a mode-aware selector", () => {
  assert.match(RACER_CLIENT_SRC, /const RESULT_HEADLINE_FRIENDLY/);
  assert.match(RACER_CLIENT_SRC, /const RESULT_HEADLINE_HUMOROUS/);
  assert.match(RACER_CLIENT_SRC, /function resultHeadlineFor\(game: GameRecord\)/);
  assert.match(RACER_CLIENT_SRC, /\{resultHeadlineFor\(game\)\}/);
});

// ---------------------------------------------------------------------------
// 3. The Teaching in-play strategy tip -- only where a human actually asks
//    questions, never in GameClient (no human Racer seat there).
// ---------------------------------------------------------------------------

test("EXPERIENCE_MODE_STRATEGY_TIP_HU has an entry ONLY for teaching", () => {
  assert.ok(EXPERIENCE_MODE_STRATEGY_TIP_HU.teaching);
  for (const mode of EXPERIENCE_MODES) {
    if (mode === "teaching") continue;
    assert.equal(EXPERIENCE_MODE_STRATEGY_TIP_HU[mode], undefined, `${mode} must have no strategy tip`);
  }
});

test("SOURCE: RacerClient.tsx renders the Teaching strategy tip", () => {
  assert.match(RACER_CLIENT_SRC, /EXPERIENCE_MODE_STRATEGY_TIP_HU\[game\.experience_mode\]/);
});

const HUMAN_CLIENT_SRC = readFileSync("app/game/[id]/HumanClient.tsx", "utf8");
test("SOURCE: HumanClient.tsx renders the Teaching strategy tip only for the racer seat (!iAmComposer)", () => {
  const at = HUMAN_CLIENT_SRC.indexOf("EXPERIENCE_MODE_STRATEGY_TIP_HU[view.experience_mode]");
  assert.ok(at > 0);
  const block = HUMAN_CLIENT_SRC.slice(Math.max(0, at - 300), at);
  assert.match(block, /!iAmComposer/);
});

const GAME_CLIENT_SRC = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
test("SOURCE: GameClient.tsx (no human Racer seat) never renders the strategy tip", () => {
  assert.doesNotMatch(GAME_CLIENT_SRC, /EXPERIENCE_MODE_STRATEGY_TIP_HU/);
});

// ---------------------------------------------------------------------------
// 4. Safe-presentation boundary still holds: no truth/verdict code path
//    gained an experienceMode parameter as part of this completion.
// ---------------------------------------------------------------------------

test("SOURCE: truth/adjudication/integrity/correction/no-spelling/entitlement code paths remain free of experienceMode", () => {
  // lib/clueCredits.ts is deliberately NOT in this list: its experience_mode
  // branch is the already-approved SUGO hint-availability gate from the
  // original V2.8.8 pass (decision #2/#8 -- Competitive structurally has no
  // hints), a different thing from the "credit accounting" decision #7
  // names, which is the PLAY-CREDIT/entitlement ledger checked below.
  const files = [
    "lib/prompts/composerAnswer.ts", // answerAsComposer specifically, checked below
    "lib/prompts/adjudicator.ts",
    "lib/prompts/integrityReview.ts",
    "lib/prompts/validator.ts",
    "lib/prompts/questionEdit.ts",
    "lib/questionPolicy.ts",
    "lib/prompts/composerTarget.ts",
    "lib/entitlements.ts",
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (file === "lib/prompts/composerAnswer.ts") {
      // requestClueFromComposer legitimately takes experienceMode (tone-only,
      // approved in the original V2.8.8 pass) -- isolate answerAsComposer only.
      const fnAt = src.indexOf("export async function answerAsComposer");
      const nextAt = src.indexOf("export async function requestClueFromComposer");
      assert.ok(fnAt > 0 && nextAt > fnAt);
      const fn = src.slice(fnAt, nextAt);
      assert.doesNotMatch(fn, /experienceMode/i);
      continue;
    }
    assert.doesNotMatch(src, /experienceMode/i, `${file} must not reference experienceMode`);
  }
});

test("SOURCE: racer.ts's runRacerTurn/resolveGuessIntent decision logic is untouched -- only message assembly gained tone", () => {
  // The RED FLAGS / SELECT / guess-timing logic lives entirely inside
  // CORE_RACER_RULES (already byte-verified above) and validateCandidateMove
  // (lib/layerTwo.ts, untouched by this file). This just pins that the new
  // tone constant/function are additive, not inserted into any decision path.
  assert.match(RACER_SRC, /function renderModeTone\(state: RacerPublicState\): string \{/);
});
