import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resetSamplingParamCache } from "../lib/anthropic";
import { IntegrityReviewIncompleteError, runIntegrityReview } from "../lib/prompts/integrityReview";

// ---------------------------------------------------------------------------
// V2.8.4.3 — the "PC" incident: a completed Integrity Review (verdict
// "upheld") persisted with integrity_notes === "", and the result screen's
// old `{game.integrity_notes && (...)}` guard then hid the whole section, so
// the game looked like it had never been reviewed at all even though one had
// genuinely run.
//
// Hermetic — same pattern as test/anthropicSampling.test.ts: globalThis.fetch
// is stubbed, so runIntegrityReview() runs its REAL code end to end (no
// network, no key, no cost) against a fake Anthropic tool_use response.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetSamplingParamCache();
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = realFetch;
});

function stubAnthropicOnce(input: Record<string, unknown>) {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "tool_use", input }] }),
  })) as unknown as typeof fetch;
}

const PARAMS = {
  target: "PC",
  privateClarification: "As a Personal Computer",
  qaLog: [
    {
      id: "1",
      turn_index: 6,
      turn_type: "question" as const,
      question_text: "Fémből készült?",
      composer_response: "YES" as const,
      guess_text: null,
      ambiguous_explanation: null,
      racer_output_raw: "",
      guess_detector_flagged: false,
      guess_detector_method: null,
      guess_intent_outcome: null,
      clue_text: null,
      original_question_text: null,
      edit_status: null,
      edit_reason: null,
      ambiguous_consumed_credit: false,
      timestamp: new Date().toISOString(),
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
    },
  ],
  gameLanguage: "hu" as const,
};

// --- 8: a newly generated review must have non-empty reasoning ------------

test("8. an empty reasoning string is rejected, not silently persisted", async () => {
  stubAnthropicOnce({ reasoning: "", verdict: "upheld", contradicting_turns: [] });
  await assert.rejects(() => runIntegrityReview(PARAMS), IntegrityReviewIncompleteError);
});

test("8b. a whitespace-only reasoning string is rejected the same way", async () => {
  stubAnthropicOnce({ reasoning: "   \n  ", verdict: "upheld", contradicting_turns: [] });
  await assert.rejects(() => runIntegrityReview(PARAMS), IntegrityReviewIncompleteError);
});

test("8c. a review with real reasoning succeeds and is trimmed", async () => {
  stubAnthropicOnce({
    reasoning: "  A YES a szerszám kérdésre félrevezető volt.  ",
    verdict: "upheld",
    contradicting_turns: [],
  });
  const result = await runIntegrityReview(PARAMS);
  assert.equal(result.reasoning, "A YES a szerszám kérdésre félrevezető volt.");
  assert.equal(result.verdict, "upheld");
});

test("a missing reasoning field is treated the same as an empty one", async () => {
  stubAnthropicOnce({ verdict: "upheld", contradicting_turns: [] });
  await assert.rejects(() => runIntegrityReview(PARAMS), IntegrityReviewIncompleteError);
});

// --- 9 & 10: display honesty, verified from source (no rendering harness) -

const RESULT_PANEL = readFileSync("app/game/[id]/ResultPanel.tsx", "utf8");
const RESOLVE_ROUTE = readFileSync("app/api/game/[id]/resolve/route.ts", "utf8");

test("9. the review section keys off the explicit verdict, not the truthiness of the notes string", () => {
  // The gate that decides whether the WHOLE section renders at all.
  assert.match(RESULT_PANEL, /\{game\.integrity_verdict !== null && \(/);
  assert.doesNotMatch(
    RESULT_PANEL,
    /\{game\.integrity_notes && \(\n/,
    "must not have regressed to gating the whole section on the prose string's truthiness " +
      "(the file's own explanatory comment mentions the old, single-line `{game.integrity_notes && " +
      "(...)}` shape in prose — this regex requires the real multi-line JSX form, not that comment)"
  );
  // The inline choice of WHAT TEXT to show inside that gate is legitimately
  // allowed to still check the string — that is the fallback logic itself,
  // not the section's visibility.
  assert.match(
    RESULT_PANEL,
    /game\.integrity_notes && game\.integrity_notes\.trim\(\)\.length > 0\s*\n?\s*\? game\.integrity_notes\s*\n?\s*: integrityFallbackNotice/
  );
});

test("9b. blank legacy notes render an honest fallback notice instead of nothing", () => {
  assert.match(RESULT_PANEL, /integrityFallbackNotice/);
  assert.match(RESULT_PANEL, /Az ellenőrzés befejeződött, de részletes indoklás nem érkezett\./);
  assert.match(RESULT_PANEL, /The review completed, but no detailed explanation was received\./);
});

test("10. an unavailable/incomplete review cannot reach the result screen's 'passed' copy — it never leaves phase 'resolving'", () => {
  // integrity_review_unavailable is returned BEFORE game.phase is ever set to
  // "complete" and before game.result is ever assigned (see the early
  // `return NextResponse.json(...)` inside the retry loop's failure branch) —
  // so ResultPanel's `game.phase !== "complete" || !game.result` guard means
  // no HEADLINE/SUBHEAD text, "passed" included, can ever render for it.
  const failureBlock = RESOLVE_ROUTE.slice(
    RESOLVE_ROUTE.indexOf("if (needsIntegrityReview("),
    RESOLVE_ROUTE.indexOf("// ---", RESOLVE_ROUTE.indexOf("if (needsIntegrityReview("))
  );
  assert.match(failureBlock, /error: "integrity_review_unavailable"/);
  assert.doesNotMatch(failureBlock, /game\.phase = "complete"/);
  assert.doesNotMatch(failureBlock, /game\.result = /);
});

test("10b. the retry loop exists, is bounded, and retries only an incomplete review — not a genuine transport failure", () => {
  assert.match(RESOLVE_ROUTE, /IntegrityReviewIncompleteError/);
  assert.match(RESOLVE_ROUTE, /MAX_INTEGRITY_REVIEW_ATTEMPTS = 2/);
  assert.match(RESOLVE_ROUTE, /const incomplete = err instanceof IntegrityReviewIncompleteError/);
  assert.match(RESOLVE_ROUTE, /if \(incomplete && attempt < MAX_INTEGRITY_REVIEW_ATTEMPTS\)/);
});

// --- 11: Hungarian lexical interpretation + materiality, in the prompt ----

const INTEGRITY_SRC = readFileSync("lib/prompts/integrityReview.ts", "utf8");

test("11. the prompt states a general lexical-breadth principle, illustrated with szerszám/eszköz, not hardcoded to PC", () => {
  assert.match(INTEGRITY_SRC, /LEXICAL CONTEXT ACROSS LANGUAGES/);
  assert.match(INTEGRITY_SRC, /"szerszám" ordinarily names a traditional, hand-operated or mechanical tool/);
  assert.match(INTEGRITY_SRC, /"eszköz" is the broader word for a device or instrument in general/);
  assert.match(
    INTEGRITY_SRC,
    /Answering YES to whether a computer is a "szerszám" is a candidate for INCORRECT/
  );
  assert.match(
    INTEGRITY_SRC,
    /a general principle about lexical breadth.*never a rule about computers, tools, or Hungarian specifically/s
  );
});

test("11b. the lexical-breadth principle still routes through classification and materiality, never a shortcut to a verdict", () => {
  const section = INTEGRITY_SRC.slice(
    INTEGRITY_SRC.indexOf("LEXICAL CONTEXT ACROSS LANGUAGES"),
    INTEGRITY_SRC.indexOf("OPTIONAL NOTES ARE CONTEXT")
  );
  assert.match(section, /a candidate for INCORRECT/, "must stay a STEP 1 candidate, not an automatic verdict");
  assert.match(section, /STEP 2's materiality test/);
});

// --- 12: IS-IS alone remains insufficient (unchanged plumbing, reaffirmed) -

test("12. IS-IS-only disputes still cannot produce a violation — the pre-existing rule is untouched by the lexical-context addition", () => {
  assert.match(
    INTEGRITY_SRC,
    /Never award a violation, in whole or in part, because an IS-IS answer existed/
  );
  assert.match(
    INTEGRITY_SRC,
    /materiality analysis under STEP 2 applies only to answers you classified INCORRECT, never to AMBIGUOUS ones/
  );
});
