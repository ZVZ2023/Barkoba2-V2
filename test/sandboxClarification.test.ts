import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  deriveSandboxClarificationState,
  isSandboxClarificationEntry,
  sandboxClarificationRawOutput,
} from "../lib/sandboxClarification";
import type { QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.5 — the "+1" corridor. V2.8.5 ENGINE-CONTRACT CORRECTION — rewritten
// for the corrected Mixed-first decision order and IS-IS-never-eliminates
// behavior (see lib/sandboxClarification.ts's own module doc for why the
// old Living/Physical/Place/Event/Abstract-first order was defective: an
// honest Physical+Place target answered YES to Physical and could never
// reach Mixed at all).
//
// Pure, replay-based, exactly like lib/phaseOne.ts's own discipline.
// ---------------------------------------------------------------------------

function clarificationEntry(turnIndex: number, questionText: string, answer: "YES" | "NO" | "AMBIGUOUS" | null): QuestionLogEntry {
  return {
    id: randomUUID(),
    turn_index: turnIndex,
    turn_type: "question",
    racer_output_raw: sandboxClarificationRawOutput(questionText),
    question_text: questionText,
    guess_text: null,
    composer_response: answer,
    ambiguous_explanation: null,
    guess_detector_flagged: false,
    guess_detector_method: null,
    guess_intent_outcome: null,
    clue_text: null,
    original_question_text: null,
    edit_status: null,
    edit_reason: null,
    ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(),
    model_id: null,
    model_provider: null,
    prompt_version: null,
    answered_at: answer !== null ? new Date().toISOString() : null,
    pre_revision_question_text: null,
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
  };
}

/** Drive the corridor forward by answering `answers` in order, returning the resulting state after each. */
function drive(language: "en" | "hu", answers: readonly ("YES" | "NO" | "AMBIGUOUS")[]) {
  let qaLog: QuestionLogEntry[] = [];
  let turnIndex = 1;
  let state = deriveSandboxClarificationState(qaLog, language);
  for (const answer of answers) {
    if (state.complete) break;
    qaLog = [...qaLog, clarificationEntry(turnIndex, state.nextQuestionText, answer)];
    turnIndex += 1;
    state = deriveSandboxClarificationState(qaLog, language);
  }
  return state;
}

test("isSandboxClarificationEntry recognizes its own marker and nothing else", () => {
  const clarification = clarificationEntry(1, "x", null);
  assert.equal(isSandboxClarificationEntry(clarification), true);

  const ordinary: QuestionLogEntry = {
    ...clarification,
    racer_output_raw: JSON.stringify({ action: "question", question_text: "x", guess_text: null, rationale: "" }),
  };
  assert.equal(isSandboxClarificationEntry(ordinary), false);
});

// --- CORRECTION 4: Mixed-first decision order -------------------------------

test("4a. the very first question asked is the Mixed gate, not any per-sense question", () => {
  const en = deriveSandboxClarificationState([], "en");
  assert.equal(en.complete, false);
  if (!en.complete) assert.match(en.nextQuestionText, /more than one major sense/);

  const hu = deriveSandboxClarificationState([], "hu");
  assert.equal(hu.complete, false);
  if (!hu.complete) assert.match(hu.nextQuestionText, /több fő jelentés/);
});

test("4b. Mixed gate NO -> single-sense selection -> a YES resolves immediately to that one sandbox", () => {
  const afterGate = drive("en", ["NO"]);
  assert.equal(afterGate.complete, false);
  if (!afterGate.complete) assert.match(afterGate.nextQuestionText, /single sense you intended/);

  const resolved = drive("en", ["NO", "NO", "YES"]); // gate NO, living NO, physical YES
  assert.equal(resolved.complete, true);
  if (resolved.complete && !resolved.failed) {
    assert.equal(resolved.resolvedSandbox, "physical");
    assert.equal(resolved.mixedSenses, null);
  }
});

test("4c. an honest Physical+Place target reaches Mixed and selects exactly two senses — the defect this correction fixes", () => {
  // Under the OLD order this target would have answered YES to the first
  // per-sense question (Physical) and resolved as single-sense, never
  // reaching Mixed at all. Under the CORRECTED order, Mixed is asked FIRST.
  const resolved = drive("en", [
    "YES", // Mixed gate: YES, more than one sense is essential
    "NO", // pick loop: living -> NO
    "YES", // pick loop: physical -> YES (1st pick)
    "YES", // pick loop: place -> YES (2nd pick, stop)
  ]);
  assert.equal(resolved.complete, true);
  if (resolved.complete && !resolved.failed) {
    assert.equal(resolved.resolvedSandbox, "physical");
    assert.deepEqual(resolved.mixedSenses, ["physical", "place"]);
  }
});

test("4d. NO on the Mixed gate, then NO on every single-sense question, fails with no coherent contract", () => {
  const final = drive("en", ["NO", "NO", "NO", "NO", "NO", "NO"]); // gate NO, then 5x per-sense NO
  assert.equal(final.complete, true);
  if (final.complete) {
    assert.equal(final.failed, true);
    assert.equal(final.resolvedSandbox, null);
  }
});

test("4e. the corrected Hungarian abstract label reads 'Elvont/fogalmi', never the old mistranslation 'informatikai'", () => {
  const state = drive("hu", ["NO", "NO", "NO", "NO", "NO"]); // gate NO, living/physical/place/event NO -> abstract question next
  assert.equal(state.complete, false);
  if (!state.complete) {
    assert.match(state.nextQuestionText, /Elvont\/fogalmi/);
    assert.doesNotMatch(state.nextQuestionText, /informatikai/);
  }
});

// --- CORRECTION 2 (+1 sub-defect): IS-IS never eliminates a sense -----------

test("2a. IS-IS on the Mixed gate grants exactly one narrower operationalization, and does not itself resolve Mixed either way", () => {
  const afterAmbiguous = drive("en", ["AMBIGUOUS"]);
  assert.equal(afterAmbiguous.complete, false);
  if (!afterAmbiguous.complete) assert.match(afterAmbiguous.nextQuestionText, /materially misrepresent/);
});

test("2b. Mixed-gate IS-IS then operationalization YES resolves as genuinely Mixed (choosing one would misrepresent it)", () => {
  const resolved = drive("en", [
    "AMBIGUOUS", // Mixed gate contested
    "YES", // operationalization: choosing only one WOULD misrepresent -> Mixed
    "NO", // living NO
    "YES", // physical YES (1st pick)
    "YES", // place YES (2nd pick)
  ]);
  assert.equal(resolved.complete, true);
  if (resolved.complete && !resolved.failed) {
    assert.deepEqual(resolved.mixedSenses, ["physical", "place"]);
  }
});

test("2c. Mixed-gate IS-IS then operationalization NO resolves as single-sense", () => {
  const resolved = drive("en", [
    "AMBIGUOUS",
    "NO", // operationalization: choosing only one would NOT misrepresent -> not mixed
    "NO", // living NO
    "YES", // physical YES
  ]);
  assert.equal(resolved.complete, true);
  if (resolved.complete && !resolved.failed) {
    assert.equal(resolved.resolvedSandbox, "physical");
    assert.equal(resolved.mixedSenses, null);
  }
});

test("2d. a SECOND unresolved IS-IS (on the operationalization itself) ends the corridor in truthful failure — never guessed either way, never a third reformulation", () => {
  const final = drive("en", ["AMBIGUOUS", "AMBIGUOUS"]);
  assert.equal(final.complete, true);
  if (final.complete) {
    assert.equal(final.failed, true);
    assert.equal(final.resolvedSandbox, null);
  }
});

test("2e. IS-IS on an ordinary per-sense question during single-sense selection never eliminates that sense and never silently advances — it ends the corridor", () => {
  const final = drive("en", ["NO" /* mixed gate */, "AMBIGUOUS" /* living: contested */]);
  assert.equal(final.complete, true);
  if (final.complete) {
    assert.equal(final.failed, true);
    assert.equal(final.resolvedSandbox, null);
  }
});

test("2f. IS-IS on an ordinary per-sense question during two-sense (mixed) selection never eliminates that sense and never silently advances — it ends the corridor", () => {
  const final = drive("en", [
    "YES" /* mixed gate: YES */,
    "NO" /* living: NO */,
    "AMBIGUOUS" /* physical: contested */,
  ]);
  assert.equal(final.complete, true);
  if (final.complete) {
    assert.equal(final.failed, true);
    assert.equal(final.resolvedSandbox, null);
  }
});

test("replay is deterministic: calling twice on the same qa_log produces the same result (correction/reload compatibility)", () => {
  const gateQuestion = deriveSandboxClarificationState([], "hu");
  assert.equal(gateQuestion.complete, false);
  if (gateQuestion.complete) return;
  const qaLog = [clarificationEntry(1, gateQuestion.nextQuestionText, "NO")];
  const first = deriveSandboxClarificationState(qaLog, "hu");
  const second = deriveSandboxClarificationState(qaLog, "hu");
  assert.deepEqual(first, second);
});
