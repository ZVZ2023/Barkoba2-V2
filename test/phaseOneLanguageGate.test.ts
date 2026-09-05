import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as createPOST } from "../app/api/game/create/route";
import { POST as turnPOST } from "../app/api/game/[id]/turn/route";
import { getGame } from "../lib/gameStore";
import { openaiAdapter } from "../lib/providers/openai";
import type { ToolCallResult } from "../lib/providers/types";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();
// This file drives the real human-Composer creation path, so the Composer
// seat this test plays is whichever identity the create request itself
// presents — recorded by app/api/game/create/route.ts exactly as an ordinary
// caller's would be, then required again on every /turn call below.
const TEST_COMPOSER_ID = testPlayerId("a");

// The public creation path pins every ordinary game's Racer seat to "openai"
// (V2.8.7 — see PUBLIC_RACER_PROVIDER in app/api/game/create/route.ts), so a
// real-flow test that goes through the actual create route needs openai
// "available" and must mock openaiAdapter, not anthropicAdapter, to observe
// the Racer's turn.
// ANTHROPIC_API_KEY is required too: lib/prompts/validator.ts always calls
// the real Anthropic transport (mocked below via global.fetch), and the
// transport reads the key before the mocked fetch is ever reached.
process.env.OPENAI_API_KEY = "test-key";
process.env.ANTHROPIC_API_KEY = "test-key";
// This file creates several games from the same synthetic guest identity —
// the per-hour creation rate limit is an anonymous-abuse safeguard unrelated
// to what this file tests, so it is disabled exactly as lib/rateLimit.ts's
// own doc comment says to for a non-production environment.
process.env.RATE_LIMIT_DISABLED = "true";

// ---------------------------------------------------------------------------
// V2.8.4 PHASE ONE — FINAL LANGUAGE-GATE CORRECTION.
//
// REAL FLOW, not inference from constants. These tests drive the actual
// /api/game/create route (the same one ComposerEntry.tsx posts to) and the
// actual /turn route, with only the network boundary (Anthropic's raw fetch,
// used by lib/prompts/validator.ts, and the Racer's anthropicAdapter) mocked.
//
// THE BUG THIS PROVES: app/game/[id]/GameClient.tsx hardcodes the answer
// controls in Hungarian unconditionally (YES/NO/AMBIGUOUS render as
// "IGEN"/"NEM"/"IS-IS" regardless of game_language — see the grep-based
// assertion below). The Hungarian shell offers a language selector that
// defaults to "auto" ("Automatikus"). Before this fix, leaving it on "auto"
// while typing an English-detectable target let the Validator's own
// language detection silently pick "en" for game_language, which Phase One
// then used to select its own question language — producing English
// questions beside permanently-Hungarian buttons. Explicit "hu"/"en"
// selections were never affected; only AUTO was.
// ---------------------------------------------------------------------------

function mockValidatorFetch(detectedLanguage: "en" | "hu") {
  const original = global.fetch;
  global.fetch = (async (url: unknown) => {
    if (typeof url === "string" && url.includes("api.anthropic.com")) {
      const input = {
        status: "VALID",
        message: "ok",
        difficulty_warning: null,
        private_knowledge: false,
        game_language: detectedLanguage,
      };
      return {
        ok: true,
        json: async () => ({
          model: "claude-mock",
          // V2.8.7 — the client validates the returned tool's NAME.
          content: [{ type: "tool_use", name: "submit_validation", input }],
        }),
        text: async () => "",
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  }) as typeof fetch;
  return {
    restore: () => {
      global.fetch = original;
    },
  };
}

async function createGameViaRoute(body: Record<string, unknown>) {
  const req = new NextRequest("http://localhost/api/game/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bk-player": TEST_COMPOSER_ID },
    body: JSON.stringify(body),
  });
  const res = await createPOST(req);
  const data = await res.json();
  return { status: res.status, data };
}

async function callTurn(gameId: string, body?: Record<string, unknown>) {
  const json = body === undefined ? "" : JSON.stringify(body);
  const req = new NextRequest(`http://localhost/api/game/${gameId}/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": body === undefined ? "0" : String(Buffer.byteLength(json)),
      "x-bk-player": TEST_COMPOSER_ID,
    },
    body: body === undefined ? undefined : json,
  });
  const res = await turnPOST(req, { params: { id: gameId } });
  const data = await res.json();
  return { status: res.status, data };
}

async function answer(gameId: string, ans: "YES" | "NO" | "AMBIGUOUS", revision: number) {
  const result = await callTurn(gameId, { answer: ans, expected_revision: revision });
  assert.equal(result.status, 200, `answer(${ans}) should succeed: ${JSON.stringify(result.data)}`);
  return result.data.game;
}

function mockRacerOnce(questionText: string) {
  const original = openaiAdapter.callTool;
  let calls = 0;
  let capturedMessages: unknown[] = [];
  openaiAdapter.callTool = (async (request: { messages: unknown[] }) => {
    calls += 1;
    capturedMessages = request.messages;
    return {
      // V2.8.5 ENGINE-CONTRACT CORRECTION (defect 1) — an ordinary Layer Two
      // question now requires this metadata to pass validateCandidateMove().
      output: {
        action: "question",
        question_text: questionText,
        guess_text: null,
        rationale: "test",
        dimension: "test.generic",
        question_kind: "discriminator",
        proposition_id: `test.generic.${calls}`,
        parent_proposition: null,
        predicate_strength: "stable",
        sandbox_repair: false,
        sandbox_repair_reason: null,
        sandbox_repair_to: null,
      },
      resolvedModel: "stub",
    } as ToolCallResult<unknown>;
  }) as typeof openaiAdapter.callTool;
  return {
    callCount: () => calls,
    lastMessages: () => capturedMessages,
    restore: () => {
      openaiAdapter.callTool = original;
    },
  };
}

const EN_Q1 = "Is it alive?";
const HU_Q1 = "Élő?";

// --- The hardcoded-Hungarian answer controls, proven from source -----------

const GAME_CLIENT_SRC = readFileSync("app/game/[id]/GameClient.tsx", "utf8");

test("GameClient's answer controls are unconditionally Hungarian, independent of game_language", () => {
  assert.match(GAME_CLIENT_SRC, /IGEN/);
  assert.match(GAME_CLIENT_SRC, /NEM/);
  assert.match(GAME_CLIENT_SRC, /IS-IS/);
  // No conditional on game_language governs which literal is rendered — the
  // labels are plain string literals, not looked up from a language table.
  assert.doesNotMatch(GAME_CLIENT_SRC, /game_language[\s\S]{0,80}(IGEN|YES)/);
});

// --- REQUIRED (a): real-flow proof, HU shell + Auto + "Hole" ---------------

test("REAL FLOW: HU shell + Automatikus + English-detectable target -> Hungarian Q1, matching the always-Hungarian controls", async () => {
  const mock = mockValidatorFetch("en"); // the Validator would have read "Hole" as English
  let gameId: string;
  try {
    const created = await createGameViaRoute({ target: "Hole", game_language: "auto" });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal(created.data.status, "VALID");
    gameId = created.data.game_id;

    // Effective stored game_language must be Hungarian: the shell's own
    // language, not the target text's detected language.
    assert.equal(created.data.game_language, "hu", "AUTO must resolve to the shell language, not target-text detection");
  } finally {
    mock.restore();
  }

  const stored = await getGame(gameId!);
  assert.equal(stored!.game_language, "hu");

  const opening = await callTurn(gameId!);
  assert.equal(opening.status, 200);
  assert.equal(opening.data.game.qa_log[0].question_text, HU_Q1, "Q1 must be Hungarian, matching the Hungarian IGEN/NEM/IS-IS controls");
});

// --- REQUIRED (b)/(d)(2): explicit English selection is unaffected ---------

test("REAL FLOW: HU shell + explicit English selection -> English Q1, regardless of target text", async () => {
  const mock = mockValidatorFetch("hu"); // even if the Validator reads Hungarian, explicit English wins
  let gameId: string;
  try {
    const created = await createGameViaRoute({ target: "Lyuk", game_language: "en" });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    gameId = created.data.game_id;
    assert.equal(created.data.game_language, "en", "an explicit choice must still win outright");
  } finally {
    mock.restore();
  }

  const opening = await callTurn(gameId!);
  assert.equal(opening.data.game.qa_log[0].question_text, EN_Q1);
});

// --- REQUIRED (c)/(d)(3): explicit Hungarian selection is unaffected -------

test("REAL FLOW: HU shell + explicit Hungarian selection -> Hungarian Q1", async () => {
  const mock = mockValidatorFetch("en");
  let gameId: string;
  try {
    const created = await createGameViaRoute({ target: "Hole", game_language: "hu" });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    gameId = created.data.game_id;
    assert.equal(created.data.game_language, "hu");
  } finally {
    mock.restore();
  }

  const opening = await callTurn(gameId!);
  assert.equal(opening.data.game.qa_log[0].question_text, HU_Q1);
});

// --- REQUIRED (d)(4): Phase Two inherits the same effective language -------

test("REAL FLOW: Phase Two's Racer receives the same corrected language as Phase One", async () => {
  const mock = mockValidatorFetch("en"); // AUTO must still collapse to hu downstream too
  let gameId: string;
  try {
    const created = await createGameViaRoute({ target: "Hole", game_language: "auto" });
    gameId = created.data.game_id;
    assert.equal(created.data.game_language, "hu");
  } finally {
    mock.restore();
  }

  // Fast-forward to Phase Two's first real (mocked) Racer turn. V2.8.5 — this
  // now locks "physical" (NO, YES, then a specificity answer) rather than
  // the old 5x-NO path to "unclassified": "unclassified" now routes through
  // the private "+1" sandbox-clarification corridor first (see
  // lib/sandboxClarification.ts) instead of reaching the model directly, and
  // "physical" has no Layer Two mandatory opening gate either, so it still
  // reaches the model in the very next answer — exactly what this test (about
  // language propagation, not sandbox specifics) needs.
  const opening = await callTurn(gameId!);
  let rev = opening.data.game.revision;
  let g = await answer(gameId!, "NO", rev); // -> "physical" gate question
  rev = g.revision;
  g = await answer(gameId!, "YES", rev); // locks physical -> specificity question
  rev = g.revision;

  const racer = mockRacerOnce("Van benne elektronika?");
  let final;
  try {
    final = await answer(gameId!, "NO", rev); // kind -> Phase One complete -> Phase Two's first turn
    assert.equal(racer.callCount(), 1);
    const messages = racer.lastMessages() as Array<{ content: string }>;
    const joined = messages.map((m) => m.content).join("\n");
    assert.match(
      joined,
      /Language of this game: Hungarian \(magyar\)/,
      "the Racer must receive the SAME effective language Phase One used, not the target-text detection"
    );
  } finally {
    racer.restore();
  }
  assert.equal(final.qa_log[3].question_text, "Van benne elektronika?");
});

// --- REQUIRED (d)(5): no target content reaches the Racer or Phase One -----

test("REAL FLOW: the secret target text never reaches Phase One's question selection or the Racer's messages", async () => {
  const mock = mockValidatorFetch("en");
  let gameId: string;
  try {
    const created = await createGameViaRoute({ target: "Hole", game_language: "auto" });
    gameId = created.data.game_id;
  } finally {
    mock.restore();
  }

  const opening = await callTurn(gameId!);
  // Phase One's question text is one of the fixed, static strings -- never
  // derived from or containing the secret target.
  assert.doesNotMatch(opening.data.game.qa_log[0].question_text, /hole|lyuk/i);

  let rev = opening.data.game.revision;
  for (let i = 0; i < 4; i += 1) {
    const g = await answer(gameId!, "NO", rev);
    rev = g.revision;
  }
  const racer = mockRacerOnce("Van elektronikája?");
  try {
    await answer(gameId!, "NO", rev);
    const messages = racer.lastMessages() as Array<{ content: string }>;
    const joined = messages.map((m) => m.content).join("\n");
    assert.doesNotMatch(joined, /hole|lyuk/i, "the Racer's own messages must never contain the secret target");
  } finally {
    racer.restore();
  }
});

// --- REQUIRED (d)(6): Phase One still makes zero provider calls ------------

test("REAL FLOW: Phase One still makes zero Racer-provider calls after the language-gate fix", async () => {
  const mock = mockValidatorFetch("en");
  let gameId: string;
  try {
    const created = await createGameViaRoute({ target: "Hole", game_language: "auto" });
    gameId = created.data.game_id;
  } finally {
    mock.restore();
  }

  const original = openaiAdapter.callTool;
  openaiAdapter.callTool = (async () => {
    throw new Error("PROVIDER MUST NOT BE CALLED DURING PHASE ONE");
  }) as typeof openaiAdapter.callTool;
  try {
    const opening = await callTurn(gameId!);
    let rev = opening.data.game.revision;
    for (let i = 0; i < 4; i += 1) {
      const g = await answer(gameId!, "NO", rev);
      rev = g.revision;
    }
    // Q5 not yet answered -- the 5th answer is what triggers Phase Two, so
    // stopping short of it keeps this test a pure zero-provider-calls check.
  } finally {
    openaiAdapter.callTool = original;
  }
});
