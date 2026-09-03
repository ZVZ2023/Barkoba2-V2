import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  computeStructuralEffect,
  deriveLayerTwoState,
  validateCandidateMove,
  resolveLivingRoute,
  resolvePlaceRoute,
  nextMandatoryGate,
  GATE_PROPOSITIONS,
  type LayerTwoCandidate,
} from "../lib/layerTwo";
import type { QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.5 — Layer Two Reasoning Engine, deterministic core. V2.8.5
// ENGINE-CONTRACT CORRECTION — rewritten to cover the six defects fixed
// after independent review (see lib/layerTwo.ts's own "CORRECTION —" notes).
// Pure, no I/O — exactly the discipline lib/phaseOne.ts and lib/rewind.ts
// already established for this codebase's other replay-derived state
// machines.
// ---------------------------------------------------------------------------

function modelEntry(
  turnIndex: number,
  layerTwo: Partial<{
    dimension: string | null;
    question_kind: string | null;
    proposition_id: string | null;
    parent_proposition: string | null;
    predicate_strength: "stable" | "typical" | null;
    sandbox_repair: boolean;
    sandbox_repair_reason: string | null;
    sandbox_repair_to: string | null;
  }>,
  answer: "YES" | "NO" | "AMBIGUOUS" | null
): QuestionLogEntry {
  const questionText = `Q${turnIndex}`;
  return {
    id: randomUUID(),
    turn_index: turnIndex,
    turn_type: "question",
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
    model_id: "some-model",
    model_provider: "anthropic",
    prompt_version: "racer/5.0.0",
    answered_at: answer !== null ? new Date().toISOString() : null,
    pre_revision_question_text: null,
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
    racer_output_raw: JSON.stringify({
      action: "question",
      question_text: questionText,
      guess_text: null,
      rationale: "",
      dimension: layerTwo.dimension ?? null,
      question_kind: layerTwo.question_kind ?? null,
      proposition_id: layerTwo.proposition_id ?? null,
      parent_proposition: layerTwo.parent_proposition ?? null,
      predicate_strength: layerTwo.predicate_strength ?? null,
      sandbox_repair: layerTwo.sandbox_repair === true,
      sandbox_repair_reason: layerTwo.sandbox_repair_reason ?? null,
      sandbox_repair_to: layerTwo.sandbox_repair_to ?? null,
    }),
  };
}

/** A fully-formed, valid candidate — tests mutate a copy to introduce exactly one defect at a time. */
function fullCandidate(overrides: Partial<LayerTwoCandidate> = {}): LayerTwoCandidate {
  return {
    question_text: "a question",
    dimension: "d",
    question_kind: "discriminator",
    proposition_id: "p1",
    parent_proposition: null,
    predicate_strength: "stable",
    sandbox_repair: false,
    sandbox_repair_reason: null,
    sandbox_repair_to: null,
    ...overrides,
  };
}

const EMPTY_STATE = () => deriveLayerTwoState([], "physical");

// --- computeStructuralEffect -------------------------------------------------

test("IS-IS never produces a structural effect, regardless of declared kind/strength", () => {
  assert.equal(
    computeStructuralEffect({ question_kind: "branch_gate", predicate_strength: "stable" }, "AMBIGUOUS"),
    "none"
  );
  assert.equal(
    computeStructuralEffect({ question_kind: "premise_audit", predicate_strength: "stable" }, "AMBIGUOUS"),
    "none"
  );
});

test("typical predicate strength never produces a structural effect", () => {
  assert.equal(
    computeStructuralEffect({ question_kind: "branch_gate", predicate_strength: "typical" }, "YES"),
    "none"
  );
  assert.equal(
    computeStructuralEffect({ question_kind: "adaptive_partition", predicate_strength: "typical" }, "NO"),
    "none"
  );
});

test("a stable branch_gate opens on YES, closes on NO", () => {
  assert.equal(
    computeStructuralEffect({ question_kind: "branch_gate", predicate_strength: "stable" }, "YES"),
    "branch_opened"
  );
  assert.equal(
    computeStructuralEffect({ question_kind: "branch_gate", predicate_strength: "stable" }, "NO"),
    "branch_closed"
  );
});

test("genuine scalar refinement (adaptive_partition, stable) counts as progress regardless of polarity", () => {
  assert.equal(
    computeStructuralEffect({ question_kind: "adaptive_partition", predicate_strength: "stable" }, "YES"),
    "scalar_tightened"
  );
  assert.equal(
    computeStructuralEffect({ question_kind: "adaptive_partition", predicate_strength: "stable" }, "NO"),
    "scalar_tightened"
  );
});

// --- CORRECTION 1: mandatory metadata ---------------------------------------

test("1a. missing dimension is rejected", () => {
  const result = validateCandidateMove(fullCandidate({ dimension: null }), EMPTY_STATE());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /dimension/);
});

test("1b. empty-string dimension is rejected (not merely non-null)", () => {
  const result = validateCandidateMove(fullCandidate({ dimension: "   " }), EMPTY_STATE());
  assert.equal(result.ok, false);
});

test("1c. missing question_kind is rejected", () => {
  const result = validateCandidateMove(fullCandidate({ question_kind: null }), EMPTY_STATE());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /question_kind/);
});

test("1d. missing proposition_id is rejected", () => {
  const result = validateCandidateMove(fullCandidate({ proposition_id: null }), EMPTY_STATE());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /proposition_id/);
});

test("1e. missing predicate_strength is rejected", () => {
  const result = validateCandidateMove(fullCandidate({ predicate_strength: null }), EMPTY_STATE());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /predicate_strength/);
});

test("1f. a fully-formed candidate with no other violation is accepted", () => {
  assert.deepEqual(validateCandidateMove(fullCandidate(), EMPTY_STATE()), { ok: true });
});

test("1g. an ordinary question with missing/null metadata enters existing technical recovery, not silent acceptance — proven at the validator boundary runRacerTurn throws on", () => {
  // runRacerTurn() (lib/prompts/racer.ts) throws exactly this validator's
  // reason when validateCandidateMove rejects a candidate, which surfaces
  // through the pre-existing racer_unavailable technical-recovery path (see
  // test/racerNoConcession.test.ts's own established pattern for that path).
  // This test pins the CONTRACT the throw depends on: a metadata-incomplete
  // candidate is rejected, never silently repaired or accepted.
  const result = validateCandidateMove(fullCandidate({ dimension: null, proposition_id: null }), EMPTY_STATE());
  assert.equal(result.ok, false);
});

// --- CORRECTION 3: sandbox repair declaration consistency -------------------

test("3a. sandbox_repair true requires a reason", () => {
  const result = validateCandidateMove(
    fullCandidate({ sandbox_repair: true, sandbox_repair_reason: null, sandbox_repair_to: "living" }),
    EMPTY_STATE()
  );
  assert.equal(result.ok, false);
});

test("3b. sandbox_repair true requires a target", () => {
  const result = validateCandidateMove(
    fullCandidate({ sandbox_repair: true, sandbox_repair_reason: "structural_dead_end", sandbox_repair_to: null }),
    EMPTY_STATE()
  );
  assert.equal(result.ok, false);
});

test("3c. sandbox_repair_to must differ from the active sandbox", () => {
  const result = validateCandidateMove(
    fullCandidate({
      sandbox_repair: true,
      sandbox_repair_reason: "structural_dead_end",
      sandbox_repair_to: "physical", // EMPTY_STATE()'s activeSandbox is "physical"
    }),
    EMPTY_STATE()
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /must differ from the active sandbox/);
});

test("3d. sandbox_repair false requires reason and target to both be null", () => {
  const withReason = validateCandidateMove(
    fullCandidate({ sandbox_repair: false, sandbox_repair_reason: "structural_dead_end" }),
    EMPTY_STATE()
  );
  assert.equal(withReason.ok, false);
  const withTarget = validateCandidateMove(
    fullCandidate({ sandbox_repair: false, sandbox_repair_to: "living" }),
    EMPTY_STATE()
  );
  assert.equal(withTarget.ok, false);
});

test("3e. a valid repair declaration is accepted", () => {
  const result = validateCandidateMove(
    fullCandidate({ sandbox_repair: true, sandbox_repair_reason: "structural_dead_end", sandbox_repair_to: "living" }),
    EMPTY_STATE()
  );
  assert.deepEqual(result, { ok: true });
});

test("3f. only one repair per game — a second attempt is rejected even if otherwise valid", () => {
  const qaLog = [
    modelEntry(
      1,
      { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "stable", sandbox_repair: true, sandbox_repair_reason: "structural_dead_end", sandbox_repair_to: "living" },
      "NO"
    ),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.equal(state.sandboxRepairUsed, true);
  const secondAttempt = fullCandidate({
    sandbox_repair: true,
    sandbox_repair_reason: "invariant_contradiction",
    sandbox_repair_to: "place",
  });
  const result = validateCandidateMove(secondAttempt, state);
  assert.equal(result.ok, false);
});

test("3g. a successful (YES) repair changes activeSandbox to the proposed target", () => {
  const qaLog = [
    modelEntry(
      1,
      { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "stable", sandbox_repair: true, sandbox_repair_reason: "structural_dead_end", sandbox_repair_to: "living" },
      "YES"
    ),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.equal(state.activeSandbox, "living");
  assert.equal(state.originalSandbox, "physical");
  assert.notEqual(state.originalSandbox, state.activeSandbox, "originalSandbox must stay put so callers can detect the change");
  assert.equal(state.repairContested, false);
  assert.equal(state.sandboxRepairUsed, true);
});

test("3h. a rejected (NO) repair keeps the original sandbox but still spends the repair", () => {
  const qaLog = [
    modelEntry(
      1,
      { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "stable", sandbox_repair: true, sandbox_repair_reason: "structural_dead_end", sandbox_repair_to: "living" },
      "NO"
    ),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.equal(state.activeSandbox, "physical");
  assert.equal(state.sandboxRepairUsed, true);
});

test("3i. an IS-IS repair changes neither sandbox, spends the repair, and marks it contested", () => {
  const qaLog = [
    modelEntry(
      1,
      { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "stable", sandbox_repair: true, sandbox_repair_reason: "structural_dead_end", sandbox_repair_to: "living" },
      "AMBIGUOUS"
    ),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.equal(state.activeSandbox, "physical");
  assert.equal(state.sandboxRepairUsed, true);
  assert.equal(state.repairContested, true);
});

test("3j. correction removes repaired state: a shorter replayed qa_log (as after a rewind) reverts to the original sandbox", () => {
  const withRepair = [
    modelEntry(
      1,
      { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "stable", sandbox_repair: true, sandbox_repair_reason: "structural_dead_end", sandbox_repair_to: "living" },
      "YES"
    ),
  ];
  assert.equal(deriveLayerTwoState(withRepair, "physical").activeSandbox, "living");
  // A correction's rewind (lib/rewind.ts's splitAtTurn) truncates qa_log
  // before this turn ever existed -- replaying the shorter log must show no
  // repair at all, exactly as if it never happened.
  assert.equal(deriveLayerTwoState([], "physical").activeSandbox, "physical");
  assert.equal(deriveLayerTwoState([], "physical").sandboxRepairUsed, false);
});

// --- CORRECTION 6: stable NO hard-excludes regardless of question_kind -----

test("6a. a stable NO on a discriminator (not branch_gate/premise_audit) still hard-excludes the proposition", () => {
  const qaLog = [modelEntry(1, { dimension: "d", question_kind: "discriminator", proposition_id: "p1", predicate_strength: "stable" }, "NO")];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.ok(state.blockedPropositions.has("p1"));
});

test("6b. a stable NO on adaptive_partition also hard-excludes its own proposition", () => {
  const qaLog = [modelEntry(1, { dimension: "d", question_kind: "adaptive_partition", proposition_id: "p1", predicate_strength: "stable" }, "NO")];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.ok(state.blockedPropositions.has("p1"));
});

test("6c. hard parent blocks descendants regardless of the parent's own question_kind label", () => {
  const qaLog = [modelEntry(1, { dimension: "d", question_kind: "discriminator", proposition_id: "container", predicate_strength: "stable" }, "NO")];
  const state = deriveLayerTwoState(qaLog, "physical");
  const child = fullCandidate({ proposition_id: "child", parent_proposition: "container" });
  assert.equal(validateCandidateMove(child, state).ok, false);
});

// --- CORRECTION 6: typical YES supports, typical NO does not ---------------

test("6d. a typical YES marks the proposition as typically-supported", () => {
  const qaLog = [modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "typical" }, "YES")];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.ok(state.typicalOnlySupported.has("p1"));
});

test("6e. a typical NO is NOT recorded as support for anything — it produces no enforceable state at all", () => {
  const qaLog = [modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "typical" }, "NO")];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.equal(state.typicalOnlySupported.has("p1"), false);
  assert.equal(state.blockedPropositions.has("p1"), false);
  // A child naming p1 as parent is therefore LEGAL -- a typical NO never
  // blocks descent the way a stable NO does, and never "supports" it either.
  const child = fullCandidate({ proposition_id: "child", parent_proposition: "p1" });
  assert.deepEqual(validateCandidateMove(child, state), { ok: true });
});

// --- CORRECTION 6: operationalization targets its PARENT ---------------------

test("6f. operationalization YES hard-supports/opens the parent — a child of it becomes legal", () => {
  const qaLog = [
    modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "gate", predicate_strength: "stable" }, "AMBIGUOUS"),
    modelEntry(2, { dimension: "d", question_kind: "operationalization", proposition_id: "gate_op1", parent_proposition: "gate", predicate_strength: "stable" }, "YES"),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.equal(state.contestedPropositions.has("gate"), false);
  assert.equal(state.typicalOnlySupported.has("gate"), false);
  assert.equal(state.blockedPropositions.has("gate"), false);
  const child = fullCandidate({ proposition_id: "child", parent_proposition: "gate" });
  assert.deepEqual(validateCandidateMove(child, state), { ok: true });
});

test("6g. operationalization NO hard-excludes/blocks the parent — a child of it is illegal", () => {
  const qaLog = [
    modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "gate", predicate_strength: "stable" }, "AMBIGUOUS"),
    modelEntry(2, { dimension: "d", question_kind: "operationalization", proposition_id: "gate_op1", parent_proposition: "gate", predicate_strength: "stable" }, "NO"),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.ok(state.blockedPropositions.has("gate"));
  const child = fullCandidate({ proposition_id: "child", parent_proposition: "gate" });
  assert.equal(validateCandidateMove(child, state).ok, false);
});

test("6h. operationalization IS-IS leaves the parent contested, and permits no third operationalization", () => {
  const qaLog = [
    modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "gate", predicate_strength: "stable" }, "AMBIGUOUS"),
    modelEntry(2, { dimension: "d", question_kind: "operationalization", proposition_id: "gate_op1", parent_proposition: "gate", predicate_strength: "stable" }, "AMBIGUOUS"),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.ok(state.contestedPropositions.has("gate"));
  const thirdAttempt = fullCandidate({ question_kind: "operationalization", proposition_id: "gate_op2", parent_proposition: "gate" });
  const result = validateCandidateMove(thirdAttempt, state);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /already received its one permitted operationalization/);
});

// --- FINAL ENGINE-CONTRACT CORRECTION finding 3: target-specific validation

test("finding-3 negative: an operationalization with no parent_proposition at all is rejected", () => {
  const result = validateCandidateMove(fullCandidate({ question_kind: "operationalization", parent_proposition: null }), EMPTY_STATE());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /operationalization requires a non-null parent_proposition/);
});

test("finding-3 negative: an operationalization targeting a NEVER-ASKED (fabricated) proposition is rejected -- relabeling alone must not bypass legality", () => {
  const state = EMPTY_STATE();
  const result = validateCandidateMove(
    fullCandidate({ question_kind: "operationalization", parent_proposition: "never_asked_p1" }),
    state
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /must target a currently contested/);
});

test("finding-3 negative: an operationalization targeting a STABLE-YES-supported (not contested) proposition is rejected", () => {
  const qaLog = [modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "stable" }, "YES")];
  const state = deriveLayerTwoState(qaLog, "physical");
  const result = validateCandidateMove(
    fullCandidate({ question_kind: "operationalization", parent_proposition: "p1" }),
    state
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /must target a currently contested/);
});

test("finding-3 positive: an operationalization targeting the exact contested proposition is legal, independent of any stalled dimension", () => {
  const qaLog = [modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "stable" }, "AMBIGUOUS")];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.ok(state.contestedPropositions.has("p1"));
  const result = validateCandidateMove(
    fullCandidate({ question_kind: "operationalization", proposition_id: "p1_op1", parent_proposition: "p1" }),
    state
  );
  assert.deepEqual(result, { ok: true });
});

test("finding-3 negative: a premise_audit with no parent_proposition at all is rejected", () => {
  const result = validateCandidateMove(fullCandidate({ question_kind: "premise_audit", parent_proposition: null }), EMPTY_STATE());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /premise_audit requires a non-null parent_proposition/);
});

test("finding-3 negative: a premise_audit targeting a NEVER-ASKED (fabricated) proposition is rejected", () => {
  const result = validateCandidateMove(
    fullCandidate({ question_kind: "premise_audit", parent_proposition: "never_asked_p1" }),
    EMPTY_STATE()
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /must target a proposition supported only by typical evidence/);
});

test("finding-3 negative: a premise_audit targeting a STABLE-supported (not typical-only) proposition is rejected -- stable evidence needs no audit", () => {
  const qaLog = [modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "stable" }, "YES")];
  const state = deriveLayerTwoState(qaLog, "physical");
  const result = validateCandidateMove(
    fullCandidate({ question_kind: "premise_audit", parent_proposition: "p1" }),
    state
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /must target a proposition supported only by typical evidence/);
});

test("finding-3 negative: when a SPECIFIC premise_audit is pending, auditing a DIFFERENT (even genuinely typical-YES) proposition is rejected", () => {
  const qaLog = [
    // p1: typical YES, immediately followed by p2: typical YES in the SAME
    // dimension -- this stalls "d" AND sets pendingPremiseAudit to "p2"
    // (the SECOND, most recent typical-YES non-progress turn).
    modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "typical" }, "YES"),
    modelEntry(2, { dimension: "d", question_kind: "branch_gate", proposition_id: "p2", predicate_strength: "typical" }, "YES"),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.equal(state.pendingPremiseAudit, "p2");
  assert.ok(state.typicalOnlySupported.has("p1"), "p1 is a genuine typical-YES proposition too -- not fabricated, just the wrong one");
  const wrongTarget = fullCandidate({ question_kind: "premise_audit", parent_proposition: "p1" });
  const result = validateCandidateMove(wrongTarget, state);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /a premise_audit is specifically pending for proposition "p2"/);

  const rightTarget = fullCandidate({ question_kind: "premise_audit", parent_proposition: "p2" });
  assert.deepEqual(validateCandidateMove(rightTarget, state), { ok: true });
});

test("finding-3 positive: a premise_audit targeting a typical-YES proposition is legal even when NOTHING is stalled yet (a general rule, not merely a stall-recovery exception)", () => {
  const qaLog = [modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "typical" }, "YES")];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.equal(state.stalledDimensions.has("d"), false, "one typical-YES turn alone does not stall anything");
  const result = validateCandidateMove(
    fullCandidate({ dimension: "d", question_kind: "premise_audit", proposition_id: "audit1", parent_proposition: "p1" }),
    state
  );
  assert.deepEqual(result, { ok: true });
});

// --- the progress lease: two non-progress turns stall the dimension --------

test("two consecutive non-progress questions in the same dimension stall it", () => {
  const qaLog = [
    modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "typical" }, "YES"),
    modelEntry(2, { dimension: "d", question_kind: "branch_gate", proposition_id: "p2", predicate_strength: "typical" }, "YES"),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.ok(state.stalledDimensions.has("d"));
  const thirdSameDimension = fullCandidate({ proposition_id: "p3", dimension: "d" });
  const result = validateCandidateMove(thirdSameDimension, state);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /stalled/);
});

test("genuine scalar refinement resets the non-progress lease, so the dimension does not stall", () => {
  const qaLog = [
    modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "typical" }, "YES"),
    modelEntry(2, { dimension: "d", question_kind: "adaptive_partition", proposition_id: "p2", predicate_strength: "stable" }, "NO"),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.equal(state.stalledDimensions.has("d"), false);
});

// --- CORRECTION 6: stalled-dimension re-entry — audit/operationalization ONLY

test("stalled-dimension re-entry: an ORDINARY return (no audit) stays rejected even after visiting other dimensions", () => {
  const qaLog = [
    modelEntry(1, { dimension: "d1", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "typical" }, "YES"),
    modelEntry(2, { dimension: "d1", question_kind: "branch_gate", proposition_id: "p2", predicate_strength: "typical" }, "YES"), // d1 stalls
    modelEntry(3, { dimension: "d2", question_kind: "branch_gate", proposition_id: "p3", predicate_strength: "stable" }, "YES"), // switch away, legal
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.ok(state.stalledDimensions.has("d1"));
  const returnToD1 = fullCandidate({ dimension: "d1", proposition_id: "p4" });
  assert.equal(validateCandidateMove(returnToD1, state).ok, false);
});

test("stalled-dimension re-entry: a premise_audit/operationalization in the exact stalled dimension is legal and, on a stable resolution, reactivates it", () => {
  const qaLog = [
    modelEntry(1, { dimension: "d", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "typical" }, "YES"),
    modelEntry(2, { dimension: "d", question_kind: "branch_gate", proposition_id: "p2", predicate_strength: "typical" }, "YES"),
  ];
  const state = deriveLayerTwoState(qaLog, "physical");
  assert.ok(state.stalledDimensions.has("d"));
  const audit = fullCandidate({ dimension: "d", question_kind: "premise_audit", proposition_id: "audit1", parent_proposition: "p2" });
  assert.deepEqual(validateCandidateMove(audit, state), { ok: true });

  const afterAudit = deriveLayerTwoState(
    [...qaLog, modelEntry(3, { dimension: "d", question_kind: "premise_audit", proposition_id: "audit1", parent_proposition: "p2", predicate_strength: "stable" }, "YES")],
    "physical"
  );
  assert.equal(afterAudit.stalledDimensions.has("d"), false);
  const ordinaryReturn = fullCandidate({ dimension: "d", proposition_id: "p5" });
  assert.deepEqual(validateCandidateMove(ordinaryReturn, afterAudit), { ok: true });
});

// --- historical/legacy compatibility ----------------------------------------

test("a legacy turn with no Layer Two metadata contributes nothing structural — not blocked, not stalled, not contested", () => {
  const legacy: QuestionLogEntry = modelEntry(1, {}, "NO");
  legacy.racer_output_raw = JSON.stringify({
    action: "question",
    question_text: "Is it alive?",
    guess_text: null,
    rationale: "",
  }); // no dimension/question_kind/etc. at all — pre-5.0.0 shape
  const state = deriveLayerTwoState([legacy], "physical");
  assert.equal(state.blockedPropositions.size, 0);
  assert.equal(state.stalledDimensions.size, 0);
  assert.equal(state.contestedPropositions.size, 0);
  assert.equal(state.sandboxRepairUsed, false);
  assert.equal(state.activeSandbox, "physical");
});

// --- CORRECTION 2: Living whole-organism gate — YES/NO/IS-IS routes --------

/**
 * A deterministic gate entry, exactly as app/api/game/[id]/turn/route.ts
 * constructs one (model_id: null, rationale: "layer_two_deterministic") —
 * NOT modelEntry(), whose non-null model_id would trip nextMandatoryGate's
 * own "alreadyReachedModel" compatibility guard and make it return null.
 */
function deterministicGateEntry(
  turnIndex: number,
  dimension: string,
  propositionId: string,
  parentProposition: string | null,
  answer: "YES" | "NO" | "AMBIGUOUS"
): QuestionLogEntry {
  const questionText = `GateQ${turnIndex}`;
  const base = modelEntry(
    turnIndex,
    { dimension, question_kind: parentProposition ? "operationalization" : "branch_gate", proposition_id: propositionId, parent_proposition: parentProposition, predicate_strength: "stable" },
    answer
  );
  return {
    ...base,
    question_text: questionText,
    model_id: null,
    model_provider: null,
    prompt_version: null,
    racer_output_raw: JSON.stringify({
      action: "question",
      question_text: questionText,
      guess_text: null,
      rationale: "layer_two_deterministic",
      dimension,
      question_kind: parentProposition ? "operationalization" : "branch_gate",
      proposition_id: propositionId,
      parent_proposition: parentProposition,
      predicate_strength: "stable",
      sandbox_repair: false,
      sandbox_repair_reason: null,
      sandbox_repair_to: null,
    }),
  };
}

function livingGateEntry(turnIndex: number, propositionId: string, answer: "YES" | "NO" | "AMBIGUOUS"): QuestionLogEntry {
  const parent = propositionId === GATE_PROPOSITIONS.livingWholeOrganismOp ? GATE_PROPOSITIONS.livingWholeOrganism : null;
  return deterministicGateEntry(turnIndex, "living.whole_organism", propositionId, parent, answer);
}

test("Living route: gate YES resolves to whole_organism", () => {
  const qaLog = [livingGateEntry(1, GATE_PROPOSITIONS.livingWholeOrganism, "YES")];
  assert.equal(resolveLivingRoute(qaLog, "kind"), "whole_organism");
});

test("Living route: gate NO resolves to part_product", () => {
  const qaLog = [livingGateEntry(1, GATE_PROPOSITIONS.livingWholeOrganism, "NO")];
  assert.equal(resolveLivingRoute(qaLog, "kind"), "part_product");
});

test("Living route: gate IS-IS with no operationalization yet is contested, never silently part_product", () => {
  const qaLog = [livingGateEntry(1, GATE_PROPOSITIONS.livingWholeOrganism, "AMBIGUOUS")];
  assert.equal(resolveLivingRoute(qaLog, "kind"), "contested");
});

test("Living route: gate IS-IS then operationalization YES resolves to whole_organism", () => {
  const qaLog = [
    livingGateEntry(1, GATE_PROPOSITIONS.livingWholeOrganism, "AMBIGUOUS"),
    livingGateEntry(2, GATE_PROPOSITIONS.livingWholeOrganismOp, "YES"),
  ];
  assert.equal(resolveLivingRoute(qaLog, "kind"), "whole_organism");
});

test("Living route: gate IS-IS then operationalization NO resolves to part_product", () => {
  const qaLog = [
    livingGateEntry(1, GATE_PROPOSITIONS.livingWholeOrganism, "AMBIGUOUS"),
    livingGateEntry(2, GATE_PROPOSITIONS.livingWholeOrganismOp, "NO"),
  ];
  assert.equal(resolveLivingRoute(qaLog, "kind"), "part_product");
});

test("Living route: a second IS-IS (on the operationalization) stays contested forever, never silently part_product", () => {
  const qaLog = [
    livingGateEntry(1, GATE_PROPOSITIONS.livingWholeOrganism, "AMBIGUOUS"),
    livingGateEntry(2, GATE_PROPOSITIONS.livingWholeOrganismOp, "AMBIGUOUS"),
  ];
  assert.equal(resolveLivingRoute(qaLog, "kind"), "contested");
});

test("nextMandatoryGate: Living IS-IS injects exactly the one operationalization question, not a third reformulation", () => {
  const qaLog = [livingGateEntry(1, GATE_PROPOSITIONS.livingWholeOrganism, "AMBIGUOUS")];
  const gate = nextMandatoryGate(qaLog, "living", "living", "kind", "en");
  assert.ok(gate);
  assert.match(gate!.questionText, /Narrowing that/);
  assert.equal(gate!.meta.proposition_id, GATE_PROPOSITIONS.livingWholeOrganismOp);

  const afterOp = [...qaLog, livingGateEntry(2, GATE_PROPOSITIONS.livingWholeOrganismOp, "AMBIGUOUS")];
  assert.equal(nextMandatoryGate(afterOp, "living", "living", "kind", "en"), null);
});

// --- CORRECTION 2: Place Earth-membership gate — YES/NO/IS-IS routes -------

function placeGateEntry(turnIndex: number, propositionId: string, answer: "YES" | "NO" | "AMBIGUOUS"): QuestionLogEntry {
  const parent = propositionId === GATE_PROPOSITIONS.placeEarthOp ? GATE_PROPOSITIONS.placeEarth : null;
  const dimension = propositionId === GATE_PROPOSITIONS.placeElsewhere ? "place.elsewhere_membership" : "place.earth_membership";
  return deterministicGateEntry(turnIndex, dimension, propositionId, parent, answer);
}

test("Place route: Earth gate YES resolves to earth", () => {
  const qaLog = [placeGateEntry(1, GATE_PROPOSITIONS.placeEarth, "YES")];
  assert.equal(resolvePlaceRoute(qaLog), "earth");
});

test("Place route: Earth gate NO resolves to off_earth (never a third reformulation)", () => {
  const qaLog = [placeGateEntry(1, GATE_PROPOSITIONS.placeEarth, "NO")];
  assert.equal(resolvePlaceRoute(qaLog), "off_earth");
});

test("Place route: Earth gate IS-IS with no operationalization yet is contested, never silently off_earth", () => {
  const qaLog = [placeGateEntry(1, GATE_PROPOSITIONS.placeEarth, "AMBIGUOUS")];
  assert.equal(resolvePlaceRoute(qaLog), "contested");
});

test("Place route: Earth gate IS-IS then operationalization YES resolves to earth", () => {
  const qaLog = [
    placeGateEntry(1, GATE_PROPOSITIONS.placeEarth, "AMBIGUOUS"),
    placeGateEntry(2, GATE_PROPOSITIONS.placeEarthOp, "YES"),
  ];
  assert.equal(resolvePlaceRoute(qaLog), "earth");
});

test("Place route: Earth gate IS-IS then operationalization NO resolves to off_earth", () => {
  const qaLog = [
    placeGateEntry(1, GATE_PROPOSITIONS.placeEarth, "AMBIGUOUS"),
    placeGateEntry(2, GATE_PROPOSITIONS.placeEarthOp, "NO"),
  ];
  assert.equal(resolvePlaceRoute(qaLog), "off_earth");
});

test("Place route: a second IS-IS (on the operationalization) leaves Earth membership contested forever — never pretend off-Earth, never a third question", () => {
  const qaLog = [
    placeGateEntry(1, GATE_PROPOSITIONS.placeEarth, "AMBIGUOUS"),
    placeGateEntry(2, GATE_PROPOSITIONS.placeEarthOp, "AMBIGUOUS"),
  ];
  assert.equal(resolvePlaceRoute(qaLog), "contested");
  const gate = nextMandatoryGate(qaLog, "place", "place", "kind", "en");
  assert.equal(gate, null, "a resolved-contested Earth gate must not ask a third reformulation");
});

test("nextMandatoryGate: Place Earth NO asks the elsewhere-in-the-universe gate next, exactly once", () => {
  const qaLog = [placeGateEntry(1, GATE_PROPOSITIONS.placeEarth, "NO")];
  const gate = nextMandatoryGate(qaLog, "place", "place", "kind", "en");
  assert.ok(gate);
  assert.match(gate!.questionText, /elsewhere in the universe/);

  const afterElsewhere = [...qaLog, placeGateEntry(2, GATE_PROPOSITIONS.placeElsewhere, "NO")];
  assert.equal(nextMandatoryGate(afterElsewhere, "place", "place", "kind", "en"), null);
});

// --- FINAL CORRECTION finding 2: a repair into Living/Place must still face that sandbox's gate

test("nextMandatoryGate: a game with existing model-authored turns under 'physical' that just repaired into 'place' STILL receives the Earth gate (the legacy guard must not swallow a fresh repair)", () => {
  const qaLog = [
    modelEntry(1, { dimension: "physical.a", question_kind: "discriminator", proposition_id: "p1", predicate_strength: "stable" }, "YES"),
    modelEntry(2, { dimension: "physical.b", question_kind: "discriminator", proposition_id: "p2", predicate_strength: "stable" }, "NO"),
    modelEntry(
      3,
      { dimension: "physical.c", question_kind: "branch_gate", proposition_id: "p3", predicate_strength: "stable", sandbox_repair: true, sandbox_repair_reason: "structural_dead_end", sandbox_repair_to: "place" },
      "YES"
    ),
  ];
  // Sanity: the OLD legacy guard alone (sandbox === originalSandbox, i.e. no
  // repair) would still correctly grandfather a truly pre-existing "place"
  // game with prior model turns and never ask a retroactive gate.
  assert.equal(nextMandatoryGate(qaLog, "place", "place", "kind", "en"), null);

  // But this game's ACTIVE sandbox ("place") differs from its ORIGINAL one
  // ("physical") -- the repair just happened, and "place" has never had a
  // chance to see its own gate. The gate must fire despite the game already
  // having several model-authored turns.
  const gate = nextMandatoryGate(qaLog, "place", "physical", "kind", "en");
  assert.ok(gate, "a freshly-repaired sandbox must receive its mandatory gate, not be grandfathered away");
  assert.match(gate!.questionText, /Does the target correspond to Earth itself/);
  assert.equal(gate!.meta.proposition_id, GATE_PROPOSITIONS.placeEarth);
});

test("nextMandatoryGate: a repair into 'living' STILL receives the whole-organism gate", () => {
  const qaLog = [
    modelEntry(1, { dimension: "physical.a", question_kind: "discriminator", proposition_id: "p1", predicate_strength: "stable" }, "YES"),
    modelEntry(
      2,
      { dimension: "physical.b", question_kind: "branch_gate", proposition_id: "p2", predicate_strength: "stable", sandbox_repair: true, sandbox_repair_reason: "invariant_contradiction", sandbox_repair_to: "living" },
      "YES"
    ),
  ];
  const gate = nextMandatoryGate(qaLog, "living", "physical", "kind", "en");
  assert.ok(gate, "a freshly-repaired-into-living sandbox must receive its mandatory gate");
  assert.equal(gate!.meta.proposition_id, GATE_PROPOSITIONS.livingWholeOrganism);
});

test("nextMandatoryGate: once the post-repair gate is itself answered, it is not asked again (repair does not reset the gate's own one-shot nature)", () => {
  const qaLog = [
    modelEntry(
      1,
      { dimension: "physical.a", question_kind: "branch_gate", proposition_id: "p1", predicate_strength: "stable", sandbox_repair: true, sandbox_repair_reason: "structural_dead_end", sandbox_repair_to: "place" },
      "YES"
    ),
    placeGateEntry(2, GATE_PROPOSITIONS.placeEarth, "YES"),
  ];
  assert.equal(nextMandatoryGate(qaLog, "place", "physical", "kind", "en"), null);
});
