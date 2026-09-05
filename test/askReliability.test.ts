import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { acquireTurnLock, createGame, getGame, newLogEntry, releaseTurnLock, saveGame } from "../lib/gameStore";
import { POST as askPOST } from "../app/api/game/[id]/ask/route";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();
// callAnthropicTool checks this before ever reaching the (mocked) fetch call
// below — see lib/providers/anthropic.ts's send(). A placeholder value only:
// every actual network call in this file is intercepted by the stubs below.
process.env.ANTHROPIC_API_KEY = "test-key";

// ---------------------------------------------------------------------------
// V2.8.6 R2 — /ask server reliability: per-game turn lock, CAS-bound saves,
// mandatory expected_revision, and the edit_turn_index path's own local
// time-budget gate. Drives the real route handler (app/api/game/[id]/ask/
// route.ts) directly against the real lib/gameStore.ts and the in-memory KV
// fallback — the same technique test/gameplayAuthorization.test.ts and
// test/turnIntegrityHotfix.test.ts already use for /turn and /correct.
//
// NO SECRET IS EVER CREATED HERE. scripts/check-isolation.mjs scans test/
// too, and no test file is on lib/secretStore.ts's importer allowlist — see
// test/integrityReviewReliability.test.ts's own module doc for the same
// constraint on /resolve. The question-answering path (and the
// edit_turn_index path's SECOND call, answerAsComposer) both need a real
// secret record and so are deliberately out of live-execution reach here;
// every test below exercises paths that need no secret at all — concede/
// guess, and the edit_turn_index path up to and including its own new
// local-time gate, which (by design — see the route's own comment on why)
// runs BEFORE the secret lookup. What that gate hands off to afterward
// (getSecretForAnswering, answerAsComposer) is proven separately as a
// SOURCE-orchestration assertion, matching this codebase's established
// pattern for the same constraint.
// ---------------------------------------------------------------------------

const RACER = testPlayerId("d");

async function humanRacerGame(overrides: Partial<Parameters<typeof createGame>[1]> = {}) {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "ai",
    racer_kind: "human",
    max_questions: 20,
    game_language: "en",
    racer_player_id: RACER,
    ...overrides,
  });
  return { gameId, game };
}

/** A game with one already-answered question, seeded directly (no route call, no secret, no model). */
async function humanRacerGameWithAnsweredQuestion() {
  const { gameId, game } = await humanRacerGame();
  const e = newLogEntry(1);
  e.question_text = "Is it alive?";
  e.composer_response = "YES";
  e.answered_at = new Date().toISOString();
  game.qa_log = [e];
  game.question_count = 1;
  await saveGame(game); // blind save — the CAS revision key stays at 0, exactly like a freshly created game
  return { gameId };
}

function req(gameId: string, body: unknown, playerId?: string) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(json));
  } else {
    headers["content-length"] = "0";
  }
  if (playerId) headers["x-bk-player"] = playerId;
  return new NextRequest(`http://localhost/api/game/${gameId}/ask`, {
    method: "POST",
    headers,
    body: json,
  });
}

async function callAsk(gameId: string, body: unknown, playerId?: string) {
  const res = await askPOST(req(gameId, body, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}

function anthropicResponse(input: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: "test-model", content: [{ type: "tool_use", input }] }),
    text: async () => "",
  } as unknown as Response;
}

/** A fixed queue of tool-call results, one per successive Anthropic call. */
function stubAnthropicQueue(inputs: Array<Record<string, unknown>>) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    const idx = calls;
    calls += 1;
    const input = inputs[idx];
    if (!input) throw new Error(`unexpected extra Anthropic call #${idx + 1}`);
    return anthropicResponse(input);
  }) as typeof fetch;
  return {
    callCount: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** The Anthropic call blocks until the test resolves it — for lock/concurrency tests. */
function stubAnthropicControlled() {
  const original = globalThis.fetch;
  let calls = 0;
  let resolveFn: ((v: Response) => void) | null = null;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Promise<Response>((resolve) => {
      resolveFn = resolve;
    });
  }) as typeof fetch;
  return {
    callCount: () => calls,
    resolveNext: (input: Record<string, unknown>) => {
      assert.ok(resolveFn, "no pending Anthropic call to resolve");
      const r = resolveFn!;
      resolveFn = null;
      r(anthropicResponse(input));
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function waitUntil(check: () => boolean, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("waitUntil: condition never became true");
}

const REJECT_VERDICT = { reasoning: "changes what is being asked", same_intent: false };

// ---------------------------------------------------------------------------
// 1. Same-revision duplicate submission — only one mutation/provider call.
// Uses the edit-rejection path: it mutates (edit_status), needs only the
// judge call (no secret), and does not change phase, so a second identical
// submission cleanly exercises the revision check rather than the phase gate.
// ---------------------------------------------------------------------------

test("duplicate submission at the same revision: the second is rejected before touching the model", async () => {
  const { gameId } = await humanRacerGameWithAnsweredQuestion();
  const stub = stubAnthropicQueue([REJECT_VERDICT]);
  try {
    const body = { edit_turn_index: 1, question: "Is it alive??", expected_revision: 0 };
    const first = await callAsk(gameId, body, RACER);
    assert.equal(first.status, 409);
    assert.equal(first.data.error, "edit_changes_intent");
    assert.equal(first.data.game.revision, 1);

    // A retried/duplicate submission of the SAME action against the SAME
    // (now stale) revision — a client-side double-fire or a naive retry.
    const second = await callAsk(gameId, body, RACER);
    assert.equal(second.status, 409);
    assert.equal(second.data.error, "stale_turn");

    assert.equal(stub.callCount(), 1, "the duplicate must never reach the model");
    const canonical = await getGame(gameId);
    assert.equal(canonical!.qa_log[0]!.edit_reason, "changes what is being asked");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. Stale revision — rejected before ever reaching the model, on every
// /ask action shape (the check runs before any branch-specific logic).
// ---------------------------------------------------------------------------

test("stale revision: /ask rejects an explicitly wrong expected_revision without calling the model", async () => {
  const { gameId } = await humanRacerGame();
  const stub = stubAnthropicQueue([]);
  try {
    const res = await callAsk(gameId, { question: "Is it alive?", expected_revision: 99 }, RACER);
    assert.equal(res.status, 409);
    assert.equal(res.data.error, "stale_turn");
    assert.equal(stub.callCount(), 0);
  } finally {
    stub.restore();
  }
});

test("missing expected_revision is a 400, not a silent unsafe mutation", async () => {
  const { gameId } = await humanRacerGame();
  const res = await callAsk(gameId, { concede: true }, RACER);
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "missing_expected_revision");
  const canonical = await getGame(gameId);
  assert.equal(canonical!.phase, "questioning", "nothing was mutated");
});

// ---------------------------------------------------------------------------
// 3. Lock held — a concurrent request is rejected while the first genuinely
// holds the lock, never merely because it lost a sequential race.
// ---------------------------------------------------------------------------

test("lock held: a genuinely concurrent /ask request is rejected with turn_in_progress and no mutation", async () => {
  const { gameId } = await humanRacerGameWithAnsweredQuestion();
  const controlled = stubAnthropicControlled();
  try {
    const pA = callAsk(
      gameId,
      { edit_turn_index: 1, question: "Is it alive??", expected_revision: 0 },
      RACER
    );
    await waitUntil(() => controlled.callCount() === 1);

    // B arrives while A still holds the lock — a concede, chosen so it needs
    // no model call of its own and would be trivially distinguishable from A.
    const resultB = await callAsk(gameId, { concede: true, expected_revision: 0 }, RACER);
    assert.equal(resultB.status, 409, "B must be rejected while A holds the lock");
    assert.equal(resultB.data.error, "turn_in_progress");
    assert.equal(controlled.callCount(), 1, "the losing request must never have reached the model");

    controlled.resolveNext(REJECT_VERDICT);
    const resultA = await pA;
    assert.equal(resultA.status, 409, "A, which legitimately held the lock, completes on its own merits");
    assert.equal(resultA.data.error, "edit_changes_intent");

    const canonical = await getGame(gameId);
    assert.equal(canonical!.phase, "questioning", "B's concede never landed");
  } finally {
    controlled.restore();
  }
});

test("lock held: an externally-held lock (e.g. a concurrent /clue call on the same game) is respected", async () => {
  const { gameId } = await humanRacerGame();
  const held = await acquireTurnLock(gameId, 30);
  assert.equal(held, true);
  try {
    const res = await callAsk(gameId, { concede: true, expected_revision: 0 }, RACER);
    assert.equal(res.status, 409);
    assert.equal(res.data.error, "turn_in_progress");
    const canonical = await getGame(gameId);
    assert.equal(canonical!.phase, "questioning");
  } finally {
    await releaseTurnLock(gameId);
  }
});

// ---------------------------------------------------------------------------
// 4. edit_turn_index — the local time-budget gate.
// ---------------------------------------------------------------------------

test("edit-turn budget gate: the second call is skipped once fewer than 15s of the 60s budget remain, and nothing is saved", async () => {
  const { gameId } = await humanRacerGameWithAnsweredQuestion();
  const before = await getGame(gameId);

  const originalNow = Date.now.bind(Date);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      // V2.8.6 R2 — simulate the FIRST call (judgeQuestionEdit) itself
      // having consumed 46 of the 60-second edit budget by the time it
      // resolves: editDeadlineAt was fixed using the real clock just before
      // this mock installs the shift, so the route's own post-call gate
      // check sees only ~14s remaining — below EDIT_SECOND_CALL_MIN_
      // REMAINING_MS (15s) — without this test actually waiting 46 real
      // seconds.
      const t0 = originalNow();
      Date.now = () => t0 + 46_000;
      return anthropicResponse({ reasoning: "typo fix", same_intent: true });
    }) as typeof fetch;

    const res = await callAsk(
      gameId,
      { edit_turn_index: 1, question: "Is it alive??", expected_revision: 0 },
      RACER
    );

    assert.equal(res.status, 409);
    assert.equal(res.data.error, "budget_exhausted");
    assert.match(res.data.message, /szerkesztés most nem végezhető el/);
    assert.equal(calls, 1, "the second (re-answer) call must never have been placed — the gate fires before the secret lookup that would precede it");

    // No partial mutation: the response's own game is unchanged, AND the
    // canonical store was never written to (no CAS save occurred).
    assert.equal(res.data.game.revision, 0, "revision stayed at its pre-mutation value");
    assert.equal(res.data.game.qa_log[0].edit_status, null);
    assert.equal(res.data.game.qa_log[0].question_text, "Is it alive?");

    const canonical = await getGame(gameId);
    assert.deepEqual(canonical!.qa_log, before!.qa_log, "no partial save reached the store");
    assert.equal(canonical!.revision, 0);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test("edit-turn budget gate: SOURCE — fires before the secret lookup and the second daily-budget reservation, not after", () => {
  // V2.8.6 R2 — the live test above proves the gate blocks the second call
  // and saves nothing; this proves WHY that's possible without a secret:
  // the gate is wired ahead of getSecretForAnswering in source order, not
  // merely by accident of this test's mock timing. Matches the ordering
  // precedent test/integrityReviewReliability.test.ts's own module doc
  // describes for the same secretStore-isolation constraint.
  const src = readFileSync("app/api/game/[id]/ask/route.ts", "utf8");
  const editBranch = src.slice(
    src.indexOf('if (typeof body.edit_turn_index === "number")'),
    src.indexOf("const question = (body.question")
  );
  const gateAt = editBranch.indexOf("decideAttemptBudget(editDeadlineAt");
  const secretAt = editBranch.indexOf("getSecretForAnswering(game.game_id)");
  assert.ok(gateAt >= 0 && secretAt >= 0, "could not locate both the gate call and the secret lookup");
  assert.ok(gateAt < secretAt, "the local time-budget gate must run before the secret lookup it would otherwise waste");
});

test("edit-turn happy path: SOURCE — the accepted edit is applied and CAS-saved only after both calls succeed", () => {
  const src = readFileSync("app/api/game/[id]/ask/route.ts", "utf8");
  const editBranch = src.slice(
    src.indexOf('if (typeof body.edit_turn_index === "number")'),
    src.indexOf("const question = (body.question")
  );
  assert.match(editBranch, /last\.edit_status = "accepted";/);
  const acceptedAt = editBranch.indexOf('last.edit_status = "accepted"');
  const reanswerAt = editBranch.indexOf("await withLocalTimeout(\n          secondCallDecision.allowanceMs");
  const saveAt = editBranch.indexOf("saveGameIfRevisionMatches(game, revisionAtLockTime)", acceptedAt);
  assert.ok(reanswerAt >= 0 && reanswerAt < acceptedAt, "the re-answer call must complete before the entry is mutated");
  assert.ok(saveAt >= 0 && saveAt > acceptedAt, "the CAS save must follow the mutation, not precede it");
});
