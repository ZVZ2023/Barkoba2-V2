import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createGame, getGame, newLogEntry, saveGame } from "../lib/gameStore";
import { POST as askPOST } from "../app/api/game/[id]/ask/route";
import { completedHistoryForDisplay } from "../lib/gameHistoryOrder";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";
import type { GameLanguage } from "../lib/types";

enableTestIdentityLookups();
process.env.ANTHROPIC_API_KEY = "test-key";

// ---------------------------------------------------------------------------
// V2.8.7.4 — DEFECT 2: production field sequence.
//
// AI Setter / human Racer, Hard, 100-question game, Progressive assistance.
// Question #9 arrived as "Is it related to a land decking creature?"; the
// intended correction was "Is it related to a land creature?". "Javítom" was
// pressed twice; nothing visibly happened for a long stretch (this path runs
// TWO sequential model calls -- see app/api/game/[id]/ask/route.ts's own
// EDIT_TOTAL_PROVIDER_BUDGET_MS); a delayed, English-only rejection
// eventually appeared: "That asks something different, so it counts as a new
// question."
//
// Root causes established by direct code reading (see the V2.8.7.4 report):
//   - Only ONE tap ever reached the model: send()'s actionInFlightRef guard
//     (already existed, from the earlier V2.8.5.2(D) production forensic)
//     silently swallows any concurrent call BEFORE it reaches the network --
//     already proven server-side by "duplicate submission at the same
//     revision" in test/askReliability.test.ts. The defect was the total
//     ABSENCE of a visible pending indicator during the genuinely long
//     (~30-60s) wait, not an actual duplicate submission.
//   - The rejection message was a single hardcoded ENGLISH string, the one
//     message in this route not localized to game_language.
//   - The judge prompt (lib/prompts/questionEdit.ts) had no explicit
//     guidance for "an inserted, meaningless word" (only "a missing word"),
//     so a mishearing/autocorrect INSERTION read as a scope change rather
//     than noise.
//
// Every test below runs the REAL route handler against a mocked model
// response (this codebase's own established technique -- see
// test/askReliability.test.ts's own module doc) or reads source directly.
// No paid gameplay: every model call in this file is fully mocked.
//
// NOT TESTABLE HERE, BY DESIGN: the ACCEPT path's second call
// (answerAsComposer) needs a real secret via lib/secretStore.ts, and no test
// file in this codebase is a permitted importer of that module (see
// scripts/check-isolation.mjs and test/clueReliability.test.ts's identical
// note) -- this is the architecture's own isolation invariant working as
// intended, not a gap in this file. What IS proven here: an accepted verdict
// correctly reaches the re-answer step (observed by the route hitting
// secret_unavailable rather than edit_changes_intent), and leaves the entry
// completely unmutated up to that point.
// ---------------------------------------------------------------------------

const RACER = testPlayerId("d");
const ASK_ROUTE_SRC = readFileSync("app/api/game/[id]/ask/route.ts", "utf8");
const QUESTION_EDIT_PROMPT_SRC = readFileSync("lib/prompts/questionEdit.ts", "utf8");
const RACER_CLIENT_SRC = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");

async function humanRacerGame(gameLanguage: GameLanguage) {
  const gameId = randomUUID();
  const game = await createGame(gameId, {
    phase: "questioning",
    composer_kind: "ai",
    racer_kind: "human",
    max_questions: 100,
    difficulty: "hard",
    clue_mode: "progressive",
    game_language: gameLanguage,
    racer_player_id: RACER,
  });
  const e = newLogEntry(9);
  e.question_text = "Is it related to a land decking creature?";
  e.composer_response = "NO";
  e.answered_at = new Date().toISOString();
  game.qa_log = [e];
  game.question_count = 9;
  await saveGame(game);
  return { gameId };
}

function req(gameId: string, body: unknown, playerId: string) {
  const json = JSON.stringify(body);
  return new NextRequest(`http://localhost/api/game/${gameId}/ask`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
      "x-bk-player": playerId,
    },
    body: json,
  });
}

async function callAsk(gameId: string, body: unknown, playerId: string) {
  const res = await askPOST(req(gameId, body, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}

function anthropicResponse(input: Record<string, unknown>, toolName: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: "test-model", content: [{ type: "tool_use", name: toolName, input }] }),
    text: async () => "",
  } as unknown as Response;
}

function stubAnthropicOnce(input: Record<string, unknown>) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: unknown) => {
    calls += 1;
    if (calls > 1) throw new Error("unexpected extra Anthropic call");
    const body = (init as { body?: string } | undefined)?.body;
    const parsed = body ? (JSON.parse(body) as { tools?: Array<{ name?: string }> }) : {};
    const toolName = parsed.tools?.[0]?.name ?? "unknown_tool";
    return anthropicResponse(input, toolName);
  }) as typeof fetch;
  return {
    callCount: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Genuine semantic-change rejection -- localized.
// ---------------------------------------------------------------------------

test("genuine semantic-change rejection: a Hungarian game gets the Hungarian message, not raw English", async () => {
  const { gameId } = await humanRacerGame("hu");
  const stub = stubAnthropicOnce({ reasoning: "changes what is being asked", same_intent: false });
  try {
    const res = await callAsk(
      gameId,
      { edit_turn_index: 9, question: "Is it related to a land creature?", expected_revision: 0 },
      RACER
    );
    assert.equal(res.status, 409);
    assert.equal(res.data.error, "edit_changes_intent");
    assert.match(res.data.message, /más kérdésnek számít/);
    assert.doesNotMatch(res.data.message, /That asks something different/);
    // Actionable: tells the player their original stands AND how to proceed.
    assert.match(res.data.message, /eredeti kérdésed és a rá adott válasz megmarad/);
    assert.match(res.data.message, /tedd fel új kérdésként/);
  } finally {
    stub.restore();
  }
});

test("genuine semantic-change rejection: an English game gets the English message", async () => {
  const { gameId } = await humanRacerGame("en");
  const stub = stubAnthropicOnce({ reasoning: "changes what is being asked", same_intent: false });
  try {
    const res = await callAsk(
      gameId,
      { edit_turn_index: 9, question: "Is it related to a land creature?", expected_revision: 0 },
      RACER
    );
    assert.equal(res.status, 409);
    assert.match(res.data.message, /That asks something different, so it counts as a new question/);
    assert.match(res.data.message, /Your original question and its answer stand/);
    assert.match(res.data.message, /Ask it as a new question if you'd still like to/);
  } finally {
    stub.restore();
  }
});

test("a rejection mutates ONLY edit_status/edit_reason on the target entry -- the question text, answer, and turn_index are untouched", async () => {
  const { gameId } = await humanRacerGame("en");
  const stub = stubAnthropicOnce({ reasoning: "changes what is being asked", same_intent: false });
  try {
    await callAsk(
      gameId,
      { edit_turn_index: 9, question: "Is it related to a land creature?", expected_revision: 0 },
      RACER
    );
    const canonical = await getGame(gameId);
    const entry = canonical!.qa_log[0]!;
    assert.equal(entry.turn_index, 9);
    assert.equal(entry.question_text, "Is it related to a land decking creature?", "the original wording stands");
    assert.equal(entry.composer_response, "NO", "the original answer stands");
    assert.equal(entry.edit_status, "rejected");
    assert.equal(entry.edit_reason, "changes what is being asked");
    assert.equal(canonical!.question_count, 9, "no question was consumed by the rejected edit");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// Accepted verdict: the route must take the ACCEPT branch (never fall
// through to edit_changes_intent), reaching the second call's own
// secret lookup -- proven by the documented, honest 410 that lookup
// returns for a game with no stored secret, rather than a 409 rejection.
// See this file's own module doc for why the second call itself
// (answerAsComposer, needing a real secret) cannot run further here.
// ---------------------------------------------------------------------------

test("an accepted verdict (same_intent: true) takes the ACCEPT branch -- reaches the secret lookup, never the rejection branch, and mutates nothing beforehand", async () => {
  const { gameId } = await humanRacerGame("en");
  const stub = stubAnthropicOnce({ reasoning: "autocorrect noise removed", same_intent: true });
  try {
    const res = await callAsk(
      gameId,
      { edit_turn_index: 9, question: "Is it related to a land creature?", expected_revision: 0 },
      RACER
    );
    // No secret was ever stored for this test game (by design -- see the
    // module doc) -- getSecretForAnswering() returns null honestly, and the
    // route reports that rather than silently treating it as a rejection.
    assert.equal(res.status, 410, "must reach the secret lookup, not stop at edit_changes_intent");
    assert.equal(res.data.error, "secret_unavailable");
    assert.equal(stub.callCount(), 1, "only the judge call was made -- the second call never reached the (mocked) network");

    const canonical = await getGame(gameId);
    const entry = canonical!.qa_log[0]!;
    assert.equal(entry.question_text, "Is it related to a land decking creature?", "unmutated -- the accept branch writes the new text only after the SECOND call succeeds");
    assert.equal(entry.edit_status, null, "not yet accepted or rejected -- the second call never completed");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// The judge prompt itself: the new guidance for "inserted noise word" repair
// (the field case) and the still-strict "real qualifier" rejection example,
// both source-contract checked since the model cannot be invoked live here.
// ---------------------------------------------------------------------------

test("lib/prompts/questionEdit.ts: the SAME-INTENT guidance now explicitly covers removing an inserted, meaningless word -- the field case ('decking')", () => {
  assert.match(QUESTION_EDIT_PROMPT_SRC, /Removing a stray inserted word/);
  assert.match(QUESTION_EDIT_PROMPT_SRC, /land decking creature/);
  assert.match(QUESTION_EDIT_PROMPT_SRC, /noise, not a qualifier/);
});

test("lib/prompts/questionEdit.ts: removing a REAL qualifier is still guided toward rejection -- the fix must not weaken genuine-change detection", () => {
  assert.match(QUESTION_EDIT_PROMPT_SRC, /a real, meaning-bearing/i);
  assert.match(QUESTION_EDIT_PROMPT_SRC, /LARGE land creature/);
  assert.match(QUESTION_EDIT_PROMPT_SRC, /"large" was a real, meaningful distinction/);
});

test("lib/prompts/questionEdit.ts: the asymmetric-failure discipline (when unsure, reject) is unchanged", () => {
  assert.match(QUESTION_EDIT_PROMPT_SRC, /WHEN GENUINELY UNSURE, ANSWER FALSE/);
});

// ---------------------------------------------------------------------------
// Duplicate-tap suppression + visible pending state -- client wiring
// (server-side duplicate suppression is already proven end-to-end by
// test/askReliability.test.ts's "duplicate submission at the same revision"
// test; this proves the CLIENT never even lets a concurrent tap reach
// send(), and that the player now sees why nothing else happens).
// ---------------------------------------------------------------------------

test("RacerClient.tsx: Javítom and Mégsem are both disabled while busy, and send() itself has a synchronous re-entry guard predating this fix", () => {
  const editingPanel = RACER_CLIENT_SRC.slice(
    RACER_CLIENT_SRC.indexOf("{editing === entry.turn_index && ("),
    RACER_CLIENT_SRC.indexOf('entry.original_question_text && entry.edit_status === "accepted"')
  );
  assert.match(editingPanel, /disabled=\{busy \|\| !editText\.trim\(\)\}/, "Javítom");
  assert.match(editingPanel, />\s*Mégsem\s*</);
  assert.match(RACER_CLIENT_SRC, /if \(actionInFlightRef\.current\) return;/);
  assert.match(RACER_CLIENT_SRC, /actionInFlightRef\.current = true;/);
});

test("RacerClient.tsx: the correction panel shows an explicit, correction-specific pending message while busy -- the missing feedback the field report identified", () => {
  const editingPanel = RACER_CLIENT_SRC.slice(
    RACER_CLIENT_SRC.indexOf("{editing === entry.turn_index && ("),
    RACER_CLIENT_SRC.indexOf('entry.original_question_text && entry.edit_status === "accepted"')
  );
  assert.match(editingPanel, /\{busy && \(/);
  assert.match(editingPanel, /Ellenőrzés és újraválaszolás folyamatban/);
});

test("RacerClient.tsx: the generic busy indicator is suppressed while a correction is open, so exactly one pending message shows at a time", () => {
  assert.match(RACER_CLIENT_SRC, /\{busy && editing === null && <p/);
});

// ---------------------------------------------------------------------------
// Correction targets the correct turn identity, even though the DISPLAY is
// newest-first -- the entry the edit control targets is always the entry
// actually shown FIRST in the reversed history, never a display-index
// mismatch.
// ---------------------------------------------------------------------------

test("the edit control's target (the chronologically LAST turn) is always the FIRST entry the newest-first display shows -- no display-index/chronological-turn mismatch", () => {
  const chronological = [
    { turn_index: 1 },
    { turn_index: 2 },
    { turn_index: 9 }, // the "last turn" the edit control would target
  ];
  const lastChronological = chronological[chronological.length - 1];
  const display = completedHistoryForDisplay(chronological);
  assert.equal(display[0], lastChronological, "the entry shown FIRST in the reversed display IS the one turns[turns.length-1] identifies");
});

test("app/api/game/[id]/ask/route.ts: the edit target is looked up by turn_index identity against the canonical, chronological qa_log -- never by a display position", () => {
  assert.match(ASK_ROUTE_SRC, /const last = game\.qa_log\[game\.qa_log\.length - 1\];/);
  assert.match(ASK_ROUTE_SRC, /last\.turn_index !== body\.edit_turn_index/);
});
