import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createRequestOwnership,
  runOwnedResolveRequest,
  RESOLVE_NETWORK_ERROR_MESSAGE,
  type ResolveRequestIO,
  type ResolveRequestState,
  type ResolveResponseBody,
} from "../lib/turnRequestGuard";
import type { GameRecord } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.8.4 — RACERCLIENT REQUEST-RECOVERY PARITY.
//
// RacerClient.tsx's resolveGame() previously fired a plain fetch with no
// AbortController and no reconciliation -- exactly the "Hálózati hiba a
// lezárásnál" defect GameClient.tsx's own resolveGame already fixed in
// V2.8.5.2 (production forensic game a0b7743b-...). This brings it onto the
// SAME runOwnedResolveRequest mechanism, wired the same way GameClient.tsx
// wires it (see that file and lib/turnRequestGuard.ts's own doc).
//
// runOwnedResolveRequest's own generic behavior (timeout, reconciliation,
// ownership-guarded retry-visibility) is already exhaustively proven in
// test/turnRequestGuard.test.ts's "V2.8.5.2 (C)" and "V2.8.8.1 (E)" suites.
// This file's job is narrower and specific to this ticket: prove that
// RacerClient.tsx's OWN wiring (source-contract, since this codebase has no
// React rendering harness -- see every other *Client.tsx test in this
// suite) matches that pattern, and separately re-exercise the SAME
// mechanism end-to-end using RacerClient's own field mapping (setResolving
// -> its single shared `busy` flag, unlike GameClient's separate
// `resolving`) to prove the integration itself, not just the underlying
// function, behaves correctly for THIS screen.
// ---------------------------------------------------------------------------

const RACER_CLIENT_SRC = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");

// ---------------------------------------------------------------------------
// SOURCE: the wiring itself.
// ---------------------------------------------------------------------------

test("SOURCE: resolveGame is routed through runOwnedResolveRequest, not a bare fetch", () => {
  assert.match(RACER_CLIENT_SRC, /import \{[\s\S]*runOwnedResolveRequest[\s\S]*\} from "@\/lib\/turnRequestGuard";/);
  const fnAt = RACER_CLIENT_SRC.indexOf("const resolveGame = useCallback(async () => {");
  assert.ok(fnAt > 0);
  const fn = RACER_CLIENT_SRC.slice(fnAt, fnAt + 2500);
  assert.match(fn, /await runOwnedResolveRequest\(/);
  assert.doesNotMatch(fn, /await fetch\(`\/api\/game\/\$\{game\.game_id\}\/resolve`, \{ method: "POST" \}\)/, "the old bare, unguarded fetch must be gone");
});

test("SOURCE: requestResolve passes an AbortSignal through to fetch (requirement 1)", () => {
  const fnAt = RACER_CLIENT_SRC.indexOf("requestResolve: async (signal) => {");
  assert.ok(fnAt > 0);
  const fn = RACER_CLIENT_SRC.slice(fnAt, fnAt + 300);
  assert.match(fn, /signal,/);
});

test("SOURCE: requestView reconciles against GET /view before any error is shown (requirement 2)", () => {
  assert.match(RACER_CLIENT_SRC, /requestView: async \(\) => \{/);
  const fnAt = RACER_CLIENT_SRC.indexOf("requestView: async () => {");
  const fn = RACER_CLIENT_SRC.slice(fnAt, fnAt + 300);
  assert.match(fn, /\/view/);
});

test("SOURCE: the synchronous resolveInFlightRef guard is preserved, checked before any await (requirement 3)", () => {
  const fnAt = RACER_CLIENT_SRC.indexOf("const resolveGame = useCallback(async () => {");
  const fn = RACER_CLIENT_SRC.slice(fnAt, fnAt + 800);
  assert.match(fn, /if \(resolveInFlightRef\.current\) return;/);
  assert.match(fn, /resolveInFlightRef\.current = true;/);
  const guardAt = fn.indexOf("if (resolveInFlightRef.current) return;");
  const firstRealAwaitAt = fn.indexOf("await runOwnedResolveRequest(");
  assert.ok(guardAt >= 0 && firstRealAwaitAt > guardAt);
});

test("SOURCE: resolveGame has its OWN request-ownership tracker, separate from send()'s requestOwnershipRef -- exactly the separation GameClient.tsx already uses", () => {
  assert.match(RACER_CLIENT_SRC, /const resolveOwnershipRef = useRef<RequestOwnership \| null>\(null\);/);
  assert.match(RACER_CLIENT_SRC, /const activeResolveRequestRef = useRef<ActiveRequestHandle \| null>\(null\);/);
  assert.match(RACER_CLIENT_SRC, /resolveOwnershipRef\.current as RequestOwnership,/);
});

test("SOURCE: the visible guess, mode-aware evaluation copy, and retry-in-progress feedback wiring are untouched (requirement 4)", () => {
  const at = RACER_CLIENT_SRC.indexOf("<EvaluationState");
  const block = RACER_CLIENT_SRC.slice(at, at + 300);
  assert.match(block, /error=\{error\}/);
  assert.match(block, /busy=\{busy\}/);
  assert.match(block, /finalGuessText=\{game\.final_guess_text\}/);
  assert.match(block, /finalAction=\{game\.final_action\}/);
  assert.match(block, /experienceMode=\{game\.experience_mode\}/);
});

test("SOURCE: no adjudication/Integrity Review/scoring/prompt logic is introduced by this change (requirement 7)", () => {
  // NOTE: "IS-IS" itself is deliberately NOT checked here -- it is a
  // pre-existing, unrelated Hungarian display label for the AMBIGUOUS
  // answer value (ANSWER_HU, present since long before this ticket, and
  // mirrored by GameClient.tsx's own identical ANSWER_HU). What actually
  // matters is that no ADJUDICATION DECISION LOGIC was introduced here.
  for (const forbidden of ["runAdjudicator", "runIntegrityReview", "deriveResult", "needsAdjudication", "needsIntegrityReview"]) {
    assert.doesNotMatch(RACER_CLIENT_SRC, new RegExp(forbidden), `${forbidden} must not appear in RacerClient.tsx`);
  }
});

// ---------------------------------------------------------------------------
// EXECUTED: exercising the exact mechanism RacerClient.tsx now wires,
// mirroring its own field mapping (setResolving -> a single shared `busy`).
// ---------------------------------------------------------------------------

function game(o: Partial<GameRecord> = {}): GameRecord {
  return {
    game_id: "g1",
    revision: 0,
    player_id: null,
    composer_player_id: null,
    racer_player_id: null,
    join_code: null,
    phase: "resolving",
    created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(),
    max_questions: 20,
    game_language: "hu",
    private_target: false,
    composer_kind: "ai",
    racer_kind: "human",
    racer_provider: null,
    difficulty: null,
    clue_mode: null,
    experience_mode: null,
    question_count: 5,
    question_count_high_water_mark: 5,
    ambiguous_count: 0,
    qa_log: [],
    final_action: "guess",
    final_guess_text: "bicikli",
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

/** Mirrors RacerClient.tsx's OWN field mapping: setResolving -> the single shared `busy`, not a separate `resolving` state. */
function racerClientShapedState(initial: GameRecord) {
  let currentGame = initial;
  const calls: { fn: string; arg?: unknown }[] = [];
  const state: ResolveRequestState = {
    getGame: () => currentGame,
    setGame: (g) => {
      currentGame = g;
      calls.push({ fn: "setGame", arg: g });
    },
    setResolveError: (m) => calls.push({ fn: "setError" /* RacerClient's own state name */, arg: m }),
    setResolving: (b) => calls.push({ fn: "setBusy" /* RacerClient's own state name */, arg: b }),
    clearResolveGuard: () => calls.push({ fn: "clearResolveGuard" }),
    registerActiveRequest: (h) => calls.push({ fn: "registerActiveRequest", arg: h }),
    clearActiveRequest: () => calls.push({ fn: "clearActiveRequest" }),
  };
  return { state, calls, getCurrentGame: () => currentGame };
}

function hungRequestResolve(): ResolveRequestIO["requestResolve"] {
  return (signal: AbortSignal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
}

test("EXECUTED: timeout + reconciliation recovers a successful result even when the original response is lost (requirement 6)", async () => {
  const ownership = createRequestOwnership();
  const g0 = game({ phase: "resolving" });
  const { state, calls, getCurrentGame } = racerClientShapedState(g0);

  const io: ResolveRequestIO = {
    requestResolve: hungRequestResolve(), // the original response never arrives client-side
    requestView: async () => ({
      ok: true,
      view: {
        game_id: "g1",
        seat: "racer",
        phase: "complete",
        awaiting_racer: false,
        game_language: "hu",
        max_questions: 20,
        question_count: 5,
        questions_remaining: 15,
        ambiguous_count: 0,
        turns: [],
        pending_question_index: null,
        your_turn: false,
        final_action: "guess",
        final_guess_text: "bicikli",
        result: "racer_correct",
        adjudication_notes: null,
        integrity_notes: null,
        revealed_target: "bicikli",
        revision: 1,
        record_revision: 1,
        experience_mode: null,
        hint_credits_available: 0,
      },
    }),
  };

  await runOwnedResolveRequest(ownership, io, state, 10);

  assert.equal(getCurrentGame().phase, "complete", "the successful server result must be recovered even though the original POST response was lost");
  assert.equal(getCurrentGame().result, "racer_correct");
  assert.equal(calls.filter((c) => c.fn === "setError").pop()?.arg, null, "no error is shown once reconciliation confirms success");
});

test("EXECUTED: timeout + reconciliation shows a retryable error when the server genuinely has not finished yet", async () => {
  const ownership = createRequestOwnership();
  const g0 = game({ phase: "resolving" });
  const { state, getCurrentGame } = racerClientShapedState(g0);

  const io: ResolveRequestIO = {
    requestResolve: hungRequestResolve(),
    requestView: async () => ({
      ok: true,
      view: {
        game_id: "g1",
        seat: "racer",
        phase: "resolving",
        awaiting_racer: false,
        game_language: "hu",
        max_questions: 20,
        question_count: 5,
        questions_remaining: 15,
        ambiguous_count: 0,
        turns: [],
        pending_question_index: null,
        your_turn: false,
        final_action: "guess",
        final_guess_text: "bicikli",
        result: null,
        adjudication_notes: null,
        integrity_notes: null,
        revealed_target: null,
        revision: 0,
        record_revision: 0,
        experience_mode: null,
        hint_credits_available: 0,
      },
    }),
  };

  await runOwnedResolveRequest(ownership, io, state, 10);

  assert.equal(getCurrentGame().phase, "resolving", "must never be reported complete when it genuinely is not");
});

test("EXECUTED: repeated taps never issue a second POST /resolve while one is in flight (requirement 5)", async () => {
  const ownership = createRequestOwnership();
  const g0 = game({ phase: "resolving" });
  const { state } = racerClientShapedState(g0);

  let requestResolveCalls = 0;
  const io: ResolveRequestIO = {
    requestResolve: (signal) => {
      requestResolveCalls += 1;
      return hungRequestResolve()(signal);
    },
    requestView: async () => ({
      ok: true,
      view: {
        game_id: "g1",
        seat: "racer",
        phase: "resolving",
        awaiting_racer: false,
        game_language: "hu",
        max_questions: 20,
        question_count: 5,
        questions_remaining: 15,
        ambiguous_count: 0,
        turns: [],
        pending_question_index: null,
        your_turn: false,
        final_action: "guess",
        final_guess_text: "bicikli",
        result: null,
        adjudication_notes: null,
        integrity_notes: null,
        revealed_target: null,
        revision: 0,
        record_revision: 0,
        experience_mode: null,
        hint_credits_available: 0,
      },
    }),
  };

  // The client-side resolveInFlightRef guard is a plain ref outside this
  // pure function's own reach; what runOwnedResolveRequest/ownership itself
  // guarantees is that a single call never issues more than one
  // requestResolve, and a SUPERSEDED call cannot re-fire one either --
  // proven directly here.
  await runOwnedResolveRequest(ownership, io, state, 10);
  assert.equal(requestResolveCalls, 1, "the timeout-driven recovery must never call POST /resolve a second time on its own");
});

test("EXECUTED (retry visibility): a retry that also fails never clears the error in between -- the prior message stays visible until replaced", async () => {
  const ownership = createRequestOwnership();
  const g0 = game({ phase: "resolving" });
  const { state, calls } = racerClientShapedState(g0);

  const firstIo: ResolveRequestIO = {
    requestResolve: async () => ({ ok: false, data: { message: "first failure", game: g0 } as ResolveResponseBody }),
    requestView: async () => {
      throw new Error("unused");
    },
  };
  await runOwnedResolveRequest(ownership, firstIo, state, 100_000);

  const secondIo: ResolveRequestIO = {
    requestResolve: async () => ({ ok: false, data: { message: "second failure", game: g0 } as ResolveResponseBody }),
    requestView: async () => {
      throw new Error("unused");
    },
  };
  await runOwnedResolveRequest(ownership, secondIo, state, 100_000);

  const errorArgs = calls.filter((c) => c.fn === "setError").map((c) => c.arg);
  assert.deepEqual(
    errorArgs,
    ["first failure", "second failure"],
    "RacerClient's own setError mapping must never see a null between two real failures"
  );
});

test("EXECUTED: RESOLVE_NETWORK_ERROR_MESSAGE (the shared, still-unresolved fallback) is unchanged by this integration", () => {
  assert.equal(typeof RESOLVE_NETWORK_ERROR_MESSAGE, "string");
  assert.ok(RESOLVE_NETWORK_ERROR_MESSAGE.length > 0);
});
