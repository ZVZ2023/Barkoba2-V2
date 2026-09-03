import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createGame, getGame } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { POST as correctPOST } from "../app/api/game/[id]/correct/route";
import { anthropicAdapter } from "../lib/providers/anthropic";
import type { ToolCallResult } from "../lib/providers/types";

// ---------------------------------------------------------------------------
// V2.8.1 — the My Car Key integrity hotfix.
//
// These drive the REAL route handlers (app/api/game/[id]/turn/route.ts,
// .../correct/route.ts) directly — no HTTP server, but the actual exported
// POST functions, the actual lib/gameStore.ts, the actual in-memory KV
// fallback (no UPSTASH_* env vars are set in this test run, so
// lib/kv.ts's getKV() uses InMemoryKV — see that file's own comment on why
// that fallback is safe for this: no `await` inside its lock/CAS bodies, so
// two calls issued back-to-back interleave deterministically at real await
// points only, which is what makes the concurrency test below reproducible
// without real timing).
//
// Only the Racer LLM call itself is mocked (anthropicAdapter.callTool, since
// DEFAULT_RACER_PROVIDER is "anthropic" and these fixtures leave
// racer_provider unset) — everything else in the request path is real.
// ---------------------------------------------------------------------------

async function makeGame(overrides: Partial<Parameters<typeof createGame>[1]> = {}) {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: "en",
    ...overrides,
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

function correctRequest(gameId: string, body: Record<string, unknown>) {
  const json = JSON.stringify(body);
  return new NextRequest(`http://localhost/api/game/${gameId}/correct`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)) },
    body: json,
  });
}

async function callTurn(gameId: string, body?: Record<string, unknown>) {
  const res = await turnPOST(turnRequest(gameId, body), { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

async function callCorrect(gameId: string, body: Record<string, unknown>) {
  const res = await correctPOST(correctRequest(gameId, body), { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

/** Stub the Racer to return one fixed question per call, in order. Restores on cleanup. */
function stubRacerQuestions(questions: string[]): { callCount: () => number; restore: () => void } {
  const original = anthropicAdapter.callTool;
  let calls = 0;
  anthropicAdapter.callTool = (async () => {
    const q = questions[calls];
    calls += 1;
    return {
      output: { action: "question", question_text: q ?? `unexpected-call-${calls}`, guess_text: null, rationale: "test" },
      resolvedModel: "stub",
    } as ToolCallResult<unknown>;
  }) as typeof anthropicAdapter.callTool;
  return {
    callCount: () => calls,
    restore: () => {
      anthropicAdapter.callTool = original;
    },
  };
}

/** Stub the Racer with a call the test controls the resolution timing of. */
function stubRacerControlled(): {
  callCount: () => number;
  resolveNext: (questionText: string) => void;
  restore: () => void;
} {
  const original = anthropicAdapter.callTool;
  let calls = 0;
  let resolveFn: ((v: ToolCallResult<unknown>) => void) | null = null;
  anthropicAdapter.callTool = (async () => {
    calls += 1;
    return new Promise<ToolCallResult<unknown>>((resolve) => {
      resolveFn = resolve;
    });
  }) as typeof anthropicAdapter.callTool;
  return {
    callCount: () => calls,
    resolveNext: (questionText: string) => {
      assert.ok(resolveFn, "no pending Racer call to resolve");
      resolveFn!({
        output: { action: "question", question_text: questionText, guess_text: null, rationale: "test" },
        resolvedModel: "stub",
      } as ToolCallResult<unknown>);
      resolveFn = null;
    },
    restore: () => {
      anthropicAdapter.callTool = original;
    },
  };
}

/**
 * Yield to the event loop until `check()` is true, or fail after a bounded
 * number of ticks. Needed because a request that "reached the Racer call" is
 * several real `await` points deep (getGame, acquireTurnLock, a second
 * getGame, consumeModelCall) — even against the in-memory KV, where none of
 * those individually suspend, each `await` still yields one microtask turn,
 * so two requests started back-to-back interleave through those steps rather
 * than one running to completion before the other starts anything. Polling
 * for the actual state we need (rather than assuming a fixed number of
 * ticks) is what makes this deterministic instead of timing-fragile.
 */
/**
 * V2.8.4 — Runtime Phase One v6.1. Every AI-Racer game now opens with up to
 * six deterministic, zero-provider classification turns before the model
 * Racer is ever reached. This file exists to exercise the My Car Key
 * integrity/concurrency machinery against MODEL-DRIVEN turns, so its
 * fixtures answer all five spine questions NO (-> Unclassified, the
 * shortest path to Phase Two, no specificity question) first. Answering the
 * fifth question is itself what completes Phase One and triggers the first
 * real Racer call in that same request — stubbed here with `openingQuestion`
 * — so callers get back exactly the `{ status, data }` shape their old
 * "fresh game -> first racer turn" opener already expected, just reached
 * after Phase One instead of at turn 1.
 */
async function fastForwardPastPhaseOne(gameId: string, openingQuestion: string) {
  let rev: number = (await callTurn(gameId)).data.game.revision; // Q1
  for (let i = 0; i < 4; i += 1) {
    const result = await callTurn(gameId, { answer: "NO", expected_revision: rev });
    assert.equal(result.status, 200, `phase one step ${i + 1} must succeed`);
    rev = result.data.game.revision;
  }
  const opener = stubRacerQuestions([openingQuestion]);
  const opening = await callTurn(gameId, { answer: "NO", expected_revision: rev });
  opener.restore();
  return opening;
}

async function waitUntil(check: () => boolean, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition never became true");
}

// ---------------------------------------------------------------------------
// Golden My Car Key reproduction — the primary PASS test.
// ---------------------------------------------------------------------------

test("GOLDEN: a stale retry can never answer a question it never saw", async () => {
  const { gameId } = await makeGame();
  // Fast-forward through Phase One's five deterministic turns first (its own
  // real transition call stubbed as "Q1?", matching this test's own naming),
  // then the model-driven duplicate/concurrency scenario below is unchanged.
  const opening = await fastForwardPastPhaseOne(gameId, "Q1?");
  assert.equal(opening.status, 200);
  assert.equal((opening.data.game as { qa_log: { question_text: string }[] }).qa_log.at(-1)!.question_text, "Q1?");
  const revisionAtQ1 = opening.data.game.revision;
  const priorLength = (opening.data.game as { qa_log: unknown[] }).qa_log.length;

  const stub = stubRacerQuestions(["Q2?", "SHOULD-NEVER-BE-CALLED"]);
  try {
    // REQUEST A — a real client answers Q1. Server accepts, advances, and
    // generates Q10 (here: Q2). This is the request whose response "never
    // reaches the client" in the incident narrative — but it DID complete
    // and save server-side, which is the whole point.
    const requestA = await callTurn(gameId, { answer: "YES", expected_revision: revisionAtQ1 });
    assert.equal(requestA.status, 200);
    assert.equal(requestA.data.game.qa_log.at(-1).question_text, "Q2?");
    assert.equal(stub.callCount(), 1, "one real Racer call for Q2");
    const revisionAfterA = requestA.data.game.revision;
    assert.notEqual(revisionAfterA, revisionAtQ1, "the revision must have advanced");

    // REQUEST B — the client's stale retry: still believes Q1 is pending
    // (still carries revisionAtQ1), submits another answer intended for Q1.
    const requestB = await callTurn(gameId, { answer: "NO", expected_revision: revisionAtQ1 });

    // EXPECTED FIXED BEHAVIOR:
    assert.equal(requestB.status, 409, "a stale answer must be refused, not accepted");
    assert.equal(requestB.data.error, "stale_turn");
    assert.equal(stub.callCount(), 1, "the stale request must never trigger a Racer call");

    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log.length, priorLength + 1, "no phantom extra entry");
    assert.equal(canonical!.qa_log.at(-1)!.question_text, "Q2?");
    assert.equal(canonical!.qa_log.at(-1)!.composer_response, null, "Q2 must remain unanswered");
    assert.equal(canonical!.qa_log[priorLength - 1]!.composer_response, "YES", "Q1's real answer is untouched");
    assert.equal(requestB.data.game.qa_log.at(-1).question_text, "Q2?", "client reconciles to Q2, the true current question");

    // The player can then answer Q2 normally, using the revision the stale
    // response just reconciled them to.
    const afterReconcile = await callTurn(gameId, {
      answer: "YES",
      expected_revision: requestB.data.game.revision,
    });
    assert.equal(afterReconcile.status, 200);
    assert.equal(stub.callCount(), 2);
  } finally {
    stub.restore();
  }
});

test("a stale retry with a DIFFERENT (wrong) answer still cannot corrupt state", async () => {
  // Same shape as the golden test, but confirms staleness is rejected
  // regardless of what the stale answer actually says (YES vs NO vs
  // AMBIGUOUS) — it's the revision that matters, not the content.
  const { gameId } = await makeGame();
  const stub = stubRacerQuestions(["Q1?", "Q2?"]);
  try {
    const opening = await callTurn(gameId);
    const revisionAtQ1 = opening.data.game.revision;
    await callTurn(gameId, { answer: "YES", expected_revision: revisionAtQ1 });

    const stale = await callTurn(gameId, {
      answer: "AMBIGUOUS",
      ambiguous_explanation: "should never be recorded",
      expected_revision: revisionAtQ1,
    });
    assert.equal(stale.status, 409);

    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log[1]!.ambiguous_explanation, null);
    assert.equal(canonical!.ambiguous_count, 0);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// Concurrency — two requests racing against the SAME pending question.
// ---------------------------------------------------------------------------

test("CONCURRENCY: two near-simultaneous answers to the same question — exactly one wins", async () => {
  const { gameId } = await makeGame();
  const openTurn = await fastForwardPastPhaseOne(gameId, "Q1?");
  const revisionAtQ1 = openTurn.data.game.revision;
  const priorLength = (openTurn.data.game as { qa_log: unknown[] }).qa_log.length;

  const controlled = stubRacerControlled();
  try {
    // Both requests target the SAME starting revision — genuine concurrency,
    // not a sequential stale retry. Start A and let it run all the way to
    // (and past) acquiring the turn lock — confirmed by it reaching the
    // Racer call, several real awaits deep — before B is even issued. This
    // is what makes "A already holds the lock when B arrives" a fact this
    // test establishes, not a timing assumption.
    const pA = callTurn(gameId, { answer: "YES", expected_revision: revisionAtQ1 });
    await waitUntil(() => controlled.callCount() === 1);

    // B arrives while A still holds the lock (A's Racer call is still
    // pending — we haven't resolved it). B must be rejected before ever
    // reaching the Racer itself.
    const resultB = await callTurn(gameId, { answer: "NO", expected_revision: revisionAtQ1 });
    assert.equal(resultB.status, 409, "B must be rejected while A holds the lock");
    assert.equal(resultB.data.error, "turn_in_progress");
    assert.equal(controlled.callCount(), 1, "the losing request must never have reached the Racer");

    // Now let A finish.
    controlled.resolveNext("Q2?");
    const resultA = await pA;
    assert.equal(resultA.status, 200, "A, which legitimately held the lock, succeeds");

    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log.length, priorLength + 1, "the game advanced exactly once");
    assert.equal(canonical!.qa_log[priorLength - 1]!.composer_response, "YES", "only the winner's answer landed");
    assert.equal(resultA.data.game.qa_log.at(-1).question_text, "Q2?");
  } finally {
    controlled.restore();
  }
});

// ---------------------------------------------------------------------------
// Binding is mandatory for ordinary answer submissions.
// ---------------------------------------------------------------------------

test("an answer without expected_revision is refused, not silently accepted", async () => {
  const { gameId } = await makeGame();
  const stub = stubRacerQuestions(["Q1?"]);
  try {
    await callTurn(gameId); // Q1 pending
    const result = await callTurn(gameId, { answer: "YES" }); // no expected_revision
    assert.equal(result.status, 400);
    assert.equal(result.data.error, "missing_expected_revision");
    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log[0]!.composer_response, null, "the unbound answer must not be recorded");
  } finally {
    stub.restore();
  }
});

test("a bare poll for the opening move needs no expected_revision", async () => {
  const { gameId } = await makeGame();
  const result = await callTurn(gameId); // no body at all -- Phase One's Q1, deterministic
  assert.equal(result.status, 200);
  assert.equal(result.data.game.qa_log[0].question_text, "Is it alive?");
});

// ---------------------------------------------------------------------------
// YES / NO / AMBIGUOUS regression — ordinary semantics unchanged.
// ---------------------------------------------------------------------------

test("YES, NO, and AMBIGUOUS (with explanation) all still work through the bound path", async () => {
  const { gameId } = await makeGame();
  const stub = stubRacerQuestions(["Q1?", "Q2?", "Q3?", "Q4?"]);
  try {
    let r = await callTurn(gameId);
    let rev = r.data.game.revision;

    r = await callTurn(gameId, { answer: "YES", expected_revision: rev });
    assert.equal(r.status, 200);
    rev = r.data.game.revision;

    r = await callTurn(gameId, { answer: "NO", expected_revision: rev });
    assert.equal(r.status, 200);
    rev = r.data.game.revision;

    r = await callTurn(gameId, {
      answer: "AMBIGUOUS",
      ambiguous_explanation: "could go either way",
      expected_revision: rev,
    });
    assert.equal(r.status, 200);

    const canonical = await getGame(gameId);
    assert.deepEqual(
      canonical!.qa_log.slice(0, 3).map((e) => e.composer_response),
      ["YES", "NO", "AMBIGUOUS"]
    );
    assert.equal(canonical!.qa_log[2]!.ambiguous_explanation, "could go either way");
    assert.equal(canonical!.ambiguous_count, 1);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// Correction regression — CAS/lock reuse must not change correction
// semantics, must not create a phantom answer, must not consume a guess.
// ---------------------------------------------------------------------------

test("correction still rewinds, still records provenance, still resumes normally afterward", async () => {
  const { gameId } = await makeGame();
  const opening = await fastForwardPastPhaseOne(gameId, "Q1?");
  const priorLength = (opening.data.game as { qa_log: unknown[] }).qa_log.length;
  const stub = stubRacerQuestions(["Q2?"]);
  await callTurn(gameId, { answer: "YES", expected_revision: opening.data.game.revision }); // -> Q2 pending
  stub.restore();

  const beforeCorrection = await getGame(gameId);
  assert.equal(beforeCorrection!.qa_log.length, priorLength + 1);
  const correctedTurnIndex = beforeCorrection!.qa_log[priorLength - 1]!.turn_index;

  const correction = await callCorrect(gameId, {
    turn_index: correctedTurnIndex,
    answer: "NO",
    expected_log_length: beforeCorrection!.qa_log.length,
  });
  assert.equal(correction.status, 200);
  assert.equal(correction.data.game.qa_log.length, priorLength, "Q2 was abandoned, not left dangling");
  assert.equal(correction.data.game.qa_log.at(-1).composer_response, "NO");
  assert.equal(correction.data.game.corrections.length, 1);
  assert.equal(correction.data.game.corrections[0].from, "YES");
  assert.equal(correction.data.game.corrections[0].to, "NO");
  assert.equal(correction.data.game.corrections[0].discarded_turns, 1);
  assert.equal(correction.data.game.phase, "questioning", "game is live again, not stranded");
  assert.equal(correction.data.game.final_action, null, "no phantom guess/concede from a correction");

  // The revision must have advanced too — this is what lets a concurrent or
  // stale /turn request detect that a correction happened.
  assert.notEqual(correction.data.game.revision, beforeCorrection!.revision);

  // The game resumes normally afterward — this is exactly what was missing
  // in the My Car Key incident (the correction succeeded but nothing
  // generated a next question). Confirms the fix doesn't reintroduce that.
  const resumer = stubRacerQuestions(["Q2-retry?"]);
  try {
    const resumed = await callTurn(gameId, { expected_revision: correction.data.game.revision });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.data.game.qa_log.at(-1).question_text, "Q2-retry?");
  } finally {
    resumer.restore();
  }
});

test("correction rejects a stale expected_log_length without mutating anything", async () => {
  const { gameId } = await makeGame();
  const opener = stubRacerQuestions(["Q1?"]);
  await callTurn(gameId);
  opener.restore();

  const before = await getGame(gameId);
  const result = await callCorrect(gameId, {
    turn_index: 1,
    answer: "NO",
    expected_log_length: 999, // obviously stale
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.error, "stale_state");

  const after = await getGame(gameId);
  assert.deepEqual(after, before);
});

test("a correction and a concurrent /turn cannot both mutate the same game", async () => {
  // Closes the gap flagged in the hotfix: /correct now takes the same
  // per-game turn lock /turn does, so the two routes cannot race each other
  // at the storage layer either, not just /turn against itself.
  const { gameId } = await makeGame();
  const openTurn = await fastForwardPastPhaseOne(gameId, "Q1?");
  const rev = openTurn.data.game.revision;

  const controlled = stubRacerControlled();
  try {
    // /turn goes first and holds the lock through its (held-open) Racer
    // call — confirmed by it actually reaching that call — before /correct
    // is even issued.
    const turnPromise = callTurn(gameId, { answer: "YES", expected_revision: rev });
    await waitUntil(() => controlled.callCount() === 1);

    const correctResult = await callCorrect(gameId, {
      turn_index: 1,
      answer: "NO",
      expected_log_length: 1,
    });
    assert.equal(correctResult.status, 409, "the correction must be rejected while /turn holds the lock");
    assert.equal(correctResult.data.error, "turn_in_progress");

    controlled.resolveNext("Q2?");
    const turnResult = await turnPromise;
    assert.equal(turnResult.status, 200);
  } finally {
    controlled.restore();
  }
});
