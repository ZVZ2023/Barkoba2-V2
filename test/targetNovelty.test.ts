import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as createPOST } from "../app/api/game/create/route";
import { getGame } from "../lib/gameStore";
import { recentAiComposerTargets } from "../lib/corpus/gameCorpus";
import {
  isExactNormalizedRepeat,
  normalizeTargetForNoveltyCheck,
  MAX_TARGET_NOVELTY_ATTEMPTS,
  RECENT_AI_TARGET_LIMIT,
} from "../lib/targetNovelty";
import { __setSqlClientForTests, type SqlClient } from "../lib/corpus/db";
import { enableTestIdentityLookups, testPlayerId } from "./helpers/testIdentity";

enableTestIdentityLookups();
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.RATE_LIMIT_DISABLED = "true";

// ---------------------------------------------------------------------------
// V2.8.8 SLICE 4 — AI-target novelty and bounded retry.
//
// Field problem: the AI Setter repeatedly chose "dog." Covers: latest-15
// bound, exact normalized repeat rejection, the structured-contract
// exclusion instruction, one-retry maximum, history-query failure treated
// distinctly from genuinely empty history, no fixed fallback, and no
// secret-candidate leakage to the client on a rejected/repeated attempt.
// ---------------------------------------------------------------------------

const PLAYER = testPlayerId("9");
const COMPOSER_TARGET_SRC = readFileSync("lib/prompts/composerTarget.ts", "utf8");
const CREATE_ROUTE_SRC = readFileSync("app/api/game/create/route.ts", "utf8");

// ---------------------------------------------------------------------------
// The pure classifier: exact repeats only, never a translation/variant.
// ---------------------------------------------------------------------------

test("isExactNormalizedRepeat: catches an exact, case/whitespace-only repeat", () => {
  assert.equal(isExactNormalizedRepeat("dog", ["dog"]), true);
  assert.equal(isExactNormalizedRepeat("  Dog ", ["dog"]), true);
  assert.equal(isExactNormalizedRepeat("A DOG", ["a dog"]), true);
});

test("isExactNormalizedRepeat: does NOT catch a translation, synonym, or unrelated target -- that is the model's own job, not this function's", () => {
  assert.equal(isExactNormalizedRepeat("kutya", ["dog"]), false, "cross-language is model-enforced only");
  assert.equal(isExactNormalizedRepeat("puppy", ["dog"]), false, "a near-synonym is model-enforced only");
  assert.equal(isExactNormalizedRepeat("bicycle", ["dog"]), false);
});

test("isExactNormalizedRepeat: an empty exclusion list never matches anything", () => {
  assert.equal(isExactNormalizedRepeat("dog", []), false);
});

test("constants match the approved decisions: latest 15, at most one retry (two attempts total)", () => {
  assert.equal(RECENT_AI_TARGET_LIMIT, 15);
  assert.equal(MAX_TARGET_NOVELTY_ATTEMPTS, 2);
});

// ---------------------------------------------------------------------------
// V2.8.8 COMPLETION — normalization strengthened beyond case/whitespace.
// The approved requirement: trivial FORMATTING variants must collide
// mechanically. Every example from the completion ticket, checked directly
// against the normalizer and end-to-end through isExactNormalizedRepeat.
// ---------------------------------------------------------------------------

test("normalizeTargetForNoveltyCheck: case folding", () => {
  assert.equal(normalizeTargetForNoveltyCheck("Dog"), normalizeTargetForNoveltyCheck("dog"));
  assert.equal(normalizeTargetForNoveltyCheck("DOG"), normalizeTargetForNoveltyCheck("dog"));
});

test("normalizeTargetForNoveltyCheck: trailing/leading punctuation does not defeat the match", () => {
  assert.equal(normalizeTargetForNoveltyCheck("dog."), normalizeTargetForNoveltyCheck("dog"));
  assert.equal(normalizeTargetForNoveltyCheck("dog!"), normalizeTargetForNoveltyCheck("dog"));
  assert.equal(normalizeTargetForNoveltyCheck("\"dog\""), normalizeTargetForNoveltyCheck("dog"));
});

test("normalizeTargetForNoveltyCheck: leading/trailing and repeated internal whitespace", () => {
  assert.equal(normalizeTargetForNoveltyCheck("  dog  "), normalizeTargetForNoveltyCheck("dog"));
  assert.equal(normalizeTargetForNoveltyCheck("a   dog"), normalizeTargetForNoveltyCheck("a dog"));
});

test("normalizeTargetForNoveltyCheck: combined capitalization AND punctuation variant", () => {
  assert.equal(normalizeTargetForNoveltyCheck("  DOG!  "), normalizeTargetForNoveltyCheck("dog"));
});

test("normalizeTargetForNoveltyCheck: Unicode-normalized diacritic variants collide (combining marks stripped)", () => {
  assert.equal(normalizeTargetForNoveltyCheck("kávé"), normalizeTargetForNoveltyCheck("kave"));
  assert.equal(normalizeTargetForNoveltyCheck("Kávé."), normalizeTargetForNoveltyCheck("kave"));
  // Hungarian's own double-acute-accent letters decompose into the same
  // Combining Diacritical Marks block (U+0300-U+036F) as an ordinary acute
  // accent, so this is not a Latin-only special case.
  assert.equal(normalizeTargetForNoveltyCheck("őz"), normalizeTargetForNoveltyCheck("oz"));
});

test("normalizeTargetForNoveltyCheck: still never folds a genuinely different word into another", () => {
  assert.notEqual(normalizeTargetForNoveltyCheck("dog"), normalizeTargetForNoveltyCheck("cat"));
  // Cross-language and synonym equivalence remain OUT of scope for this
  // mechanical function -- model-enforced only, per composerTarget.ts.
  assert.notEqual(normalizeTargetForNoveltyCheck("dog"), normalizeTargetForNoveltyCheck("kutya"));
});

test("isExactNormalizedRepeat: end-to-end with the strengthened normalizer -- every required example collides", () => {
  assert.equal(isExactNormalizedRepeat("Dog", ["dog"]), true);
  assert.equal(isExactNormalizedRepeat("dog", ["dog."]), true);
  assert.equal(isExactNormalizedRepeat("  dog  ", ["dog"]), true);
  assert.equal(isExactNormalizedRepeat("DOG!", ["dog"]), true);
  assert.equal(isExactNormalizedRepeat("kávé", ["kave"]), true);
  assert.equal(isExactNormalizedRepeat("Kávé.", ["  kave  "]), true);
});

test("isExactNormalizedRepeat: semantic equivalence is still honestly NOT caught -- unchanged limitation", () => {
  assert.equal(isExactNormalizedRepeat("kutya", ["dog"]), false, "cross-language is model-enforced only");
  assert.equal(isExactNormalizedRepeat("puppy", ["dog"]), false, "a near-synonym is model-enforced only");
});

// ---------------------------------------------------------------------------
// The structured-contract instruction: the schema REQUIRES an explicit
// avoided_recent_targets acknowledgment, and the prompt lists exclusions
// when given.
// ---------------------------------------------------------------------------

test("lib/prompts/composerTarget.ts: the schema requires avoided_recent_targets, and the prompt lists exclusions with translation/variant guidance when given", () => {
  assert.match(COMPOSER_TARGET_SRC, /avoided_recent_targets/);
  assert.match(
    COMPOSER_TARGET_SRC,
    /required: \["reasoning", "target", "definition", "granularity", "modifiers", "avoided_recent_targets"\]/
  );
  assert.match(COMPOSER_TARGET_SRC, /EXCLUDED TARGETS/);
  assert.match(COMPOSER_TARGET_SRC, /a direct translation, a trivial singular\/plural or spelling variant/);
});

test("lib/prompts/composerTarget.ts: the literal 'a dog' example is gone from the EASY guidance", () => {
  const guidanceAt = COMPOSER_TARGET_SRC.indexOf("easy: `EASY");
  const guidanceBlock = COMPOSER_TARGET_SRC.slice(guidanceAt, guidanceAt + 500);
  assert.doesNotMatch(guidanceBlock, /\ba dog\b/i);
});

// ---------------------------------------------------------------------------
// recentAiComposerTargets: history-query FAILURE is distinct from genuinely
// empty history.
// ---------------------------------------------------------------------------

test("recentAiComposerTargets: a genuinely new player (no rows) is ok:true with an empty list -- not a failure", async () => {
  const result = await recentAiComposerTargets(testPlayerId("8"), RECENT_AI_TARGET_LIMIT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, []);
});

test("recentAiComposerTargets: a CONFIGURED corpus whose query throws is ok:false -- never silently treated as empty history", async () => {
  const broken: SqlClient = Object.assign(
    async (): Promise<Record<string, unknown>[]> => {
      throw new Error("simulated corpus outage");
    },
    { transaction: async (qs: Promise<Record<string, unknown>[]>[]) => Promise.all(qs) }
  );
  __setSqlClientForTests(broken);
  try {
    const result = await recentAiComposerTargets(PLAYER, RECENT_AI_TARGET_LIMIT);
    assert.equal(result.ok, false, "a real query failure must never report ok:true");
    assert.deepEqual(result.targets, []);
  } finally {
    // Restore the working NOOP client every other test in this process
    // (and every test file after it, per enableTestIdentityLookups' own
    // per-process scope) expects.
    enableTestIdentityLookups();
  }
});

// ---------------------------------------------------------------------------
// End-to-end game creation: bounded retry succeeds on the second attempt;
// exhaustion fails explicitly, never with a fixed fallback; no secret
// candidate ever reaches the client response.
// ---------------------------------------------------------------------------

function stubComposerTargetQueue(targets: string[]): { restore: () => void; callCount: () => number } {
  const original = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    const target = targets[calls];
    calls += 1;
    if (target === undefined) throw new Error("unexpected extra composer-target call in test");
    return {
      ok: true,
      json: async () => ({
        model: "claude-mock",
        content: [
          {
            type: "tool_use",
            name: "submit_target",
            input: {
              reasoning: "fits the difficulty",
              target,
              granularity: "generic_type",
              modifiers: null,
              definition: `a ${target}`,
              avoided_recent_targets: true,
            },
          },
        ],
      }),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
  return { restore: () => { global.fetch = original; }, callCount: () => calls };
}

function createReq(body: Record<string, unknown>, playerId: string) {
  return new NextRequest("http://localhost/api/game/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bk-player": playerId },
    body: JSON.stringify(body),
  });
}

async function callCreate(body: Record<string, unknown>, playerId: string) {
  const res = await createPOST(createReq(body, playerId));
  return { status: res.status, data: await res.json() };
}

/** A SQL client whose queries all return one fixed row shape -- enough to drive recentAiComposerTargets to a non-empty, controlled exclusion list. */
function fixedRowSqlClient(rows: Record<string, unknown>[]): SqlClient {
  return Object.assign(
    async (): Promise<Record<string, unknown>[]> => rows,
    { transaction: async (qs: Promise<Record<string, unknown>[]>[]) => Promise.all(qs) }
  );
}

test("a repeated candidate on attempt 1 is silently regenerated -- game creation succeeds using the SECOND (compliant) target, and the FIRST (rejected) candidate never reaches the client", async () => {
  const player = testPlayerId("7");
  __setSqlClientForTests(fixedRowSqlClient([{ target: "dog" }]));
  const stub = stubComposerTargetQueue(["dog", "bicikli"]);
  try {
    const created = await callCreate({ mode: "ai_composer", difficulty: "medium" }, player);
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal(stub.callCount(), 2, "the repeated first candidate must trigger exactly one retry");
    assert.ok(await getGame(created.data.game_id), "the game was actually created, using the second (compliant) candidate");
    // Never leaked, at any point: the rejected candidate's own text does
    // not appear anywhere in the JSON response.
    assert.doesNotMatch(JSON.stringify(created.data), /\bdog\b/);
  } finally {
    stub.restore();
    enableTestIdentityLookups();
  }
});

test("bounded retry: exhausting MAX_TARGET_NOVELTY_ATTEMPTS (2) attempts against a NON-empty exclusion list fails explicitly with composer_target_repeated -- never a fixed fallback, and the repeated candidate never reaches the client", async () => {
  const player = testPlayerId("6");
  __setSqlClientForTests(fixedRowSqlClient([{ target: "dog" }]));
  // The model repeats "dog" on EVERY attempt -- both attempts must be spent,
  // and creation must then fail explicitly rather than accept the repeat.
  const stub = stubComposerTargetQueue(["dog", "dog"]);
  try {
    const created = await callCreate({ mode: "ai_composer", difficulty: "medium" }, player);
    assert.equal(created.status, 502);
    assert.equal(created.data.error, "composer_target_repeated");
    assert.equal(stub.callCount(), MAX_TARGET_NOVELTY_ATTEMPTS, "must stop at exactly the bounded limit, not loop further");
    assert.doesNotMatch(JSON.stringify(created.data), /\bdog\b/, "the repeated candidate's own text must never reach the client");
  } finally {
    stub.restore();
    enableTestIdentityLookups();
  }
});

test("SOURCE: the retry loop is bounded by MAX_TARGET_NOVELTY_ATTEMPTS, extends the NEXT attempt's own exclusion list with each rejected candidate, and never returns a rejected candidate to the client", () => {
  const loopAt = CREATE_ROUTE_SRC.indexOf("for (let attempt = 1; attempt <= MAX_TARGET_NOVELTY_ATTEMPTS");
  assert.ok(loopAt > 0);
  const loop = CREATE_ROUTE_SRC.slice(loopAt, loopAt + 2500);
  assert.match(loop, /isExactNormalizedRepeat\(candidate\.target, excludedTargets\)/);
  assert.match(loop, /attemptExclusions = \[\.\.\.attemptExclusions, candidate\.target\];/);
  assert.match(loop, /console\.warn\(/, "a rejected candidate must be logged server-side (never returned to the client)");
});

test("SOURCE: an unreadable novelty history (ok:false) refuses creation with a retryable, localized error -- never silently proceeds as though the player had no history", () => {
  const at = CREATE_ROUTE_SRC.indexOf("if (!noveltyLookup.ok)");
  assert.ok(at > 0);
  const block = CREATE_ROUTE_SRC.slice(at, at + 400);
  assert.match(block, /error: "novelty_history_unavailable"/);
  assert.match(block, /status: 503/);
});

test("SOURCE: a null playerId (identity unresolved) is treated as no-history, never as a lookup failure -- there is no stable identity to protect novelty for", () => {
  assert.match(
    CREATE_ROUTE_SRC,
    /const noveltyLookup = playerId\s*\n\s*\? await recentAiComposerTargets\(playerId, RECENT_AI_TARGET_LIMIT\)\s*\n\s*: \{ ok: true, targets: \[\] as string\[\] \};/
  );
});
