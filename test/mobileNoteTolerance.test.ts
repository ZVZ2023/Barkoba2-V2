import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createGame } from "../lib/gameStore";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { anthropicAdapter } from "../lib/providers/anthropic";
import type { ToolCallResult } from "../lib/providers/types";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();
const TEST_COMPOSER_ID = testPlayerId("a");

// ---------------------------------------------------------------------------
// V2.8.4.2 — MOBILE NOTE-TEXT TOLERANCE.
//
// The YES/NO/IS-IS structured answer is authoritative; an attached note is
// supplementary. Two things must hold at the storage layer, provably, not
// just asserted: (1) the note is stored byte-for-byte (aside from ordinary
// whitespace trimming, unchanged from before this ticket), and (2) a note
// whose WORDING might look like it contradicts the selected structured
// answer never changes what was actually recorded as composer_response.
//
// The Racer/Integrity-Reviewer's own contextual, typo-tolerant reading of a
// note is a MODEL judgment call and cannot be exercised without a real
// provider call (excluded here) — see test/integrityReviewMateriality.test.ts
// for the prompt-contract proof that guidance exists. This file proves the
// mechanical half: what actually gets persisted, and by what field the
// answer is decided.
// ---------------------------------------------------------------------------

async function makeGame() {
  const gameId = randomUUID();
  await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "ai",
    max_questions: 20,
    game_language: "hu",
    composer_player_id: TEST_COMPOSER_ID,
  });
  return gameId;
}

function turnRequest(gameId: string, body: Record<string, unknown> | undefined) {
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

test("an AMBIGUOUS note with ordinary typos, missing accents, and an autocorrect substitution is stored byte-for-byte", async () => {
  const gameId = await makeGame();
  const guard = failIfCalled();
  try {
    const opening = await callTurn(gameId); // Q1
    const rev = opening.data.game.revision;
    // "Igen, de Bem jellemző" -- exactly the ticket's own example: "Bem" is a
    // phone-autocorrect slip for "nem", and the accent is missing from
    // "jellemzo" is not even present here, but the whole string must survive
    // untouched regardless of how it reads.
    const note = "Igen, de Bem jellemző, szoval inkabb NEM";
    const answered = await callTurn(gameId, { answer: "AMBIGUOUS", ambiguous_explanation: note, expected_revision: rev });
    assert.equal(answered.status, 200, JSON.stringify(answered.data));
    assert.equal(
      answered.data.game.qa_log[0].ambiguous_explanation,
      note,
      "the stored note must be byte-for-byte identical to what was submitted"
    );
  } finally {
    guard.restore();
  }
});

test("a typo-laden note never overrides the selected structured answer -- composer_response is exactly what was chosen, regardless of what the note says", async () => {
  const gameId = await makeGame();
  const guard = failIfCalled();
  try {
    const opening = await callTurn(gameId);
    const rev = opening.data.game.revision;
    // The note reads, in isolation, like a plain "yes" -- but the structured
    // choice was AMBIGUOUS, and that is what must be recorded.
    const note = "igen igen egyertelmuen igen";
    const answered = await callTurn(gameId, { answer: "AMBIGUOUS", ambiguous_explanation: note, expected_revision: rev });
    assert.equal(answered.status, 200, JSON.stringify(answered.data));
    assert.equal(
      answered.data.game.qa_log[0].composer_response,
      "AMBIGUOUS",
      "the structured answer is authoritative -- a note's wording must never reinterpret it"
    );
    assert.equal(answered.data.game.qa_log[0].ambiguous_explanation, note);
  } finally {
    guard.restore();
  }
});

test("leading/trailing whitespace is trimmed exactly as before this ticket -- not a new normalization, and internal content is untouched", async () => {
  const gameId = await makeGame();
  const guard = failIfCalled();
  try {
    const opening = await callTurn(gameId);
    const rev = opening.data.game.revision;
    const answered = await callTurn(gameId, {
      answer: "AMBIGUOUS",
      ambiguous_explanation: "   attól függ, Bem szamit-e   ",
      expected_revision: rev,
    });
    assert.equal(answered.status, 200, JSON.stringify(answered.data));
    assert.equal(answered.data.game.qa_log[0].ambiguous_explanation, "attól függ, Bem szamit-e");
  } finally {
    guard.restore();
  }
});

// --- Source-level: locale-appropriate `lang` on every note textarea --------

const GC = readFileSync("app/game/[id]/GameClient.tsx", "utf8");

test("every note/explanation textarea carries a locale-appropriate lang attribute driven by game_language", () => {
  const textareaCount = (GC.match(/<textarea/g) ?? []).length;
  const langCount = (GC.match(/lang=\{game\.game_language\}/g) ?? []).length;
  assert.equal(textareaCount, 3, "expected exactly the clue, answer-note, and correction-note textareas");
  assert.equal(langCount, textareaCount, "every free-text note input must carry the locale hint");
});

test("the lang attribute is a UI hint only -- spellCheck/autoCorrect stay enabled, nothing programmatically rewrites the value", () => {
  assert.equal((GC.match(/spellCheck/g) ?? []).length, 3);
  assert.equal((GC.match(/autoCorrect="on"/g) ?? []).length, 3);
  // No normalization function is applied to the textarea's own value anywhere.
  assert.doesNotMatch(GC, /normalizeText|sanitizeNote|autocorrectValue/);
});
