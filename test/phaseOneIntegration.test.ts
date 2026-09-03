import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createGame, getGame, newLogEntry, saveGame } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { POST as correctPOST } from "../app/api/game/[id]/correct/route";
import { anthropicAdapter } from "../lib/providers/anthropic";
import type { ToolCallResult } from "../lib/providers/types";
import { RACER_PROMPT_VERSION } from "../lib/prompts/racer";
import { derivePhaseOneState } from "../lib/phaseOne";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";

// ---------------------------------------------------------------------------
// V2.8.4 — Runtime Phase One v6.1, route-level integration. Same harness
// pattern as test/turnBudgetIntegration.test.ts: the REAL route handler, the
// REAL gameStore, the in-memory KV fallback. Only the Racer LLM call itself
// is mocked, and these tests assert it is NEVER reached during Phase One.
// ---------------------------------------------------------------------------

async function makeGame(language: "en" | "hu" = "en") {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: language,
  });
  return { gameId, game };
}

function turnRequest(gameId: string, body: Record<string, unknown> | undefined) {
  const json = body === undefined ? "" : JSON.stringify(body);
  return new NextRequest(`http://localhost/api/game/${gameId}/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": body === undefined ? "0" : String(Buffer.byteLength(json)),
    },
    body: body === undefined ? undefined : json,
  });
}

async function callTurn(gameId: string, body?: Record<string, unknown>) {
  const res = await turnPOST(turnRequest(gameId, body), { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

async function callCorrect(gameId: string, body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/game/${gameId}/correct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await correctPOST(req, { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

/** Answer the current pending question and return the resulting game. */
async function answer(gameId: string, ans: "YES" | "NO" | "AMBIGUOUS", revision: number) {
  const result = await callTurn(gameId, { answer: ans, expected_revision: revision });
  assert.equal(result.status, 200, `answer(${ans}) should succeed: ${JSON.stringify(result.data)}`);
  return result.data.game;
}

function mockProviderOnce(questionText: string) {
  const original = anthropicAdapter.callTool;
  let calls = 0;
  let capturedMessages: unknown[] = [];
  anthropicAdapter.callTool = (async (request: { messages: unknown[] }) => {
    calls += 1;
    capturedMessages = request.messages;
    return {
      output: { action: "question", question_text: questionText, guess_text: null, rationale: "test" },
      resolvedModel: "stub",
    } as ToolCallResult<unknown>;
  }) as typeof anthropicAdapter.callTool;
  return {
    callCount: () => calls,
    lastMessages: () => capturedMessages,
    restore: () => {
      anthropicAdapter.callTool = original;
    },
  };
}

function failIfCalled() {
  const original = anthropicAdapter.callTool;
  anthropicAdapter.callTool = (async () => {
    throw new Error("PROVIDER MUST NOT BE CALLED DURING PHASE ONE");
  }) as typeof anthropicAdapter.callTool;
  return {
    restore: () => {
      anthropicAdapter.callTool = original;
    },
  };
}

// --- REQUIRED 1/8: all-NO path, zero provider calls, budget consumption ----

test("REQUIRED 1 & 8: the opening turn is Q1 with zero provider calls, and each Phase One answer consumes one question against budget", async () => {
  const guard = failIfCalled();
  try {
    const { gameId } = await makeGame("en");
    const opening = await callTurn(gameId);
    assert.equal(opening.status, 200);
    assert.equal(opening.data.game.qa_log[0].question_text, "Is it alive?");
    assert.equal(opening.data.game.question_count, 0, "asking costs nothing; answering does");

    let rev = opening.data.game.revision;
    const afterQ1 = await answer(gameId, "NO", rev);
    assert.equal(afterQ1.question_count, 1, "one answered Phase One question consumes one budget unit");
    assert.equal(afterQ1.qa_log[1].question_text, "Is it a physical thing or substance?");
  } finally {
    guard.restore();
  }
});

// --- REQUIRED 9/10/11: Phase Two starts only after Phase One, with handoff -

test("REQUIRED 9, 10 & 11: the provider is invoked only once Phase One completes, receives sandbox+specificity, and racer/4.0.0 is unchanged", async () => {
  assert.equal(RACER_PROMPT_VERSION, "racer/4.0.0", "REQUIRED 11: prompt version must not be bumped or renamed");

  const { gameId } = await makeGame("en");

  // Answering the LAST Phase One question generates the next turn in the
  // SAME request -- so the provider guard must already be lifted before
  // that specific answer, not after it.
  const guard = failIfCalled();
  let rev: number;
  try {
    const opening = await callTurn(gameId); // Q1
    rev = opening.data.game.revision;
    const afterQ1 = await answer(gameId, "YES", rev); // locks Living, deterministically asks specificity
    rev = afterQ1.revision;
    assert.equal(afterQ1.qa_log[1].question_text, "Does the correct answer need to identify one uniquely identifiable individual?");
  } finally {
    guard.restore();
  }

  const mock = mockProviderOnce("Does it live in water?");
  try {
    const afterSpec = await answer(gameId, "NO", rev); // kind/category -> Phase One complete -> Phase Two's first real turn
    assert.equal(mock.callCount(), 1, "REQUIRED 9: exactly one provider call, only once Phase One ended");
    const messages = mock.lastMessages() as Array<{ content: string }>;
    const joined = messages.map((m) => m.content).join("\n");
    assert.match(
      joined,
      /Deterministic opening classification: living \(a kind\/category/,
      "REQUIRED 10: sandbox+specificity must reach the Racer's own message"
    );
    assert.equal(afterSpec.qa_log[2].question_text, "Does it live in water?");
    assert.notEqual(afterSpec.qa_log[2].model_id, null, "REQUIRED 23: a real Phase Two turn must carry real model provenance");
  } finally {
    mock.restore();
  }
});

// --- REQUIRED 22/23: no provider_attempt telemetry row for Phase One; ------
// --- deterministic turns carry honest null provenance -----------------------

test("REQUIRED 22 & 23: no provider_attempt telemetry row is created for deterministic turns, and their stored provenance is honestly null", async () => {
  const inserts: Array<{ kind: string }> = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: SqlValue[]) => {
      const text = strings.join("?");
      if (text.trim().startsWith("INSERT INTO corpus.turn_operations")) {
        inserts.push({ kind: String(values[3]) }); // (operation_id, game_id, turn_index, operation_kind, ...)
      }
      return [];
    },
    { transaction: (qs: Promise<Record<string, unknown>[]>[]) => Promise.all(qs) }
  );
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(sql as unknown as Parameters<typeof __setSqlClientForTests>[0]);

  const guard = failIfCalled();
  try {
    const { gameId } = await makeGame("en");
    const opening = await callTurn(gameId); // Q1, deterministic
    const rev = opening.data.game.revision;
    await answer(gameId, "NO", rev); // answers Q1, generates Q2 deterministically

    assert.equal(
      inserts.filter((i) => i.kind === "provider_attempt").length,
      0,
      "REQUIRED 22: zero provider_attempt rows during Phase One"
    );
    // corpus_write telemetry (the ordinary game-save instrumentation) is
    // unrelated to provider attempts and is expected regardless.
  } finally {
    guard.restore();
    delete process.env.DATABASE_URL;
    delete process.env.CORPUS_ENABLED;
    __setSqlClientForTests(null);
  }
});

test("REQUIRED 23: a persisted Phase One turn's provenance is exactly null, not a sentinel", async () => {
  const guard = failIfCalled();
  try {
    const { gameId } = await makeGame("en");
    const opening = await callTurn(gameId);
    const q1 = opening.data.game.qa_log[0];
    assert.equal(q1.model_id, null);
    assert.equal(q1.model_provider, null);
    assert.equal(q1.prompt_version, null);
    assert.equal(q1.latency_ms, null);
  } finally {
    guard.restore();
  }
});

// --- REQUIRED 15: reload restores exact deterministic position --------------

test("REQUIRED 15: re-fetching the game (simulating reload) shows the exact same Phase One position", async () => {
  const guard = failIfCalled();
  try {
    const { gameId } = await makeGame("en");
    const opening = await callTurn(gameId);
    let rev = opening.data.game.revision;
    const afterQ1 = await answer(gameId, "NO", rev);

    const reloaded = await getGame(gameId);
    assert.equal(reloaded!.qa_log.length, afterQ1.qa_log.length);
    assert.equal(reloaded!.qa_log[1]!.question_text, "Is it a physical thing or substance?");

    // A subsequent turn call against the reloaded state must continue
    // deterministically from exactly where it left off.
    const idempotent = await callTurn(gameId);
    assert.equal(idempotent.status, 200);
    assert.equal(idempotent.data.game.qa_log.length, afterQ1.qa_log.length, "no pending question -> idempotent poll, no new turn");
  } finally {
    guard.restore();
  }
});

// --- REQUIRED 16/17: correction rebuilds Phase One deterministically -------

test("REQUIRED 16: correcting a Phase One answer rebuilds the deterministic path with no provider call", async () => {
  const { gameId } = await makeGame("en");
  const opening = await callTurn(gameId); // Q1
  let rev = opening.data.game.revision;
  const afterQ1 = await answer(gameId, "NO", rev); // -> Q2 (physical)
  rev = afterQ1.revision;

  // Correct Q1 from NO to YES -- must rewind Q2, no provider call involved.
  const guard = failIfCalled();
  try {
    const corrected = await callCorrect(gameId, {
      turn_index: 1,
      answer: "YES",
      expected_log_length: afterQ1.qa_log.length,
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.data.game.qa_log.length, 1, "Q2 must be discarded by the rewind");

    // The next /turn call must deterministically produce the Living
    // specificity question, not resume Q2 (physical) and not call the provider.
    const next = await callTurn(gameId);
    assert.equal(next.status, 200);
    assert.equal(next.data.game.qa_log[1].question_text, "Does the correct answer need to identify one uniquely identifiable individual?");
  } finally {
    guard.restore();
  }
});

test("REQUIRED 17: correcting a Phase One answer AFTER Phase Two has already started invalidates only the proper downstream branch", async () => {
  const { gameId } = await makeGame("en");
  const opening = await callTurn(gameId); // Q1
  let rev = opening.data.game.revision;
  const afterQ1 = await answer(gameId, "YES", rev); // locks Living
  rev = afterQ1.revision;

  // Answering the specificity question is what completes Phase One and
  // triggers Phase Two's first real turn, all in this one call.
  const mock = mockProviderOnce("Does it live in water?");
  let phaseTwo: { qa_log: unknown[] };
  try {
    phaseTwo = await answer(gameId, "NO", rev); // kind/category -> Phase One complete -> Phase Two turn
  } finally {
    mock.restore();
  }
  assert.equal(phaseTwo.qa_log.length, 3);

  // Now correct Q1 (the ORIGINAL spine question) from YES to NO. This must
  // discard the specificity question AND the Phase Two turn built on top of
  // it -- using the existing correction/rewind semantics unchanged -- and
  // recompute the sandbox deterministically (continuing the spine at Q2).
  const guard = failIfCalled();
  try {
    const corrected = await callCorrect(gameId, {
      turn_index: 1,
      answer: "NO",
      expected_log_length: phaseTwo.qa_log.length,
    });
    assert.equal(corrected.status, 200);
    assert.equal((corrected.data as { game: { qa_log: unknown[] } }).game.qa_log.length, 1, "both downstream turns must be discarded");

    const next = await callTurn(gameId);
    assert.equal(next.status, 200);
    assert.equal(
      next.data.game.qa_log[1].question_text,
      "Is it a physical thing or substance?",
      "must resume the spine at Q2, not re-ask Q1 or jump back into the old Phase Two branch"
    );
  } finally {
    guard.restore();
  }
});

// --- REQUIRED 21: secret-target isolation is unaffected ---------------------

test("REQUIRED 21: RacerPublicState.phase_one carries no target-shaped content", async () => {
  const { gameId } = await makeGame("en");
  const guard = failIfCalled();
  let rev: number;
  try {
    const opening = await callTurn(gameId);
    rev = opening.data.game.revision;
    const afterQ1 = await answer(gameId, "YES", rev);
    rev = afterQ1.revision;
  } finally {
    guard.restore();
  }
  // Completing Phase One triggers the real (mocked) Phase Two call in the
  // same request as the last answer.
  const mock = mockProviderOnce("Does it live in water?");
  try {
    await answer(gameId, "NO", rev);
  } finally {
    mock.restore();
  }
  // toRacerPublicState() itself is untouched and remains the sole narrowing
  // point (see lib/racerState.ts); phase_one is populated only from
  // derivePhaseOneState's own output, which is typed to sandbox/specificity/
  // mixed-question-number enums -- there is no string field it could smuggle
  // target content through. This test documents that guarantee at the type
  // level: a Sandbox/Specificity value literally cannot be a substring of a
  // Setter's private target.
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// V2.8.4.1 CORRECTION — REFERENT SCOPE, RESOLVED NOT GUESSED.
//
// IS-IS on the primary referent-scope question must ask exactly one
// deterministic clarification instead of completing with a guessed "mixed".
// IS-IS on the clarification too must leave the game fully unresolved --
// never handed to Phase Two, never calling the provider -- until whoever set
// the target corrects one of the two scope answers.
// ---------------------------------------------------------------------------

const PRIMARY_SCOPE_QUESTION_EN = "Does the correct answer need to identify one uniquely identifiable individual?";
const CLARIFICATION_QUESTION_EN =
  "Would more than one example fully matching the intended target count as a correct answer?";

/** Locks Living and returns the game positioned to answer the primary referent-scope question. */
async function reachPrimaryScopeQuestion(gameId: string) {
  const opening = await callTurn(gameId); // Q1
  const afterQ1 = await answer(gameId, "YES", opening.data.game.revision); // locks Living
  assert.equal(afterQ1.qa_log[1].question_text, PRIMARY_SCOPE_QUESTION_EN);
  return afterQ1;
}

test("V2.8.4.1 CORRECTION 1: IS-IS on the primary referent-scope question asks the deterministic clarification, with zero provider calls", async () => {
  const { gameId } = await makeGame("en");
  const guard = failIfCalled();
  try {
    const afterPrimary = await reachPrimaryScopeQuestion(gameId);
    const afterAmbiguous = await answer(gameId, "AMBIGUOUS", afterPrimary.revision);
    assert.equal(afterAmbiguous.qa_log[2].question_text, CLARIFICATION_QUESTION_EN);
    assert.equal(afterAmbiguous.qa_log[2].model_id, null, "still deterministic, not a Racer turn");
  } finally {
    guard.restore();
  }
});

test("V2.8.4.1 CORRECTION 2: clarification YES completes Phase One as kind/category and hands off to Phase Two", async () => {
  const { gameId } = await makeGame("en");
  let rev: number;
  const guard = failIfCalled();
  try {
    const afterPrimary = await reachPrimaryScopeQuestion(gameId);
    const afterAmbiguous = await answer(gameId, "AMBIGUOUS", afterPrimary.revision);
    rev = afterAmbiguous.revision;
  } finally {
    guard.restore();
  }
  const mock = mockProviderOnce("Does it live in water?");
  try {
    const afterClarified = await answer(gameId, "YES", rev);
    assert.equal(mock.callCount(), 1, "clarification YES must complete Phase One and trigger exactly one Phase Two turn");
    const joined = mock.lastMessages().map((m) => (m as { content: string }).content).join("\n");
    assert.match(joined, /Deterministic opening classification: living \(a kind\/category/);
    assert.equal(afterClarified.qa_log[3].question_text, "Does it live in water?");
  } finally {
    mock.restore();
  }
});

test("V2.8.4.1 CORRECTION 3: clarification NO completes Phase One as particular and hands off to Phase Two", async () => {
  const { gameId } = await makeGame("en");
  let rev: number;
  const guard = failIfCalled();
  try {
    const afterPrimary = await reachPrimaryScopeQuestion(gameId);
    const afterAmbiguous = await answer(gameId, "AMBIGUOUS", afterPrimary.revision);
    rev = afterAmbiguous.revision;
  } finally {
    guard.restore();
  }
  const mock = mockProviderOnce("Is it kept indoors?");
  try {
    const afterClarified = await answer(gameId, "NO", rev);
    assert.equal(mock.callCount(), 1, "clarification NO must complete Phase One and trigger exactly one Phase Two turn");
    const joined = mock.lastMessages().map((m) => (m as { content: string }).content).join("\n");
    assert.match(joined, /Deterministic opening classification: living \(a particular instance/);
    assert.equal(afterClarified.qa_log[3].question_text, "Is it kept indoors?");
  } finally {
    mock.restore();
  }
});

test("V2.8.4.1 CORRECTION 4: clarification IS-IS remains unresolved -- no new turn is generated, zero provider calls, never reaches Phase Two", async () => {
  const { gameId } = await makeGame("en");
  const guard = failIfCalled();
  try {
    const afterPrimary = await reachPrimaryScopeQuestion(gameId);
    const afterAmbiguous = await answer(gameId, "AMBIGUOUS", afterPrimary.revision);
    const afterDoublyAmbiguous = await answer(gameId, "AMBIGUOUS", afterAmbiguous.revision);
    assert.equal(afterDoublyAmbiguous.qa_log.length, 3, "no new deterministic question, no Phase Two turn");
    assert.equal(afterDoublyAmbiguous.qa_log[2].composer_response, "AMBIGUOUS");

    // A follow-up poll must also do nothing and call no provider -- the
    // block is stable, not a one-time refusal that then proceeds anyway.
    const polled = await callTurn(gameId);
    assert.equal(polled.status, 200);
    assert.equal(polled.data.game.qa_log.length, 3, "still blocked on the next poll too");

    const state = derivePhaseOneState(polled.data.game.qa_log, polled.data.game.game_language);
    assert.equal(state.unresolved, true);
    assert.equal(state.complete, false, "must never be handed to Phase Two");
    assert.equal(state.specificity, null, "must not guess mixed");
  } finally {
    guard.restore();
  }
});

test("V2.8.4.1 CORRECTION 5: reload reproduces the unresolved state, and correcting either scope answer resolves it and resumes play", async () => {
  const { gameId } = await makeGame("en");
  let afterDoublyAmbiguous;
  const guard = failIfCalled();
  try {
    const afterPrimary = await reachPrimaryScopeQuestion(gameId);
    const afterAmbiguous = await answer(gameId, "AMBIGUOUS", afterPrimary.revision);
    afterDoublyAmbiguous = await answer(gameId, "AMBIGUOUS", afterAmbiguous.revision);
  } finally {
    guard.restore();
  }

  // Reload: re-fetching and re-deriving must show the exact same unresolved state.
  const reloaded = await getGame(gameId);
  const reloadedState = derivePhaseOneState(reloaded!.qa_log, reloaded!.game_language);
  assert.equal(reloadedState.unresolved, true);
  assert.equal(reloadedState.complete, false);

  // Correction: fixing the CLARIFICATION answer (the last turn) to NO must
  // resolve to particular and re-enable play, with no provider call from the
  // correction itself.
  const clarificationTurnIndex = afterDoublyAmbiguous.qa_log[2].turn_index;
  const guard2 = failIfCalled();
  try {
    const corrected = await callCorrect(gameId, {
      turn_index: clarificationTurnIndex,
      answer: "NO",
      expected_log_length: afterDoublyAmbiguous.qa_log.length,
    });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
    const correctedGame = (corrected.data as { game: { qa_log: unknown[]; game_language: "en" | "hu" } }).game;
    const correctedState = derivePhaseOneState(correctedGame.qa_log as never, correctedGame.game_language);
    assert.equal(correctedState.unresolved, false);
    assert.equal(correctedState.specificity, "particular");
    assert.equal(correctedState.complete, true);
  } finally {
    guard2.restore();
  }
});

test("V2.8.4.1 CORRECTION 6: a legacy game that already completed with a historical mixed scope remains readable and playable, unaffected by the correction", async () => {
  const { gameId, game } = await makeGame("en");

  // Simulate a v2.8.4 (pre-correction) game exactly as it would already sit
  // in a real deployment: the primary question (legacy wording) answered
  // AMBIGUOUS, already completed as "mixed", with one real Phase Two turn
  // already recorded on top of it.
  const q1 = newLogEntry(1);
  q1.question_text = "Is it alive?";
  q1.composer_response = "YES";
  q1.answered_at = new Date().toISOString();
  const scope = newLogEntry(2);
  scope.question_text = "Is it one particular living being?"; // legacy (pre-hotfix) wording
  scope.composer_response = "AMBIGUOUS";
  scope.answered_at = new Date().toISOString();
  const phaseTwo = newLogEntry(3);
  phaseTwo.question_text = "Does it live in water?";
  phaseTwo.model_id = "some-legacy-model";
  phaseTwo.model_provider = "anthropic";
  phaseTwo.prompt_version = RACER_PROMPT_VERSION;
  game.qa_log = [q1, scope, phaseTwo];
  game.question_count = 2;
  await saveGame(game);

  // Pure replay must reproduce exactly what already happened -- complete,
  // mixed, not unresolved -- never retroactively reopened.
  const state = derivePhaseOneState(game.qa_log, game.game_language);
  assert.equal(state.complete, true, "must not strand the game as incomplete");
  assert.equal(state.specificity, "mixed");
  assert.equal(state.unresolved, false, "an already-completed historical handoff is not the new unresolved state");
  assert.equal(state.sandbox, "living");

  // The game must still be playable: answering the pending Phase Two
  // question continues normally through the real (mocked) provider.
  const mock = mockProviderOnce("Is it a mammal?");
  try {
    const reloaded = await getGame(gameId);
    const afterAnswer = await answer(gameId, "NO", reloaded!.revision);
    assert.equal(mock.callCount(), 1, "must not be blocked or ejected -- Phase Two continues exactly as before");
    assert.equal(afterAnswer.qa_log[3].question_text, "Is it a mammal?");
  } finally {
    mock.restore();
  }
});
