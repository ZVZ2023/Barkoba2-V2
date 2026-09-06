import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as createPOST } from "../app/api/game/create/route";
import { POST as hhTurnPOST } from "../app/api/game/[id]/hh/turn/route";
import { createGame, getGame } from "../lib/gameStore";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();
process.env.ANTHROPIC_API_KEY = "test-key";
// The public creation path pins every ordinary human-Composer game's Racer
// seat to "openai" (see app/api/game/create/route.ts's PUBLIC_RACER_PROVIDER
// — matches test/phaseOneLanguageGate.test.ts's own identical requirement),
// so creating one at all needs this key present, even though this file never
// exercises the Racer's own turn.
process.env.OPENAI_API_KEY = "test-key";
process.env.RATE_LIMIT_DISABLED = "true";

// ---------------------------------------------------------------------------
// V2.8.8 SLICE 2 — mode behavior and hint gating.
//
// Covers: unknown mode rejected server-side (both creation branches, before
// any model call), preset-to-clue-mode derivation actually persisted,
// legacy (omitted-mode) behavior preserved verbatim, human/human hint
// cadence brought under the same mechanism without breaking legacy
// unlimited games, Competitive blocking every hint path, and the explicit
// boundary that mode framing never reaches adjudication/integrity/
// correction-validity/no-spelling prompts.
// ---------------------------------------------------------------------------

const PLAYER = testPlayerId("1");

function createReq(body: Record<string, unknown>, playerId: string) {
  return new NextRequest("http://localhost/api/game/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bk-player": playerId },
    body: JSON.stringify(body),
  });
}

async function callCreate(body: Record<string, unknown>, playerId = PLAYER) {
  const res = await createPOST(createReq(body, playerId));
  return { status: res.status, data: await res.json() };
}

// ---------------------------------------------------------------------------
// Unknown mode rejected -- BEFORE any model call, in both creation branches.
// ---------------------------------------------------------------------------

test("ai_composer: an unknown experience_mode is rejected with 400, before any model call", async () => {
  const original = global.fetch;
  global.fetch = (async () => {
    throw new Error("must not reach the network for an invalid mode");
  }) as typeof fetch;
  try {
    const res = await callCreate({ mode: "ai_composer", experience_mode: "hardcore" });
    assert.equal(res.status, 400);
    assert.equal(res.data.error, "invalid_experience_mode");
  } finally {
    global.fetch = original;
  }
});

test("human_composer: an unknown experience_mode is rejected with 400, before any model call", async () => {
  const original = global.fetch;
  global.fetch = (async () => {
    throw new Error("must not reach the network for an invalid mode");
  }) as typeof fetch;
  try {
    const res = await callCreate({ target: "Hole", experience_mode: "extreme" });
    assert.equal(res.status, 400);
    assert.equal(res.data.error, "invalid_experience_mode");
  } finally {
    global.fetch = original;
  }
});

function mockValidatorFetch(): { restore: () => void } {
  const original = global.fetch;
  global.fetch = (async (url: unknown) => {
    if (typeof url === "string" && url.includes("api.anthropic.com")) {
      const input = {
        status: "VALID",
        message: "ok",
        difficulty_warning: null,
        private_knowledge: false,
        game_language: "hu",
      };
      return {
        ok: true,
        json: async () => ({
          model: "claude-mock",
          content: [{ type: "tool_use", name: "submit_validation", input }],
        }),
        text: async () => "",
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  }) as typeof fetch;
  return { restore: () => { global.fetch = original; } };
}

// ---------------------------------------------------------------------------
// Preset-to-clue derivation, actually persisted -- human-Composer branch
// (covers BOTH GameClient's and HumanClient's own direction, per the
// route's own "applies to BOTH human-Composer flows" comment).
// ---------------------------------------------------------------------------

test("human_composer: each experience_mode derives and PERSISTS the approved clue_mode preset, overriding any client-submitted clue_mode", async () => {
  const mock = mockValidatorFetch();
  try {
    const cases: Array<[string, string]> = [
      ["competitive", "none"],
      ["friendly", "minimal"],
      ["teaching", "progressive"],
      ["humorous", "minimal"],
    ];
    for (const [mode, expectedClueMode] of cases) {
      const created = await callCreate({
        target: `target-${mode}`,
        experience_mode: mode,
        clue_mode: "progressive", // deliberately wrong -- must be IGNORED and derived instead
      });
      assert.equal(created.status, 200, JSON.stringify(created.data));
      const game = await getGame(created.data.game_id);
      assert.equal(game!.experience_mode, mode);
      assert.equal(game!.clue_mode, expectedClueMode, mode);
    }
  } finally {
    mock.restore();
  }
});

test("human_composer: an older client omitting experience_mode preserves EXACT legacy behavior -- experience_mode stays null, clue_mode stays null (this branch never set it before V2.8.8)", async () => {
  const mock = mockValidatorFetch();
  try {
    const created = await callCreate({ target: "Hole" });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const game = await getGame(created.data.game_id);
    assert.equal(game!.experience_mode, null);
    assert.equal(game!.clue_mode, null);
  } finally {
    mock.restore();
  }
});

function mockComposerTargetFetch(): { restore: () => void } {
  const original = global.fetch;
  global.fetch = (async () => ({
    ok: true,
    json: async () => ({
      model: "claude-mock",
      content: [
        {
          type: "tool_use",
          name: "submit_target",
          input: {
            reasoning: "fits the difficulty",
            target: "bicikli",
            granularity: "generic_type",
            modifiers: null,
            definition: "a kerékpár",
          },
        },
      ],
    }),
    text: async () => "",
  } as unknown as Response)) as typeof fetch;
  return { restore: () => { global.fetch = original; } };
}

test("ai_composer: each experience_mode derives and PERSISTS the approved clue_mode preset", async () => {
  const mock = mockComposerTargetFetch();
  try {
    const cases: Array<[string, string]> = [
      ["competitive", "none"],
      ["friendly", "minimal"],
      ["teaching", "progressive"],
      ["humorous", "minimal"],
    ];
    for (const [mode, expectedClueMode] of cases) {
      const created = await callCreate({
        mode: "ai_composer",
        difficulty: "hard",
        experience_mode: mode,
        clue_mode: "progressive", // deliberately wrong -- must be IGNORED
      });
      assert.equal(created.status, 200, JSON.stringify(created.data));
      const game = await getGame(created.data.game_id);
      assert.equal(game!.experience_mode, mode);
      assert.equal(game!.clue_mode, expectedClueMode, mode);
      assert.equal(created.data.clue_mode, expectedClueMode, "echoed in the response too");
    }
  } finally {
    mock.restore();
  }
});

test("ai_composer: an older client omitting experience_mode preserves the EXACT pre-V2.8.8 difficulty-gated clue_mode rule", async () => {
  const mock = mockComposerTargetFetch();
  try {
    // Hard + a valid submitted clue_mode -- the ORIGINAL rule, unchanged.
    const created = await callCreate({ mode: "ai_composer", difficulty: "hard", clue_mode: "minimal" });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const game = await getGame(created.data.game_id);
    assert.equal(game!.experience_mode, null);
    assert.equal(game!.clue_mode, "minimal");

    // Medium + a submitted clue_mode -- still forced to "none", unchanged.
    const created2 = await callCreate({ mode: "ai_composer", difficulty: "medium", clue_mode: "minimal" });
    const game2 = await getGame(created2.data.game_id);
    assert.equal(game2!.experience_mode, null);
    assert.equal(game2!.clue_mode, "none");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// Human/human hint cadence -- legacy unlimited preserved; a mode-bearing game
// is brought under the same derived-credit mechanism; Competitive blocks
// entry outright; an exhausted-credit mode-bearing game is refused too.
// ---------------------------------------------------------------------------

async function humanVsHumanGame(overrides: Record<string, unknown> = {}) {
  const gameId = randomUUID();
  const composer = testPlayerId("2");
  const racer = testPlayerId("3");
  await createGame(gameId, {
    phase: "questioning",
    composer_kind: "human",
    racer_kind: "human",
    max_questions: 20,
    game_language: "hu",
    composer_player_id: composer,
    racer_player_id: racer,
    ...overrides,
  });
  return { gameId, composer };
}

function hhReq(gameId: string, body: unknown, playerId: string) {
  const json = JSON.stringify(body);
  return new NextRequest(`http://localhost/api/game/${gameId}/hh/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
      "x-bk-player": playerId,
    },
    body: json,
  });
}

async function callHhTurn(gameId: string, body: unknown, playerId: string) {
  const res = await hhTurnPOST(hhReq(gameId, body, playerId), { params: { id: gameId } });
  return { status: res.status, data: await res.json() };
}

test("human/human hint: a LEGACY game (no experience_mode) remains completely unlimited -- unchanged from before V2.8.8", async () => {
  const { gameId, composer } = await humanVsHumanGame({ experience_mode: null });
  for (let i = 0; i < 5; i++) {
    const res = await callHhTurn(gameId, { action: "hint", hint: `hint ${i}`, expected_revision: i }, composer);
    assert.equal(res.status, 200, `hint #${i} should succeed unconditionally: ${JSON.stringify(res.data)}`);
  }
});

test("human/human hint: Competitive blocks hint entry outright, even on turn 1", async () => {
  const { gameId, composer } = await humanVsHumanGame({
    experience_mode: "competitive",
    clue_mode: "none",
  });
  const res = await callHhTurn(gameId, { action: "hint", hint: "psst", expected_revision: 0 }, composer);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "hint_disabled");
});

test("human/human hint: a mode-bearing (Friendly) game is gated by the SAME derived-credit mechanism as every other direction", async () => {
  const { gameId, composer } = await humanVsHumanGame({
    experience_mode: "friendly",
    clue_mode: "minimal",
    question_count: 0,
  });
  // No credit earned yet at 0 questions.
  const res = await callHhTurn(gameId, { action: "hint", hint: "psst", expected_revision: 0 }, composer);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "no_hint_credit");
});

test("human/human hint: a mode-bearing game WITH an earned credit succeeds", async () => {
  const { gameId, composer } = await humanVsHumanGame({
    experience_mode: "teaching",
    clue_mode: "progressive",
    question_count: 10, // one credit earned
  });
  const res = await callHhTurn(gameId, { action: "hint", hint: "consider the shape", expected_revision: 0 }, composer);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const canonical = await getGame(gameId);
  assert.equal(canonical!.qa_log.at(-1)!.turn_type, "clue");
  assert.equal(canonical!.question_count, 10, "a hint must still never consume a question");
});

// ---------------------------------------------------------------------------
// The safe-presentation boundary: mode framing must never reach a prompt
// whose decision must remain mode-independent.
// ---------------------------------------------------------------------------

test("adjudicator/integrity-review/validator/questionEdit prompts never accept an experienceMode parameter -- mode framing is confined to the hint path only", () => {
  for (const path of [
    "lib/prompts/adjudicator.ts",
    "lib/prompts/integrityReview.ts",
    "lib/prompts/validator.ts",
    "lib/prompts/questionEdit.ts",
    "lib/questionPolicy.ts",
  ]) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(src, /experienceMode|ExperienceMode/, `${path} must stay mode-independent`);
  }
});

test("answerAsComposer (the truthful YES/NO/AMBIGUOUS classification) never accepts an experienceMode parameter -- only the SEPARATE requestClueFromComposer does", () => {
  const src = readFileSync("lib/prompts/composerAnswer.ts", "utf8");
  const answerFn = src.slice(
    src.indexOf("export async function answerAsComposer"),
    src.indexOf("export async function requestClueFromComposer")
  );
  assert.doesNotMatch(answerFn, /experienceMode/, "the answer-classification function must stay mode-independent");
  const clueFn = src.slice(src.indexOf("export async function requestClueFromComposer"));
  assert.match(clueFn, /experienceMode/, "only the hint path carries mode framing");
});

// ---------------------------------------------------------------------------
// V2.8.8 COMPLETION SUPERSEDES this test's original claim. The original
// V2.8.8 report excluded lib/prompts/racer.ts entirely, which the follow-up
// "mode cannot be only a hint label" instruction identified as the actual
// defect: in the direction where the AI plays Racer, that left every
// player-visible AI-authored string (every question it asks) completely
// untouched by mode. The fix is presentation-ONLY tone (RACER_MODE_TONE /
// renderModeTone in buildRacerTurnMessage), so the safe-presentation
// boundary now applies at a NARROWER grain here: the byte-verified
// CORE_RACER_RULES decision block, and the guess-intent disambiguation
// path, must still never see experienceMode -- but the message-assembly
// layer legitimately does now.
// ---------------------------------------------------------------------------
test("lib/prompts/racer.ts: CORE_RACER_RULES (the decision block) and the guess-intent disambiguation path stay mode-independent", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  const rulesAt = src.indexOf("export const CORE_RACER_RULES");
  const rulesBlock = src.slice(rulesAt, src.indexOf("export const LAYER_TWO_SHARED_RULES"));
  assert.doesNotMatch(rulesBlock, /experienceMode|ExperienceMode/, "the byte-verified decision block must stay mode-independent");

  const intentAt = src.indexOf("export function buildGuessIntentMessage");
  const intentFn = src.slice(intentAt, intentAt + 1200);
  assert.doesNotMatch(intentFn, /experienceMode|ExperienceMode/, "the guess-intent disambiguation path carries no tone framing");
});

test("lib/prompts/racer.ts: mode tone is confined to buildRacerTurnMessage's message assembly, never inside turnInputSchema (the model's move contract)", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  const schemaAt = src.indexOf("function turnInputSchema");
  const schemaFn = src.slice(schemaAt, schemaAt + 4000);
  assert.doesNotMatch(schemaFn, /experienceMode|ExperienceMode/, "the schema the model must satisfy stays mode-independent");
});

test("lib/prompts/composerTarget.ts (target choice) never accepts an experienceMode parameter -- target selection is unrelated to tone", () => {
  const src = readFileSync("lib/prompts/composerTarget.ts", "utf8");
  assert.doesNotMatch(src, /experienceMode|ExperienceMode/);
});

// ---------------------------------------------------------------------------
// Client-side gating: GameClient.tsx's AI-Racer clue request, and
// HumanClient.tsx's voluntary hint. Both proven from source, matching this
// codebase's established convention (no rendering harness exists).
// ---------------------------------------------------------------------------

test("GameClient.tsx: the AI-Racer clue-request UI is explicitly hidden for Competitive, not merely relying on it never firing", () => {
  const src = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
  assert.match(src, /\{clueWanted && game\.experience_mode !== "competitive" && \(/);
});

test("HumanClient.tsx: hintAvailable is unconditional for a legacy game, and mode+credit-gated otherwise", () => {
  const src = readFileSync("app/game/[id]/HumanClient.tsx", "utf8");
  const fn = src.slice(src.indexOf("const hintAvailable ="), src.indexOf("const hintAvailable =") + 400);
  assert.match(fn, /view\.experience_mode === null\s*\n\s*\? true/);
  assert.match(fn, /view\.experience_mode !== "competitive" && view\.hint_credits_available > 0/);
  assert.match(src, /\{live && iAmComposer && hintAvailable && \(/, "the hint block itself must read the gate");
});
