import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createGame, getGame } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { POST as correctPOST } from "../app/api/game/[id]/correct/route";
import { anthropicAdapter } from "../lib/providers/anthropic";
import { RACER_PROMPT_VERSION, CORE_RACER_RULES, runRacerTurn, buildRacerTurnMessage } from "../lib/prompts/racer";
import { detectGuess } from "../lib/guessDetector";
import { deriveLayerTwoState } from "../lib/layerTwo";
import { questionNumbers } from "../lib/questionNumbers";
import { isSandboxClarificationEntry, sandboxClarificationRawOutput } from "../lib/sandboxClarification";
import type { ToolCallResult } from "../lib/providers/types";
import type { QuestionLogEntry, RacerPublicState } from "../lib/types";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();
const TEST_COMPOSER_ID = testPlayerId("a");

// ---------------------------------------------------------------------------
// V2.8.5 — Layer Two Reasoning Engine, route-level integration. Same harness
// pattern as test/racerNoConcession.test.ts and test/phaseOneIntegration.test
// .ts: the REAL route handler, the REAL gameStore, the in-memory KV fallback.
// Only the Racer LLM call is ever mocked.
// ---------------------------------------------------------------------------

async function makeGame(maxQuestions: number, language: "en" | "hu" = "hu") {
  const gameId = randomUUID();
  await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: maxQuestions,
    game_language: language,
    composer_player_id: TEST_COMPOSER_ID,
  });
  return gameId;
}

function turnRequest(gameId: string, body?: Record<string, unknown>) {
  const json = body === undefined ? "" : JSON.stringify(body);
  return new NextRequest(`http://localhost/api/game/${gameId}/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": body === undefined ? "0" : String(Buffer.byteLength(json)),
      "x-bk-player": TEST_COMPOSER_ID,
    },
    body: body === undefined ? undefined : json,
  });
}

async function callTurn(gameId: string, body?: Record<string, unknown>) {
  const res = await turnPOST(turnRequest(gameId, body), { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

function stubOnce(output: unknown) {
  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => ({ output, resolvedModel: "stub" })) as typeof anthropicAdapter.callTool;
  return () => {
    anthropicAdapter.callTool = original;
  };
}

async function callCorrect(gameId: string, body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/game/${gameId}/correct`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bk-player": TEST_COMPOSER_ID },
    body: JSON.stringify(body),
  });
  const res = await correctPOST(req, { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

/**
 * Stubs anthropicAdapter.callTool to return `outputs` in order (the last one
 * repeats if more calls happen than outputs supplied) and records the
 * rendered user-message content sent on each call, so a test can inspect
 * exactly what card/summary text the Racer would have seen.
 */
function stubSequence(outputs: readonly unknown[]) {
  const original = anthropicAdapter.callTool;
  const capturedContents: string[] = [];
  let callIndex = 0;
  anthropicAdapter.callTool = (async (request: { messages: { content: unknown }[] }) => {
    capturedContents.push(String(request.messages[0]!.content));
    const output = outputs[Math.min(callIndex, outputs.length - 1)];
    callIndex += 1;
    return { output, resolvedModel: "stub" } as ToolCallResult<unknown>;
  }) as typeof anthropicAdapter.callTool;
  return {
    capturedContents,
    restore: () => {
      anthropicAdapter.callTool = original;
    },
  };
}

/** Drives a fresh game to Phase One completion with a "physical" sandbox lock (no mandatory gate applies), ready for the model's first Layer Two turn. */
async function makePhysicalGameReadyForLayerTwo(maxQuestions = 20) {
  const gameId = await makeGame(maxQuestions, "en");
  const opening = await callTurn(gameId);
  const afterQ1 = await callTurn(gameId, { answer: "NO", expected_revision: opening.data.game.revision }); // not alive
  const afterQ2 = await callTurn(gameId, { answer: "YES", expected_revision: afterQ1.data.game.revision }); // physical, locked; asks specificity
  return { gameId, afterQ2 };
}

// V2.8.5 FINAL ENGINE-CONTRACT CORRECTION (finding 2) — this repair targets
// "event", which has NO mandatory gate, so these tests can keep exercising
// "does a successful repair change what the very next Racer turn is told"
// in isolation from the SEPARATE finding-2 behavior (a repair into Living
// or Place must face THAT sandbox's own gate first) — see the dedicated
// "Repair into a gated sandbox" tests below for that.
const VALID_REPAIR_CANDIDATE = {
  action: "question",
  question_text: "Setting the sandbox aside: is a governing physical-material sense actually essential here?",
  guess_text: null,
  rationale: "test",
  dimension: "physical.sandbox_fit",
  question_kind: "branch_gate",
  proposition_id: "physical.sandbox_fit.p1",
  parent_proposition: null,
  predicate_strength: "stable",
  sandbox_repair: true,
  sandbox_repair_reason: "structural_dead_end",
  sandbox_repair_to: "event",
};

const ORDINARY_FOLLOWUP_CANDIDATE = {
  action: "question",
  question_text: "Is human action essential to what makes this the kind of event it is?",
  guess_text: null,
  rationale: "test",
  dimension: "event.kind",
  question_kind: "discriminator",
  proposition_id: "event.kind.p1",
  parent_proposition: null,
  predicate_strength: "stable",
  sandbox_repair: false,
  sandbox_repair_reason: null,
  sandbox_repair_to: null,
};

function repairCandidateTo(target: string, questionText: string, propositionId: string) {
  return {
    action: "question",
    question_text: questionText,
    guess_text: null,
    rationale: "test",
    dimension: "physical.sandbox_fit",
    question_kind: "branch_gate",
    proposition_id: propositionId,
    parent_proposition: null,
    predicate_strength: "stable",
    sandbox_repair: true,
    sandbox_repair_reason: "structural_dead_end",
    sandbox_repair_to: target,
  };
}

// --- Living mandatory gate ---------------------------------------------------

test("Living: the mandatory opening gate is injected deterministically, no model call, kind-scoped wording", async () => {
  const gameId = await makeGame(20, "en");
  // Spine: Q1 "Is it alive?" YES locks Living immediately (spineIndex 0).
  const opening = await callTurn(gameId);
  const afterLiving = await callTurn(gameId, { answer: "YES", expected_revision: opening.data.game.revision });
  // Phase One's specificity question follows next (kind/particular referent scope).
  assert.match(afterLiving.data.game.qa_log.at(-1).question_text, /uniquely identifiable individual/);

  const original = anthropicAdapter.callTool;
  let modelWasCalled = false;
  anthropicAdapter.callTool = (async () => {
    modelWasCalled = true;
    throw new Error("must not be called for a deterministic Layer Two gate");
  }) as typeof anthropicAdapter.callTool;
  try {
    const afterSpecificity = await callTurn(gameId, {
      answer: "NO", // kind, not particular
      expected_revision: afterLiving.data.game.revision,
    });
    assert.equal(afterSpecificity.status, 200);
    const lastEntry = afterSpecificity.data.game.qa_log.at(-1);
    assert.match(lastEntry.question_text, /kind of whole biological organism/);
    assert.equal(modelWasCalled, false, "the mandatory gate must not reach the model");
    assert.equal(lastEntry.model_id, null);
  } finally {
    anthropicAdapter.callTool = original;
  }
});

test("Living: the particular-scoped wording is used when referent scope is 'particular'", async () => {
  const gameId = await makeGame(20, "en");
  const opening = await callTurn(gameId);
  const afterLiving = await callTurn(gameId, { answer: "YES", expected_revision: opening.data.game.revision });
  const afterSpecificity = await callTurn(gameId, {
    answer: "YES", // particular
    expected_revision: afterLiving.data.game.revision,
  });
  assert.match(afterSpecificity.data.game.qa_log.at(-1).question_text, /Is this specific target itself a whole biological organism/);
});

// --- Place Earth-first gate ---------------------------------------------------

test("Place: the Earth-membership gate is mandatory and asked first, deterministically", async () => {
  const gameId = await makeGame(20, "en");
  // Spine: NO, NO, YES locks Place (index 2).
  const opening = await callTurn(gameId);
  const afterQ1 = await callTurn(gameId, { answer: "NO", expected_revision: opening.data.game.revision }); // not alive
  const afterQ2 = await callTurn(gameId, { answer: "NO", expected_revision: afterQ1.data.game.revision }); // not physical
  const afterQ3 = await callTurn(gameId, { answer: "YES", expected_revision: afterQ2.data.game.revision }); // place
  const afterSpecificity = await callTurn(gameId, { answer: "NO", expected_revision: afterQ3.data.game.revision }); // kind
  assert.match(afterSpecificity.data.game.qa_log.at(-1).question_text, /Does the target correspond to Earth itself/);
});

test("Place: NO on the Earth gate asks the elsewhere-in-the-universe gate next, still deterministically", async () => {
  const gameId = await makeGame(20, "en");
  const opening = await callTurn(gameId);
  const afterQ1 = await callTurn(gameId, { answer: "NO", expected_revision: opening.data.game.revision });
  const afterQ2 = await callTurn(gameId, { answer: "NO", expected_revision: afterQ1.data.game.revision });
  const afterQ3 = await callTurn(gameId, { answer: "YES", expected_revision: afterQ2.data.game.revision });
  const afterSpecificity = await callTurn(gameId, { answer: "NO", expected_revision: afterQ3.data.game.revision });
  const afterEarth = await callTurn(gameId, { answer: "NO", expected_revision: afterSpecificity.data.game.revision });
  assert.match(afterEarth.data.game.qa_log.at(-1).question_text, /elsewhere in the universe/);
});

test("Place: IS-IS on the Earth gate asks exactly one narrower operationalization, deterministically, no model call", async () => {
  const gameId = await makeGame(20, "en");
  const opening = await callTurn(gameId);
  const afterQ1 = await callTurn(gameId, { answer: "NO", expected_revision: opening.data.game.revision });
  const afterQ2 = await callTurn(gameId, { answer: "NO", expected_revision: afterQ1.data.game.revision });
  const afterQ3 = await callTurn(gameId, { answer: "YES", expected_revision: afterQ2.data.game.revision });
  const afterSpecificity = await callTurn(gameId, { answer: "NO", expected_revision: afterQ3.data.game.revision });

  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => {
    throw new Error("must not be called for a deterministic Layer Two operationalization");
  }) as typeof anthropicAdapter.callTool;
  try {
    const afterEarth = await callTurn(gameId, { answer: "AMBIGUOUS", expected_revision: afterSpecificity.data.game.revision });
    assert.equal(afterEarth.status, 200);
    assert.match(afterEarth.data.game.qa_log.at(-1).question_text, /Narrowing that/);
    assert.equal(afterEarth.data.game.qa_log.at(-1).model_id, null);
  } finally {
    anthropicAdapter.callTool = original;
  }
});

// --- +1 corridor: consumes no question --------------------------------------

test("+1: Phase One 'unclassified' triggers a private clarification that consumes no question, and never appears in a Racer-visible field", async () => {
  // max_questions must exceed 5 (Phase One's own spine length) or forceFinal
  // fires the instant Phase One completes, before the +1 corridor ever gets
  // a turn — see the route's own "forceFinal bypasses Phase One deliberately"
  // comment. 10 leaves ample room regardless.
  const gameId = await makeGame(10, "en");
  // Spine: NO,NO,NO,NO to reach Q5, then NO on Q5 -> unclassified.
  let res = await callTurn(gameId);
  for (const ans of ["NO", "NO", "NO", "NO", "NO"]) {
    res = await callTurn(gameId, { answer: ans, expected_revision: res.data.game.revision });
  }
  // Q1..Q5 were all Phase One spine questions -- none charged (Phase One's
  // own spine has always been free of question_count impact until Q5 itself,
  // which HAS been charged already by the time "unclassified" locks, since
  // Step 1 runs before Phase One's own branch is even reached). The +1
  // question that follows must NOT add to that.
  const beforeClarification = res.data.game.question_count;
  // V2.8.5 ENGINE-CONTRACT CORRECTION (defect 4) — the Mixed gate is asked
  // FIRST now, never a per-sense elimination question.
  const clarificationQuestion = res.data.game.qa_log.at(-1).question_text;
  assert.match(clarificationQuestion, /more than one major sense/);
  assert.equal(isSandboxClarificationEntry(res.data.game.qa_log.at(-1)), true);
  assert.equal(
    questionNumbers(res.data.game.qa_log as QuestionLogEntry[]).has(res.data.game.qa_log.at(-1).id),
    false,
    "defect 5 — a clarification entry must never receive a displayed question number"
  );

  const afterFirstPick = await callTurn(gameId, { answer: "NO", expected_revision: res.data.game.revision });
  assert.equal(
    afterFirstPick.data.game.question_count,
    beforeClarification,
    "a +1 clarification answer must not increment question_count"
  );
});

test("+1 UI truthfulness (defect 5): clarification entries never receive a question number, even once several have accumulated", async () => {
  const gameId = await makeGame(10, "en");
  let res = await callTurn(gameId);
  for (const ans of ["NO", "NO", "NO", "NO", "NO"]) {
    res = await callTurn(gameId, { answer: ans, expected_revision: res.data.game.revision });
  }
  // Mixed gate, then two more per-sense clarification questions.
  res = await callTurn(gameId, { answer: "NO", expected_revision: res.data.game.revision }); // mixed gate NO
  res = await callTurn(gameId, { answer: "NO", expected_revision: res.data.game.revision }); // living NO

  const qaLog = res.data.game.qa_log as QuestionLogEntry[];
  const clarificationEntries = qaLog.filter((e) => isSandboxClarificationEntry(e));
  assert.ok(clarificationEntries.length >= 2, "the test must have accumulated at least two clarification entries");
  const numbers = questionNumbers(qaLog);
  for (const e of clarificationEntries) {
    assert.equal(numbers.has(e.id), false, "no clarification entry may ever receive a displayed question number");
  }
});

test("+1 failure (defect 5): an incoherent target ends in the localized sandbox_clarification_failed contract, not a generic error, and the game's own record is preserved", async () => {
  const gameId = await makeGame(10, "en");
  let res = await callTurn(gameId);
  for (const ans of ["NO", "NO", "NO", "NO", "NO"]) {
    res = await callTurn(gameId, { answer: ans, expected_revision: res.data.game.revision });
  }
  assert.match(res.data.game.qa_log.at(-1).question_text, /more than one major sense/);

  // Mixed gate NO (1 answer), then NO on all five single-sense questions
  // (Living, Physical, Place, Event, Abstract -- 5 more answers) -> no
  // coherent contract. Six NOs total, each its own turn/answer round-trip.
  for (const ans of ["NO", "NO", "NO", "NO", "NO", "NO"]) {
    res = await callTurn(gameId, { answer: ans, expected_revision: res.data.game.revision });
  }
  assert.equal(res.status, 409, JSON.stringify(res.data));
  assert.equal(res.data.error, "sandbox_clarification_failed");
  // V2.8.5 FINAL ENGINE-CONTRACT CORRECTION (localization) — this game was
  // created with game_language "en", so its failure message must be
  // English, not the old hard-coded Hungarian.
  assert.match(res.data.message, /Could not establish a clear target category/);
  assert.doesNotMatch(res.data.message, /Nem sikerült/, "an English game must never receive Hungarian UI text");
  assert.ok(res.data.game, "the persisted game record must still be returned for the client to keep displaying history");

  // The failure must be durably persisted -- a fresh read shows the same terminal state, not a resumable one.
  const reloaded = await getGame(gameId);
  assert.ok(reloaded);
  assert.equal(reloaded!.qa_log.at(-1)?.composer_response, "NO");
});

test("+1 failure localization: a Hungarian game receives the Hungarian sandbox_clarification_failed message", async () => {
  const gameId = await makeGame(10, "hu");
  let res = await callTurn(gameId);
  for (const ans of ["NO", "NO", "NO", "NO", "NO", "NO", "NO", "NO", "NO", "NO", "NO"]) {
    res = await callTurn(gameId, { answer: ans, expected_revision: res.data.game.revision });
  }
  assert.equal(res.status, 409, JSON.stringify(res.data));
  assert.equal(res.data.error, "sandbox_clarification_failed");
  assert.match(res.data.message, /Nem sikerült egyértelmű célkategóriát megállapítani/);
});

// --- FINAL ENGINE-CONTRACT CORRECTION finding 1: Mixed reaches the Racer ---

test("+1 Mixed resolution: BOTH essential senses reach the Racer's actual prompt, not just the primary one (route-level, mocked model)", async () => {
  const gameId = await makeGame(10, "en");
  let res = await callTurn(gameId);
  for (const ans of ["NO", "NO", "NO", "NO", "NO"]) {
    res = await callTurn(gameId, { answer: ans, expected_revision: res.data.game.revision });
  }
  assert.match(res.data.game.qa_log.at(-1).question_text, /more than one major sense/);

  // Mixed gate: YES. Then pick loop: living NO, physical YES (1st), place YES (2nd) -> Physical+Place.
  res = await callTurn(gameId, { answer: "YES", expected_revision: res.data.game.revision });
  res = await callTurn(gameId, { answer: "NO", expected_revision: res.data.game.revision }); // living: NO
  res = await callTurn(gameId, { answer: "YES", expected_revision: res.data.game.revision }); // physical: YES (primary)
  const stub = stubSequence([ORDINARY_FOLLOWUP_CANDIDATE]);
  try {
    res = await callTurn(gameId, { answer: "YES", expected_revision: res.data.game.revision }); // place: YES (secondary) -> resolved, reaches model
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(stub.capturedContents.length, 1, "the resolved Mixed contract must reach the model on this very turn");
    // This is the defect: before the fix, only "physical" (the primary
    // sense) reached the model at all, and "place" was silently discarded.
    assert.match(
      stub.capturedContents[0]!,
      /MIXED TARGET — TWO ESSENTIAL SENSES.*"physical".*"place"/s,
      "both the primary (physical) and secondary (place) sense must be named in what the Racer actually receives"
    );
    assert.match(stub.capturedContents[0]!, /PHYSICAL CARD/, "the primary sense's card is still the active one");
  } finally {
    stub.restore();
  }
});

// --- V2.8.5.1 — premise_audit's parent requirement reaches the Racer -------

test("V2.8.5.1: the Racer's own prompt explicitly requires premise_audit to name its parent, and never to omit it", () => {
  const content = buildRacerTurnMessage(MINIMAL_LAYER_TWO_STATE_RACER_STATE, {
    forceFinal: false,
    clueAvailable: false,
  });
  assert.match(
    content,
    /parent_proposition is REQUIRED \(never null\)/,
    "the guidance the Racer actually receives must state the requirement explicitly, not just the validator"
  );
  assert.match(
    content,
    /MUST be the exact proposition_id of the typically-supported proposition you are auditing/
  );
  assert.match(
    content,
    /declare an ordinary discriminator\/branch_gate instead, never a premise_audit with no parent/
  );
});

// --- V2.8.5.2 — contested-parent guidance reaches the Racer -----------------

test("V2.8.5.2: the Racer's own prompt explicitly forbids building on a still-contested parent, and forbids routing around it with a new proposition_id", () => {
  const content = buildRacerTurnMessage(MINIMAL_LAYER_TWO_STATE_RACER_STATE, {
    forceFinal: false,
    clueAvailable: false,
  });
  assert.match(
    content,
    /NEVER ask a child question whose parent_proposition is a proposition still contested from an unresolved IS-IS/,
    "the guidance the Racer actually receives must state this explicitly -- the Q5 production forensic (game a0b7743b-...) found the model doing exactly this"
  );
  assert.match(
    content,
    /use the one permitted operationalization of that EXACT parent \(same proposition_id\)/
  );
  assert.match(
    content,
    /abandon that line of descent entirely and switch dimensions/
  );
  assert.match(
    content,
    /do not invent a new proposition to route around the contested one/
  );
});

// --- FINAL ENGINE-CONTRACT CORRECTION finding 4: raw sandbox_repair check --

const MINIMAL_LAYER_TWO_STATE_RACER_STATE: RacerPublicState = {
  question_count: 3,
  max_questions: 20,
  questions_remaining: 17,
  game_language: "en",
  transcript: [],
  clues: [],
  clue_credits_available: 0,
  phase_one: { sandbox: "physical", specificity: "kind", mixed_spine_questions: [] },
  layer_two: null,
};

test("runRacerTurn (finding 4): a provider response OMITTING sandbox_repair entirely throws, rather than being silently normalized to false", async () => {
  const layerTwoState = deriveLayerTwoState([], "physical");
  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => ({
    output: {
      action: "question",
      question_text: "Is it manufactured?",
      guess_text: null,
      rationale: "test",
      dimension: "physical.origin",
      question_kind: "discriminator",
      proposition_id: "physical.origin.p1",
      parent_proposition: null,
      predicate_strength: "stable",
      // sandbox_repair intentionally OMITTED. A provider is not guaranteed
      // to honor a tool schema's "required" list strictly -- this file's
      // own no-concession tests already establish that precedent for
      // `action`. The OLD code's `result.sandbox_repair === true` would
      // have silently turned this omission into a well-formed `false`,
      // defeating the claimed runtime rejection before it ever ran.
    },
    resolvedModel: "stub",
  })) as typeof anthropicAdapter.callTool;
  try {
    await assert.rejects(
      () => runRacerTurn(MINIMAL_LAYER_TWO_STATE_RACER_STATE, { forceFinal: false, layerTwoState }),
      /missing or invalid sandbox_repair/
    );
  } finally {
    anthropicAdapter.callTool = original;
  }
});

test("runRacerTurn (finding 4): a provider response with sandbox_repair as a non-boolean (e.g. the string \"false\") also throws", async () => {
  const layerTwoState = deriveLayerTwoState([], "physical");
  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => ({
    output: {
      action: "question",
      question_text: "Is it manufactured?",
      guess_text: null,
      rationale: "test",
      dimension: "physical.origin",
      question_kind: "discriminator",
      proposition_id: "physical.origin.p1",
      parent_proposition: null,
      predicate_strength: "stable",
      sandbox_repair: "false", // wrong type -- a string, not a boolean
    },
    resolvedModel: "stub",
  })) as typeof anthropicAdapter.callTool;
  try {
    await assert.rejects(
      () => runRacerTurn(MINIMAL_LAYER_TWO_STATE_RACER_STATE, { forceFinal: false, layerTwoState }),
      /missing or invalid sandbox_repair/
    );
  } finally {
    anthropicAdapter.callTool = original;
  }
});

test("runRacerTurn (finding 4): a well-formed sandbox_repair: false is accepted normally (no regression)", async () => {
  const layerTwoState = deriveLayerTwoState([], "physical");
  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => ({
    output: {
      action: "question",
      question_text: "Is it manufactured?",
      guess_text: null,
      rationale: "test",
      dimension: "physical.origin",
      question_kind: "discriminator",
      proposition_id: "physical.origin.p1",
      parent_proposition: null,
      predicate_strength: "stable",
      sandbox_repair: false,
      sandbox_repair_reason: null,
      sandbox_repair_to: null,
    },
    resolvedModel: "stub",
  })) as typeof anthropicAdapter.callTool;
  try {
    const result = await runRacerTurn(MINIMAL_LAYER_TWO_STATE_RACER_STATE, { forceFinal: false, layerTwoState });
    assert.equal(result.output.action, "question");
    assert.equal(result.output.sandbox_repair, false);
  } finally {
    anthropicAdapter.callTool = original;
  }
});

// --- CORRECTION 3: sandbox repair actually changes the card, route-level ---

test("Repair: a successful (YES) repair changes what the very next Racer turn is told (route-level, mocked model)", async () => {
  const { gameId, afterQ2 } = await makePhysicalGameReadyForLayerTwo();
  const stub = stubSequence([VALID_REPAIR_CANDIDATE, ORDINARY_FOLLOWUP_CANDIDATE]);
  try {
    const afterSpecificity = await callTurn(gameId, { answer: "NO", expected_revision: afterQ2.data.game.revision });
    assert.equal(afterSpecificity.data.game.qa_log.at(-1).question_text, VALID_REPAIR_CANDIDATE.question_text);
    assert.equal(stub.capturedContents.length, 1);
    assert.match(stub.capturedContents[0]!, /PHYSICAL CARD/, "the repair-declaring turn itself is still generated under the original (physical) card");

    const afterRepairYes = await callTurn(gameId, { answer: "YES", expected_revision: afterSpecificity.data.game.revision });
    assert.equal(afterRepairYes.status, 200, JSON.stringify(afterRepairYes.data));
    assert.equal(stub.capturedContents.length, 2, "answering the repair question must immediately generate the next Racer turn (event has no mandatory gate)");
    assert.match(
      stub.capturedContents[1]!,
      /SANDBOX REPAIRED: the effective sandbox is now "event", not the original "physical"/,
      "the very next turn's prompt must explicitly say the sandbox changed"
    );
    assert.doesNotMatch(stub.capturedContents[1]!, /PHYSICAL CARD/, "the stale physical card must not still be rendered after a successful repair");
    assert.match(stub.capturedContents[1]!, /EVENT — ADAPTIVE ROUTING/, "the new sandbox's own card must actually be rendered");

    const layerTwo = deriveLayerTwoState(afterRepairYes.data.game.qa_log, "physical");
    assert.equal(layerTwo.activeSandbox, "event");
  } finally {
    stub.restore();
  }
});

test("Repair: a rejected (NO) repair leaves the next Racer turn's card unchanged, but the repair is spent", async () => {
  const { gameId, afterQ2 } = await makePhysicalGameReadyForLayerTwo();
  const stub = stubSequence([VALID_REPAIR_CANDIDATE, ORDINARY_FOLLOWUP_CANDIDATE]);
  try {
    const afterSpecificity = await callTurn(gameId, { answer: "NO", expected_revision: afterQ2.data.game.revision });
    const afterRepairNo = await callTurn(gameId, { answer: "NO", expected_revision: afterSpecificity.data.game.revision });
    assert.equal(afterRepairNo.status, 200, JSON.stringify(afterRepairNo.data));
    assert.match(stub.capturedContents[1]!, /PHYSICAL CARD/, "the card must still be the original physical card after a rejected repair");
    assert.doesNotMatch(stub.capturedContents[1]!, /SANDBOX REPAIRED/);

    const layerTwo = deriveLayerTwoState(afterRepairNo.data.game.qa_log, "physical");
    assert.equal(layerTwo.activeSandbox, "physical");
    assert.equal(layerTwo.sandboxRepairUsed, true, "the one repair is spent even though it was rejected");
  } finally {
    stub.restore();
  }
});

test("Repair: an IS-IS repair leaves the next Racer turn's card unchanged, spends the repair, and is reported as contested", async () => {
  const { gameId, afterQ2 } = await makePhysicalGameReadyForLayerTwo();
  const stub = stubSequence([VALID_REPAIR_CANDIDATE, ORDINARY_FOLLOWUP_CANDIDATE]);
  try {
    const afterSpecificity = await callTurn(gameId, { answer: "NO", expected_revision: afterQ2.data.game.revision });
    const afterRepairAmbiguous = await callTurn(gameId, {
      answer: "AMBIGUOUS",
      expected_revision: afterSpecificity.data.game.revision,
    });
    assert.equal(afterRepairAmbiguous.status, 200, JSON.stringify(afterRepairAmbiguous.data));
    assert.match(stub.capturedContents[1]!, /PHYSICAL CARD/);
    assert.match(stub.capturedContents[1]!, /came back IS-IS/);

    const layerTwo = deriveLayerTwoState(afterRepairAmbiguous.data.game.qa_log, "physical");
    assert.equal(layerTwo.activeSandbox, "physical");
    assert.equal(layerTwo.repairContested, true);
  } finally {
    stub.restore();
  }
});

test("Repair + correction: rewinding past a successful repair's turn removes the repaired state entirely", async () => {
  const { gameId, afterQ2 } = await makePhysicalGameReadyForLayerTwo();
  const stub = stubSequence([VALID_REPAIR_CANDIDATE, ORDINARY_FOLLOWUP_CANDIDATE]);
  let afterRepairYes: { data: { game: { qa_log: QuestionLogEntry[]; revision: number } } };
  try {
    const afterSpecificity = await callTurn(gameId, { answer: "NO", expected_revision: afterQ2.data.game.revision });
    afterRepairYes = await callTurn(gameId, { answer: "YES", expected_revision: afterSpecificity.data.game.revision });
  } finally {
    stub.restore();
  }
  const repairedState = deriveLayerTwoState(afterRepairYes.data.game.qa_log, "physical");
  assert.equal(repairedState.activeSandbox, "event");

  const repairTurnIndex = afterRepairYes.data.game.qa_log.findIndex((e) => e.question_text === VALID_REPAIR_CANDIDATE.question_text) + 1;
  assert.ok(repairTurnIndex > 0);

  const corrected = await callCorrect(gameId, {
    turn_index: repairTurnIndex,
    answer: "NO", // any answer works -- correcting THIS turn discards it and everything after
    expected_log_length: afterRepairYes.data.game.qa_log.length,
  });
  // The correction endpoint re-asks the corrected turn's own question with the
  // new answer via its own deterministic replay -- it does not itself call
  // the model for a NEW question, so no further stub is required here.
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  const revertedState = deriveLayerTwoState(corrected.data.game.qa_log, "physical");
  assert.equal(revertedState.activeSandbox, "physical", "correcting away the repair turn must revert the effective sandbox");
  assert.equal(revertedState.sandboxRepairUsed, true, "the corrected turn still declared sandbox_repair -- only its ANSWER changed to NO");
});

// --- FINAL ENGINE-CONTRACT CORRECTION finding 2: repair into a gated sandbox

test("Repair into Place: a successful repair does NOT skip the mandatory Earth gate — the gate is asked before any further model call", async () => {
  const { gameId, afterQ2 } = await makePhysicalGameReadyForLayerTwo();
  const repairToPlace = repairCandidateTo(
    "place",
    "Setting the sandbox aside: could this be better understood as a place?",
    "physical.sandbox_fit.place1"
  );
  const stub = stubSequence([repairToPlace, ORDINARY_FOLLOWUP_CANDIDATE]);
  try {
    const afterSpecificity = await callTurn(gameId, { answer: "NO", expected_revision: afterQ2.data.game.revision });
    assert.equal(afterSpecificity.data.game.qa_log.at(-1).question_text, repairToPlace.question_text);
    assert.equal(stub.capturedContents.length, 1);

    // Answering the repair YES must NOT immediately reach the model again --
    // it must inject the deterministic Earth gate instead, exactly as a
    // game whose Phase One classification had ALWAYS been "place" would see.
    const afterRepairYes = await callTurn(gameId, { answer: "YES", expected_revision: afterSpecificity.data.game.revision });
    assert.equal(afterRepairYes.status, 200, JSON.stringify(afterRepairYes.data));
    assert.equal(stub.capturedContents.length, 1, "the Earth gate must be asked before any further model call -- the repair must not skip it");
    const gateEntry = afterRepairYes.data.game.qa_log.at(-1);
    assert.match(gateEntry.question_text, /Does the target correspond to Earth itself/);
    assert.equal(gateEntry.model_id, null, "the gate is a deterministic, zero-provider-call question");

    // Answering the gate itself (YES -> Earth route) is what finally reaches
    // the model, now correctly carrying both the repair note and the
    // route-selected Place/Earth card.
    const afterGate = await callTurn(gameId, { answer: "YES", expected_revision: afterRepairYes.data.game.revision });
    assert.equal(afterGate.status, 200, JSON.stringify(afterGate.data));
    assert.equal(stub.capturedContents.length, 2, "the model is reached only after the gate is resolved");
    assert.match(stub.capturedContents[1]!, /SANDBOX REPAIRED: the effective sandbox is now "place"/);
    assert.match(stub.capturedContents[1]!, /PLACE CARD — EARTH ROUTE/);
  } finally {
    stub.restore();
  }
});

test("Repair into Living: a successful repair does NOT skip the mandatory whole-organism gate", async () => {
  const { gameId, afterQ2 } = await makePhysicalGameReadyForLayerTwo();
  const repairToLiving = repairCandidateTo(
    "living",
    "Setting the sandbox aside: could this be better understood as a living organism?",
    "physical.sandbox_fit.living1"
  );
  const stub = stubSequence([repairToLiving, ORDINARY_FOLLOWUP_CANDIDATE]);
  try {
    const afterSpecificity = await callTurn(gameId, { answer: "NO", expected_revision: afterQ2.data.game.revision }); // specificity: "kind"
    const afterRepairYes = await callTurn(gameId, { answer: "YES", expected_revision: afterSpecificity.data.game.revision });
    assert.equal(afterRepairYes.status, 200, JSON.stringify(afterRepairYes.data));
    assert.equal(stub.capturedContents.length, 1, "the whole-organism gate must be asked before any further model call");
    const gateEntry = afterRepairYes.data.game.qa_log.at(-1);
    assert.match(gateEntry.question_text, /kind of whole biological organism/);
    assert.equal(gateEntry.model_id, null);

    const afterGate = await callTurn(gameId, { answer: "YES", expected_revision: afterRepairYes.data.game.revision });
    assert.equal(stub.capturedContents.length, 2);
    assert.match(stub.capturedContents[1]!, /SANDBOX REPAIRED: the effective sandbox is now "living"/);
    assert.match(stub.capturedContents[1]!, /LIVING CARD — WHOLE-ORGANISM ROUTE/);
    void afterGate;
  } finally {
    stub.restore();
  }
});

test("Repair into Place: correcting away the repair also removes the gate answer that only existed because of it", async () => {
  const { gameId, afterQ2 } = await makePhysicalGameReadyForLayerTwo();
  const repairToPlace = repairCandidateTo(
    "place",
    "Setting the sandbox aside: could this be better understood as a place?",
    "physical.sandbox_fit.place2"
  );
  const stub = stubSequence([repairToPlace, ORDINARY_FOLLOWUP_CANDIDATE]);
  let afterGate: { data: { game: { qa_log: QuestionLogEntry[]; revision: number } } };
  try {
    const afterSpecificity = await callTurn(gameId, { answer: "NO", expected_revision: afterQ2.data.game.revision });
    const afterRepairYes = await callTurn(gameId, { answer: "YES", expected_revision: afterSpecificity.data.game.revision });
    afterGate = await callTurn(gameId, { answer: "YES", expected_revision: afterRepairYes.data.game.revision });
  } finally {
    stub.restore();
  }
  assert.equal(deriveLayerTwoState(afterGate.data.game.qa_log, "physical").activeSandbox, "place");

  const repairTurnIndex = afterGate.data.game.qa_log.findIndex((e) => e.question_text === repairToPlace.question_text) + 1;
  assert.ok(repairTurnIndex > 0);
  const corrected = await callCorrect(gameId, {
    turn_index: repairTurnIndex,
    answer: "NO",
    expected_log_length: afterGate.data.game.qa_log.length,
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  // The Earth gate entry itself only ever existed because of the repair --
  // truncating at the repair turn must remove it too, purely through replay.
  assert.equal(
    corrected.data.game.qa_log.some((e: QuestionLogEntry) => /Does the target correspond to Earth itself/.test(e.question_text ?? "")),
    false,
    "the gate answer that only existed downstream of the repair must not survive correcting the repair away"
  );
  const revertedState = deriveLayerTwoState(corrected.data.game.qa_log, "physical");
  assert.equal(revertedState.activeSandbox, "physical");
});

// --- CORRECTION 5: GameClient.tsx source contract for the private UI -------

test("GameClient.tsx source contract: the clarification UI is unnumbered, self-identifying, excluded from ordinary history, and failure has its own restart panel", () => {
  const src = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
  assert.match(src, /isSandboxClarificationEntry/, "must import/use the shared recognizer rather than re-deriving its own check");
  assert.match(src, /!isSandboxClarificationEntry\(e\)/, "answeredTurns() must exclude clarification entries from ordinary Racer-question history");
  assert.match(
    src,
    /Privát célpont-tisztázás.*nem az AI kérdése.*nem számít bele a kérdéseibe/,
    "the active clarification must state it is private and consumes no Racer question"
  );
  assert.match(
    src,
    /!isSandboxClarificationEntry\(pending\)\s*&&/,
    "the numbered badge must be suppressed specifically for a pending clarification entry"
  );
  assert.match(src, /sandboxClarificationFailed/, "must hold dedicated state for the failure panel, distinct from the generic error banner");
  assert.match(src, /Nem sikerült egyértelmű célkategóriát megállapítani/, "the failure panel must be localized and actionable, not a raw error code");
  assert.match(src, /Új játék/, "the failure panel must offer the existing New Game navigation");

  // V2.8.5 FINAL ENGINE-CONTRACT CORRECTION (localization) — an English game
  // must not receive this Hungarian copy; both the private-clarification
  // label and the failure panel must have an English variant, selected by
  // game.game_language, not a single hard-coded string.
  assert.match(src, /Private target clarification/, "the private-clarification label must have an English variant");
  assert.match(src, /Could not establish a clear target category/, "the failure panel heading must have an English variant");
  assert.match(src, /"New game"/, "the New Game button must have an English variant");
  assert.match(src, /\[game\.game_language\]/, "the bilingual copy must actually be selected by game.game_language, not merely declared");
});

// --- guessDetector regression: the exact section 6 examples -----------------

test("named-question prohibition: the exact section 6 examples are caught by the existing Guess Detector", () => {
  assert.equal(detectGuess("Is the target Kaposvár?").flagged, true);
  assert.equal(detectGuess("Is your answer Apple?").flagged, true);
});

// --- version and CORE_RACER_RULES continuity --------------------------------

test("Racer provenance is racer/5.0.0, and CORE_RACER_RULES is unchanged from racer/4.0.1", () => {
  assert.equal(RACER_PROMPT_VERSION, "racer/5.0.0");
  // The canonical block is still reproduced verbatim in DESIGN-NOTES against
  // racer/4.0.0 -- proving it was never edited when the version moved to
  // 4.0.1 or to 5.0.0.
  const notes = readFileSync("docs/DESIGN-NOTES.md", "utf8");
  assert.ok(notes.includes(CORE_RACER_RULES));
});

// --- Event/Abstract: shared safeguards, no frozen card ----------------------

test("Event and Abstract guidance exist, reference the shared rules, and name no frozen sequential card", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  assert.match(src, /EVENT_CARD_GUIDANCE/);
  assert.match(src, /ABSTRACT_CARD_GUIDANCE/);
  assert.match(src, /No frozen sequential card exists for Event/);
  assert.match(src, /No frozen sequential card exists for Abstract/);
  assert.match(src, /Is human action essential to what makes this the kind of event it is/);
  assert.match(src, /Avoid a sibling list of war, sport, disaster/, "must warn against a sibling list, not enumerate one as guidance to follow");
});
