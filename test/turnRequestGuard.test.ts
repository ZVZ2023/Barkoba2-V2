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
    record_revision: 0,
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
    setTurnInProgress: (p) => calls.push({ fn: "setTurnInProgress", arg: p }),
    registerActiveRequest: (h) => calls.push({ fn: "registerActiveRequest", arg: h }),
    clearActiveRequest: () => calls.push({ fn: "clearActiveRequest" }),
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

test("mergeViewIntoGame applies the REAL GameRecord.revision from view.record_revision (S1 review fix)", () => {
  // Confirmed defect, pre-fix: leaving the client's stale revision in place
  // meant the player's very next answer was rejected as stale_turn on its
  // first submit. See test/staleRevisionReconciliation.test.ts for the
  // full real-server proof.
  const g = game({ revision: 0 });
  const v = view({ record_revision: 1, turns: [viewTurn({ turn_index: 1, question_text: "Q1?" })] });
  const merged = mergeViewIntoGame(g, v);
  assert.equal(merged.revision, 1, "the true server-side revision must be adopted, not the stale client one");
});

test("mergeViewIntoGame never confuses view.revision (the H2H poll marker) with view.record_revision (the real CAS counter)", () => {
  const g = game({ revision: 0 });
  const v = view({ revision: 9999, record_revision: 3, turns: [] });
  const merged = mergeViewIntoGame(g, v);
  assert.equal(merged.revision, 3, "must come from record_revision, never from the derived poll marker");
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

test("reconciliationShowsProgress: an advanced revision alone (no visible qa_log/phase change) counts as progress", () => {
  const before = game({ revision: 1 });
  const after = mergeViewIntoGame(before, view({ record_revision: 2 }));
  assert.equal(reconciliationShowsProgress(before, after), true);
});

// ---------------------------------------------------------------------------
// CONFIRMED-DEFECT FIX — pending-question/pending-clue progress must be
// RELATIVE to `before`, not an absolute fact about `after`. The bug: the
// same still-unanswered question or clue, present in BOTH `before` and
// `after` (the player's answer was lost in transit; nothing on the server
// actually advanced), was reported as "progress" merely because something
// was pending in `after` -- silently clearing the error over a lost answer.
// ---------------------------------------------------------------------------

test("REQUIRED 1: the SAME still-pending question (identical turn_index, unanswered in both, revision/log length/phase/question_count unchanged) is NOT progress", () => {
  const before = game({
    revision: 1,
    question_count: 0,
    phase: "questioning",
    qa_log: [entry({ id: "q1", turn_index: 1, question_text: "Q1?", composer_response: null })],
  });
  const after = mergeViewIntoGame(
    before,
    view({
      record_revision: 1,
      question_count: 0,
      phase: "questioning",
      turns: [viewTurn({ turn_index: 1, question_text: "Q1?", composer_response: null })],
    })
  );
  assert.equal(reconciliationShowsProgress(before, after), false);
});

test("REQUIRED 2: runOwnedTurnRequest — a transport failure followed by /view showing the SAME still-pending question keeps the error visible, sets turnFailed, and does not automatically retry", async () => {
  const ownership = createRequestOwnership();
  const g0 = game({
    revision: 1,
    qa_log: [entry({ id: "q1", turn_index: 1, question_text: "Q1?", composer_response: null })],
  });
  const { state, calls, getCurrentGame } = recordingState(g0);

  let turnCalls = 0;
  const io: TurnRequestIO = {
    requestTurn: async () => {
      turnCalls += 1;
      throw new Error("network failure — the player's YES never reached the server");
    },
    requestView: async () => ({
      ok: true,
      view: view({
        record_revision: 1,
        turns: [viewTurn({ turn_index: 1, question_text: "Q1?", composer_response: null })],
      }),
    }),
  };

  await runOwnedTurnRequest(ownership, io, state);

  assert.equal(turnCalls, 1, "no automatic /turn retry");
  assert.equal(lastValueOf(calls, "setError"), NETWORK_ERROR_MESSAGE, "the network error must remain visible — the answer was lost, not accepted");
  assert.equal(lastValueOf(calls, "setTurnFailed"), true, "the error remains visible, the pending question's controls remain available, and the player can answer again through YES/NO/IS-IS");
  assert.equal(
    getCurrentGame().qa_log[0]?.composer_response,
    null,
    "the answer must not be falsely represented as accepted"
  );
});

test("REQUIRED 3: a NEW pending question (previously none pending) still counts as progress — saved-Q1 recovery keeps working", () => {
  const before = game({ qa_log: [] }); // no pending question at all
  const after = mergeViewIntoGame(before, view({ turns: [viewTurn({ turn_index: 1, question_text: "Q1?" })] }));
  assert.equal(reconciliationShowsProgress(before, after), true);
});

test("REQUIRED 3b: end-to-end — a rejected /turn fetch still reconciles a genuinely NEW saved Q1 (Test B behavior preserved)", async () => {
  const ownership = createRequestOwnership();
  const g0 = game({ qa_log: [] });
  const { state, getCurrentGame } = recordingState(g0);

  const io: TurnRequestIO = {
    requestTurn: async () => {
      throw new Error("network failure");
    },
    requestView: async () => ({
      ok: true,
      view: view({ turns: [viewTurn({ turn_index: 1, question_text: "Newly saved Q1?" })] }),
    }),
  };

  await runOwnedTurnRequest(ownership, io, state);

  assert.equal(getCurrentGame().qa_log.length, 1);
  assert.equal(getCurrentGame().qa_log[0]?.question_text, "Newly saved Q1?");
});

test("REQUIRED 4: the SAME still-pending clue request (identical turn_index, unresolved in both) is NOT progress", () => {
  const before = game({ qa_log: [entry({ id: "clue1", turn_index: 1, turn_type: "clue", clue_text: null })] });
  const after = mergeViewIntoGame(
    before,
    view({ turns: [viewTurn({ turn_index: 1, turn_type: "clue", clue_text: null })] })
  );
  assert.equal(reconciliationShowsProgress(before, after), false);
});

test("REQUIRED 5: a NEWLY pending clue (previously none pending) counts as progress", () => {
  const before = game({ qa_log: [] });
  const after = mergeViewIntoGame(
    before,
    view({ turns: [viewTurn({ turn_index: 1, turn_type: "clue", clue_text: null })] })
  );
  assert.equal(reconciliationShowsProgress(before, after), true);
});

// ---------------------------------------------------------------------------
// V2.8.4.1 — turn_in_progress: the server's turn lock is already held by
// another in-flight request. This must read as "still working," never as a
// gameplay failure needing a manual retry tap.
// ---------------------------------------------------------------------------

test("V2.8.4.1: a turn_in_progress response applies the canonical game, clears any error, and signals turnInProgress -- not a failure", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls, getCurrentGame } = recordingState(g0);

  const canonicalGame = game({
    revision: 1,
    qa_log: [entry({ id: "q1", turn_index: 1, question_text: "Q1?", composer_response: null })],
  });
  const io: TurnRequestIO = {
    requestTurn: async () => ({
      ok: false,
      data: { error: "turn_in_progress", message: "Már folyamatban van egy kör ebben a játékban.", game: canonicalGame },
    }),
    requestView: async () => {
      throw new Error("must not reconcile — the response already carried a usable `game`");
    },
  };

  await runOwnedTurnRequest(ownership, io, state);

  assert.equal(getCurrentGame(), canonicalGame, "the server's own canonical state must be applied");
  assert.equal(lastValueOf(calls, "setError"), null, "turn_in_progress must not show an error banner");
  assert.equal(lastValueOf(calls, "setTurnFailed"), false, "must not require an explicit manual retry");
  assert.equal(lastValueOf(calls, "setTurnInProgress"), true, "the caller must be told to schedule a quiet retry");
  assert.equal(countCalls(calls, "clearAutoTurnGuard"), 0, "turn_in_progress is not the auto-turn-guard failure path");
  assert.equal(lastValueOf(calls, "setBusy"), false, "the in-flight request itself has finished");
});

test("V2.8.4.1: an ordinary success clears turnInProgress (a stale true from a prior attempt must not linger)", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls } = recordingState(g0);

  const newGame = game({ qa_log: [entry({ id: "q1", turn_index: 1, question_text: "Q1?" })] });
  await runOwnedTurnRequest(
    ownership,
    { requestTurn: async () => ({ ok: true, data: { game: newGame } }), requestView: async () => { throw new Error("unused"); } },
    state
  );

  assert.equal(lastValueOf(calls, "setTurnInProgress"), false);
});

// ---------------------------------------------------------------------------
// V2.8.5 ENGINE-CONTRACT CORRECTION (defect 5) — a sandbox_clarification_failed
// response must not fall through to the generic gameplay-failure banner. It
// clears any stale error/turnFailed state and instead signals the caller
// (GameClient.tsx) to show the dedicated, localized restart/reframe panel via
// the optional setSandboxClarificationFailed setter.
// ---------------------------------------------------------------------------

test("V2.8.5: a sandbox_clarification_failed response clears the ordinary error/turnFailed state and signals setSandboxClarificationFailed(true)", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state: baseState, calls, getCurrentGame } = recordingState(g0);
  const sandboxClarificationCalls: boolean[] = [];
  const state: TurnRequestState = {
    ...baseState,
    setSandboxClarificationFailed: (failed) => sandboxClarificationCalls.push(failed),
  };

  const canonicalGame = game({
    qa_log: [entry({ id: "clar1", turn_index: 1, question_text: "Privately, for you only: is more than one major sense essential..." })],
  });
  const io: TurnRequestIO = {
    requestTurn: async () => ({
      ok: false,
      data: {
        error: "sandbox_clarification_failed",
        message: "Nem sikerült egyértelmű célkategóriát megállapítani a megadott válaszokból. Kérlek, kezdj új játékot pontosabban megfogalmazott céllal.",
        game: canonicalGame,
      },
    }),
    requestView: async () => {
      throw new Error("must not reconcile — the response already carried a usable `game`");
    },
  };

  await runOwnedTurnRequest(ownership, io, state);

  assert.equal(getCurrentGame(), canonicalGame, "the server's own canonical (persisted) state must still be applied");
  assert.equal(lastValueOf(calls, "setError"), null, "must not show the generic error banner");
  assert.equal(lastValueOf(calls, "setTurnFailed"), false, "must not offer the generic explicit-retry control");
  assert.deepEqual(sandboxClarificationCalls, [true], "must signal the dedicated restart/reframe panel exactly once");
});

test("V2.8.4.1: a genuine gameplay failure also clears turnInProgress, so the explicit-retry UI is not confused with the quiet-retry state", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls } = recordingState(g0);

  const io: TurnRequestIO = {
    requestTurn: async () => ({ ok: false, data: { error: "provider_error", message: "Valami hiba történt.", game: g0 } }),
    requestView: async () => {
      throw new Error("unused — this is not a transport failure");
    },
  };

  await runOwnedTurnRequest(ownership, io, state);

  assert.equal(lastValueOf(calls, "setTurnFailed"), true);
  assert.equal(lastValueOf(calls, "setTurnInProgress"), false);
});

// ---------------------------------------------------------------------------
// V2.8.5.1 — bounded client request lifecycle. See lib/turnRequestGuard.ts's
// CLIENT_TURN_TIMEOUT_MS doc for the full "silent stall" forensic this
// repairs (game 6c55682c-b60d-414b-8c0c-1b6a1c8248d8, V2.8.5 production): a
// backgrounded mobile fetch that neither resolves nor rejects left `busy`
// stuck true forever. `timeoutMs` is passed as a tiny value in these tests
// so the real timeout mechanism can be exercised without a 300-real-second
// test — see runOwnedTurnRequest's own doc on why a parameter (not a
// mutable shared config, unlike lib/turnBudget.ts's TURN_BUDGET_CONFIG) is
// enough here: nothing here is shared across concurrent requests.
// ---------------------------------------------------------------------------

/** A requestTurn mock that never settles on its own, but rejects (like a real aborted fetch) the moment its signal aborts. */
function hungRequestTurn(): TurnRequestIO["requestTurn"] {
  return (signal: AbortSignal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
}

test("V2.8.5.1 REQUIRED TEST 2: a hung /turn request times out and exposes Retry when canonical state has NOT advanced", async () => {
  const ownership = createRequestOwnership();
  const g0 = game({ qa_log: [entry({ id: "q1", turn_index: 1, question_text: "Q1?", composer_response: null })] });
  const { state, calls } = recordingState(g0);

  let requestTurnCalls = 0;
  let viewCalls = 0;
  const io: TurnRequestIO = {
    requestTurn: (signal) => {
      requestTurnCalls += 1;
      return hungRequestTurn()(signal);
    },
    requestView: async () => {
      viewCalls += 1;
      // Unchanged from `before` -- the same still-pending Q1, nothing advanced.
      return { ok: true, view: view({ turns: [viewTurn({ turn_index: 1, question_text: "Q1?", composer_response: null })] }) };
    },
  };

  await runOwnedTurnRequest(ownership, io, state, 10);

  assert.equal(requestTurnCalls, 1, "exactly one /turn attempt — the timeout must never retry it itself");
  assert.equal(viewCalls, 1, "exactly one canonical reconciliation read after the timeout fires");
  assert.equal(lastValueOf(calls, "setError"), NETWORK_ERROR_MESSAGE);
  assert.equal(lastValueOf(calls, "setTurnFailed"), true, "Retry must become available");
  assert.equal(lastValueOf(calls, "setBusy"), false, "busy must not stay stuck true — the exact 'silent stall' symptom");
});

test("V2.8.5.1 REQUIRED TEST 3: a hung /turn request that times out reconciles successfully when canonical state HAS advanced", async () => {
  const ownership = createRequestOwnership();
  const g0 = game({ qa_log: [] });
  const { state, calls, getCurrentGame } = recordingState(g0);

  const io: TurnRequestIO = {
    requestTurn: hungRequestTurn(),
    requestView: async () => ({
      ok: true,
      view: view({ turns: [viewTurn({ turn_index: 1, question_text: "The server already saved this Q1 before the client gave up." })] }),
    }),
  };

  await runOwnedTurnRequest(ownership, io, state, 10);

  assert.equal(getCurrentGame().qa_log.length, 1);
  assert.equal(getCurrentGame().qa_log[0]?.question_text, "The server already saved this Q1 before the client gave up.");
  assert.equal(lastValueOf(calls, "setError"), null);
  assert.equal(lastValueOf(calls, "setTurnFailed"), false);
  assert.equal(lastValueOf(calls, "setBusy"), false);
});

test("V2.8.5.1 REQUIRED TEST 7: a late-settling (superseded) request cannot overwrite newer reconciled state, nor clobber the newer request's active-handle registration", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state, calls, getCurrentGame } = recordingState(g0);

  const olderTurn = deferred<{ ok: boolean; data: TurnResponseBody }>();
  const olderIo: TurnRequestIO = {
    requestTurn: () => olderTurn.promise as unknown as Promise<{ ok: boolean; data: TurnResponseBody | null }>,
    requestView: async () => {
      throw new Error("must not be called — the older request settles directly (success), never reaching transport failure");
    },
  };
  const olderRun = runOwnedTurnRequest(ownership, olderIo, state, 100_000);

  // Let the older request's synchronous setup (registerActiveRequest) run.
  await Promise.resolve();
  assert.equal(countCalls(calls, "registerActiveRequest"), 1);

  const newerGame = game({ qa_log: [entry({ id: "newer", question_text: "Newer Q1?" })] });
  const newerIo: TurnRequestIO = {
    requestTurn: async () => ({ ok: true, data: { game: newerGame } }),
    requestView: async () => {
      throw new Error("unused");
    },
  };
  await runOwnedTurnRequest(ownership, newerIo, state, 100_000);
  assert.equal(countCalls(calls, "registerActiveRequest"), 2, "the newer request must also register its own handle");
  assert.equal(getCurrentGame(), newerGame);

  // NOW the older request finally settles, late, with its own stale success.
  const staleGame = game({ qa_log: [entry({ id: "stale", question_text: "Stale question?" })] });
  olderTurn.resolve({ ok: true, data: { game: staleGame } });
  await olderRun;

  assert.equal(getCurrentGame(), newerGame, "the stale late success must not overwrite the newer reconciled game");
  // The specific regression this test exists for: the OLDER (superseded)
  // request's own cleanup must not clear the ACTIVE-REQUEST HANDLE the
  // newer, still-current request holds — which would silently disable
  // stale-foreground-abort recovery for a request that is genuinely still
  // running.
  assert.equal(
    countCalls(calls, "clearActiveRequest"),
    1,
    "only the still-current (newer) request's own settlement may clear the active-request handle"
  );
});

test("V2.8.5.1 REQUIRED TEST 8: recovery through a timeout never issues a second POST /turn, and the server's model-call budget is therefore never double-spent by the client's own recovery path", async () => {
  const ownership = createRequestOwnership();
  const g0 = game();
  const { state } = recordingState(g0);

  let requestTurnCalls = 0;
  let requestViewCalls = 0;
  const io: TurnRequestIO = {
    requestTurn: (signal) => {
      requestTurnCalls += 1;
      return hungRequestTurn()(signal);
    },
    requestView: async () => {
      requestViewCalls += 1;
      return { ok: true, view: view() }; // no progress
    },
  };

  await runOwnedTurnRequest(ownership, io, state, 10);

  assert.equal(requestTurnCalls, 1, "the client's own timeout-driven recovery must never call POST /turn a second time");
  assert.equal(requestViewCalls, 1, "reconciliation is a single GET /view, never a retried POST");
});
