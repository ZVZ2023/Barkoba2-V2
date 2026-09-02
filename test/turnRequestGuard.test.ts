import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createRequestOwnership,
  mergeViewIntoGame,
  reconciliationShowsProgress,
  runOwnedTurnRequest,
  NETWORK_ERROR_MESSAGE,
  type TurnRequestIO,
  type TurnRequestState,
  type TurnResponseBody,
} from "../lib/turnRequestGuard";
import type { GameView, ViewTurn } from "../lib/gameView";
import type { GameRecord, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// S1 / RB-1 — request ownership + canonical-truth reconciliation.
//
// Pure module, no React, no DOM (this project has no jsdom/testing-library
// dependency) — these tests drive lib/turnRequestGuard.ts directly with mock
// transport (`TurnRequestIO`) and mock state setters (`TurnRequestState`),
// the same way test/duplicateQuestionGuard.test.ts drives
// runWithDuplicateQuestionGuard with a mock producer.
// ---------------------------------------------------------------------------

function entry(o: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(),
    turn_index: 1,
    turn_type: "question",
    racer_output_raw: "",
    question_text: null,
    guess_text: null,
    composer_response: null,
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

function viewTurn(o: Partial<ViewTurn> = {}): ViewTurn {
  return {
    turn_index: 1,
    turn_type: "question",
    question_text: null,
    guess_text: null,
    clue_text: null,
    composer_response: null,
    ambiguous_explanation: null,
    ...o,
  };
}

function view(o: Partial<GameView> = {}): GameView {
  return {
    game_id: "g1",
    seat: "composer",
    phase: "questioning",
    awaiting_racer: false,
    game_language: "hu",
    max_questions: 20,
    question_count: 0,
    questions_remaining: 20,
    ambiguous_count: 0,
    turns: [],
    pending_question_index: null,
    your_turn: false,
    final_action: null,
    final_guess_text: null,
    result: null,
    adjudication_notes: null,
    integrity_notes: null,
    revealed_target: null,
    revision: 0,
    ...o,
  };
}

/** A recording TurnRequestState that also lets a test drive it as a mini-store. */
function recordingState(initial: GameRecord) {
  let currentGame = initial;
  const calls: { fn: string; arg?: unknown }[] = [];
  const state: TurnRequestState = {
    getGame: () => currentGame,
    setGame: (g) => {
      currentGame = g;
      calls.push({ fn: "setGame", arg: g });
    },
    setError: (m) => calls.push({ fn: "setError", arg: m }),
    setTurnFailed: (f) => calls.push({ fn: "setTurnFailed", arg: f }),
    setBusy: (b) => calls.push({ fn: "setBusy", arg: b }),
    setAmbiguousMode: (a) => calls.push({ fn: "setAmbiguousMode", arg: a }),
    setExplanation: (e) => calls.push({ fn: "setExplanation", arg: e }),
    clearAutoTurnGuard: () => calls.push({ fn: "clearAutoTurnGuard" }),
  };
  return { state, calls, getCurrentGame: () => currentGame };
}

function lastValueOf(calls: { fn: string; arg?: unknown }[], fn: string): unknown {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i]!.fn === fn) return calls[i]!.arg;
  }
  return undefined;
}

function countCalls(calls: { fn: string; arg?: unknown }[], fn: string): number {
  return calls.filter((c) => c.fn === fn).length;
}

// A controllable promise, so a test can decide exactly when an "in-flight"
// request settles relative to another one.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// TEST A — stale failure after newer success.
// ---------------------------------------------------------------------------

test("A: an older request's rejection cannot restore the error banner over a newer request's success, and issues no extra /turn call", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls, getCurrentGame } = recordingState(g0);

  const older = deferred<never>(); // never resolves successfully; will reject later
  let turnCallCount = 0;
  const olderIo: TurnRequestIO = {
    requestTurn: () => {
      turnCallCount += 1;
      return older.promise as unknown as Promise<{ ok: boolean; data: TurnResponseBody | null }>;
    },
    requestView: async () => {
      throw new Error("must not be called by the older request once superseded");
    },
  };

  // Begin the OLDER request (auto-fired Q1), but do not let it settle yet.
  const olderRun = runOwnedTurnRequest(ownership, olderIo, state);

  // A NEWER request (e.g. a remount / retry) begins and succeeds before the
  // older one settles.
  const newGame = game({ qa_log: [entry({ id: "q1", turn_index: 1, question_text: "Real?" })] });
  const newerIo: TurnRequestIO = {
    requestTurn: async () => {
      turnCallCount += 1;
      return { ok: true, data: { game: newGame } };
    },
    requestView: async () => {
      throw new Error("must not be called on a plain success");
    },
  };
  await runOwnedTurnRequest(ownership, newerIo, state);

  assert.equal(getCurrentGame(), newGame, "the newer game must be showing");
  assert.equal(lastValueOf(calls, "setError"), null, "no error after the newer success");
  assert.equal(lastValueOf(calls, "setTurnFailed"), false);
  assert.equal(lastValueOf(calls, "setBusy"), false);

  // NOW the older request's fetch finally rejects.
  older.reject(new Error("network failure, arriving late"));
  await olderRun;

  assert.equal(getCurrentGame(), newGame, "the newer game must still be showing");
  assert.equal(lastValueOf(calls, "setError"), null, "the stale failure must not restore the error banner");
  assert.equal(lastValueOf(calls, "setTurnFailed"), false, "turnFailed must still reflect the authoritative request");
  assert.equal(lastValueOf(calls, "setBusy"), false);
  assert.equal(turnCallCount, 2, "exactly the two calls this test made — no extra /turn call from the stale one");
});

// ---------------------------------------------------------------------------
// TEST B — server saved Q1 but the client's own response failed.
// ---------------------------------------------------------------------------

test("B: a rejected /turn fetch reconciles through exactly one /view call and applies the saved Q1", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls, getCurrentGame } = recordingState(g0);

  let turnCalls = 0;
  let viewCalls = 0;
  const savedQ1 = viewTurn({ turn_index: 1, question_text: "Valóságos vagy kitalált?" });

  const io: TurnRequestIO = {
    requestTurn: async () => {
      turnCalls += 1;
      throw new Error("network failure — server may have already saved the turn");
    },
    requestView: async () => {
      viewCalls += 1;
      return { ok: true, view: view({ question_count: 0, turns: [savedQ1] }) };
    },
  };

  await runOwnedTurnRequest(ownership, io, state);

  assert.equal(turnCalls, 1);
  assert.equal(viewCalls, 1, "exactly one canonical reconciliation read");
  const g = getCurrentGame();
  assert.equal(g.qa_log.length, 1);
  assert.equal(g.qa_log[0]?.question_text, "Valóságos vagy kitalált?");
  assert.equal(lastValueOf(calls, "setError"), null, "the stale error must be cleared");
  assert.equal(lastValueOf(calls, "setTurnFailed"), false);
  assert.equal(countCalls(calls, "clearAutoTurnGuard"), 0, "no auto-turn suspension on a successful reconciliation");
});

test("B2: a non-JSON / unusable /turn response body (no `game`) reconciles the same way as a rejected fetch", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls, getCurrentGame } = recordingState(g0);

  let viewCalls = 0;
  const io: TurnRequestIO = {
    requestTurn: async () => ({ ok: true, data: {} }), // valid JSON, but no `game` — unusable
    requestView: async () => {
      viewCalls += 1;
      return { ok: true, view: view({ turns: [viewTurn({ turn_index: 1, question_text: "Q1?" })] }) };
    },
  };

  await runOwnedTurnRequest(ownership, io, state);

  assert.equal(viewCalls, 1);
  assert.equal(getCurrentGame().qa_log.length, 1);
  assert.equal(lastValueOf(calls, "setError"), null);
});

// ---------------------------------------------------------------------------
// TEST C — server did not save Q1.
// ---------------------------------------------------------------------------

test("C: a failed /turn followed by an unchanged canonical /view shows the recoverable error and offers explicit retry, with no automatic retry", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls } = recordingState(g0);

  let turnCalls = 0;
  const io: TurnRequestIO = {
    requestTurn: async () => {
      turnCalls += 1;
      throw new Error("network failure");
    },
    requestView: async () => ({ ok: true, view: view() }), // unchanged: no turns, same phase
  };

  await runOwnedTurnRequest(ownership, io, state);

  assert.equal(turnCalls, 1, "no automatic retry — exactly the one /turn attempt this test made");
  assert.equal(lastValueOf(calls, "setError"), NETWORK_ERROR_MESSAGE);
  assert.equal(lastValueOf(calls, "setTurnFailed"), true, "turnFailed must be set so the UI offers the explicit retry control");
  assert.equal(countCalls(calls, "clearAutoTurnGuard"), 1);
});

test("C2: reconciliation itself failing retains the safe explicit-retry state without looping", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls } = recordingState(g0);

  let turnCalls = 0;
  let viewCalls = 0;
  const io: TurnRequestIO = {
    requestTurn: async () => {
      turnCalls += 1;
      throw new Error("network failure");
    },
    requestView: async () => {
      viewCalls += 1;
      throw new Error("the reconciliation read also failed");
    },
  };

  await runOwnedTurnRequest(ownership, io, state);

  assert.equal(turnCalls, 1);
  assert.equal(viewCalls, 1, "reconciliation is attempted exactly once, even though it fails");
  assert.equal(lastValueOf(calls, "setError"), NETWORK_ERROR_MESSAGE);
  assert.equal(lastValueOf(calls, "setTurnFailed"), true);
});

// ---------------------------------------------------------------------------
// TEST D — superseded callback safety (success, catch, AND finally).
// ---------------------------------------------------------------------------

test("D: a superseded request's SUCCESS callback cannot overwrite a newer request's state", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls, getCurrentGame } = recordingState(g0);

  const olderTurn = deferred<{ ok: boolean; data: TurnResponseBody }>();
  const olderIo: TurnRequestIO = {
    requestTurn: () => olderTurn.promise,
    requestView: async () => {
      throw new Error("must not run — this call succeeds, it never reconciles");
    },
  };
  const olderRun = runOwnedTurnRequest(ownership, olderIo, state);

  const newerGame = game({ phase: "resolving" });
  const newerIo: TurnRequestIO = {
    requestTurn: async () => ({ ok: true, data: { game: newerGame } }),
    requestView: async () => {
      throw new Error("must not run");
    },
  };
  await runOwnedTurnRequest(ownership, newerIo, state);
  const busyCallsBeforeLateSuccess = countCalls(calls, "setBusy");

  // The OLDER request's fetch finally resolves SUCCESSFULLY, late, with its
  // own (now-superseded) game state.
  const staleGame = game({ qa_log: [entry({ id: "stale", question_text: "Stale question?" })] });
  olderTurn.resolve({ ok: true, data: { game: staleGame } });
  await olderRun;

  assert.equal(getCurrentGame(), newerGame, "the stale success must not replace the newer game");
  assert.equal(
    countCalls(calls, "setBusy"),
    busyCallsBeforeLateSuccess,
    "a superseded request's finally-equivalent must not fire setBusy again"
  );
});

test("D2: a superseded request's CATCH (failure) callback cannot trigger reconciliation or mutate state", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls, getCurrentGame } = recordingState(g0);

  const olderTurn = deferred<never>();
  let olderViewCalled = false;
  const olderIo: TurnRequestIO = {
    requestTurn: () => olderTurn.promise as unknown as Promise<{ ok: boolean; data: TurnResponseBody | null }>,
    requestView: async () => {
      olderViewCalled = true;
      return { ok: true, view: view() };
    },
  };
  const olderRun = runOwnedTurnRequest(ownership, olderIo, state);

  const newerGame = game({ qa_log: [entry({ id: "fresh", question_text: "Fresh Q1?" })] });
  await runOwnedTurnRequest(ownership, { requestTurn: async () => ({ ok: true, data: { game: newerGame } }), requestView: async () => { throw new Error("unused"); } }, state);

  olderTurn.reject(new Error("late network failure"));
  await olderRun;

  assert.equal(olderViewCalled, false, "a superseded failure must not even attempt reconciliation");
  assert.equal(getCurrentGame(), newerGame);
  assert.equal(lastValueOf(calls, "setError"), null);
  assert.equal(lastValueOf(calls, "setTurnFailed"), false);
});

test("D3: a request superseded WHILE its own reconciliation is in flight cannot apply its result", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls, getCurrentGame } = recordingState(g0);

  const olderView = deferred<{ ok: boolean; view: GameView | null }>();
  const olderIo: TurnRequestIO = {
    requestTurn: async () => {
      throw new Error("transport failure");
    },
    requestView: () => olderView.promise,
  };
  const olderRun = runOwnedTurnRequest(ownership, olderIo, state);
  // Let the older request's microtasks run up to the point where it is
  // awaiting requestView().
  await Promise.resolve();
  await Promise.resolve();

  // A newer request begins and completes WHILE the older one's reconciliation
  // read is still pending.
  const newerGame = game({ qa_log: [entry({ id: "newer", question_text: "Newer Q1?" })] });
  await runOwnedTurnRequest(
    ownership,
    { requestTurn: async () => ({ ok: true, data: { game: newerGame } }), requestView: async () => { throw new Error("unused"); } },
    state
  );

  // NOW the older reconciliation resolves, claiming progress that would
  // otherwise be applied.
  olderView.resolve({ ok: true, view: view({ turns: [viewTurn({ turn_index: 1, question_text: "Stale reconciled Q1?" })] }) });
  await olderRun;

  assert.equal(getCurrentGame(), newerGame, "the superseded reconciliation must not overwrite the newer game");
});

// ---------------------------------------------------------------------------
// Pure helper coverage — mergeViewIntoGame / reconciliationShowsProgress.
// ---------------------------------------------------------------------------

test("mergeViewIntoGame preserves an existing turn's real id and GameRecord-only fields", () => {
  const g = game({
    qa_log: [entry({ id: "real-id-1", turn_index: 1, question_text: "Q1?", model_id: "grok-4.20-0309-reasoning" })],
  });
  const v = view({ turns: [viewTurn({ turn_index: 1, question_text: "Q1?", composer_response: "YES" })] });
  const merged = mergeViewIntoGame(g, v);
  assert.equal(merged.qa_log[0]?.id, "real-id-1");
  assert.equal(merged.qa_log[0]?.model_id, "grok-4.20-0309-reasoning");
  assert.equal(merged.qa_log[0]?.composer_response, "YES");
});

test("mergeViewIntoGame does not touch GameRecord.revision", () => {
  const g = game({ revision: 7 });
  const v = view({ turns: [viewTurn({ turn_index: 1, question_text: "Q1?" })] });
  const merged = mergeViewIntoGame(g, v);
  assert.equal(merged.revision, 7, "the V2.8.1 CAS revision must be left exactly as it was");
});

test("reconciliationShowsProgress: a pending question is progress even with unchanged qa_log length after a resolved earlier turn is replaced", () => {
  const before = game({ qa_log: [] });
  const after = mergeViewIntoGame(before, view({ turns: [viewTurn({ turn_index: 1, question_text: "Q1?" })] }));
  assert.equal(reconciliationShowsProgress(before, after), true);
});

test("reconciliationShowsProgress: no signal at all is not progress", () => {
  const before = game();
  const after = mergeViewIntoGame(before, view());
  assert.equal(reconciliationShowsProgress(before, after), false);
});

test("reconciliationShowsProgress: a pending clue request counts as progress", () => {
  const before = game();
  const after = mergeViewIntoGame(
    before,
    view({ turns: [viewTurn({ turn_index: 1, turn_type: "clue", clue_text: null })] })
  );
  assert.equal(reconciliationShowsProgress(before, after), true);
});

test("reconciliationShowsProgress: an advanced phase alone counts as progress", () => {
  const before = game({ phase: "questioning" });
  const after = mergeViewIntoGame(before, view({ phase: "resolving" }));
  assert.equal(reconciliationShowsProgress(before, after), true);
});
