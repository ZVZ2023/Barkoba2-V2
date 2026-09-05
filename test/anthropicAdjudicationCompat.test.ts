import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  callAnthropicTool,
  AnthropicRefusalError,
  isForcedToolChoiceRejection,
  readAnthropicUsage,
  requestModeFor,
  resetSamplingParamCache,
  responseContractInstruction,
  type AnthropicCallObservation,
} from "../lib/anthropic";
import { AdjudicationInvalidOutputError, runAdjudicator } from "../lib/prompts/adjudicator";
import {
  IntegrityReviewIncompleteError,
  IntegrityReviewInvalidOutputError,
  runIntegrityReview,
} from "../lib/prompts/integrityReview";

// ---------------------------------------------------------------------------
// V2.8.7 — the adjudication seats on Claude Fable 5.1.
//
// Hermetic: globalThis.fetch is stubbed. Covers the one provider-specific
// fact that blocked a plain model swap — Fable 5.1 rejects forced tool
// choice — and everything Astra required around it:
//   - option 1: auto + strict schema + explicit response-contract instruction,
//     learned per model at runtime, forced mode byte-identical otherwise;
//   - the returned tool NAME and verdict payload are validated; missing,
//     malformed or ambiguous output is an explicit failure, never a verdict;
//   - stop_reason "refusal" is an explicit failure: no fallback model, no
//     retry, no inferred verdict — and its billed usage is still observed;
//   - effort goes out as output_config.effort; usage comes back normalised.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

const FORCED_TOOL_400 = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: 'tool_choice: type "tool" and "any" are not supported for this model.',
  },
});

interface Sent {
  body: Record<string, unknown>;
}

function stubAnthropic(opts: {
  rejectForced?: boolean;
  reply?: (body: Record<string, unknown>) => unknown;
}): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push({ body });
    const toolChoice = body.tool_choice as { type: string };
    if (opts.rejectForced && toolChoice.type === "tool") {
      return { ok: false, status: 400, text: async () => FORCED_TOOL_400 };
    }
    const toolName = (body.tools as Array<{ name: string }>)[0]!.name;
    const reply = opts.reply
      ? opts.reply(body)
      : {
          model: "claude-fable-5-1",
          stop_reason: "tool_use",
          usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 },
          content: [{ type: "tool_use", name: toolName, input: { reasoning: "ok", verdict: "correct", confidence: 0.9 } }],
        };
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  }) as unknown as typeof fetch;
  return sent;
}

// A model NOT on the known-rejecting list, so the forced-mode path and the
// runtime self-heal can be exercised; Fable itself is tested separately below.
const CALL = {
  model: "claude-future-model",
  system: "JUDGE RULES",
  messages: [{ role: "user" as const, content: "case" }],
  toolName: "submit_adjudication",
  toolDescription: "d",
  inputSchema: {
    type: "object",
    properties: { reasoning: { type: "string" }, verdict: { type: "string", enum: ["correct", "incorrect"] }, confidence: { type: "number" } },
    required: ["reasoning", "verdict", "confidence"],
  },
  temperature: 0,
  effort: "low",
};

beforeEach(() => {
  resetSamplingParamCache();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_MODEL_ADJUDICATION;
  delete process.env.ANTHROPIC_EFFORT_ADJUDICATION;
  delete process.env.ANTHROPIC_MODEL_INTEGRITY_REVIEW;
  delete process.env.ANTHROPIC_EFFORT_INTEGRITY_REVIEW;
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Recognising the rejection — narrow on purpose.
// ---------------------------------------------------------------------------

test("recognises a forced-tool-choice rejection and nothing else", () => {
  assert.equal(isForcedToolChoiceRejection(400, FORCED_TOOL_400), true);
  assert.equal(isForcedToolChoiceRejection(400, "tool_choice: unsupported on this model"), true);
  assert.equal(isForcedToolChoiceRejection(400, "tool_choice: must be an object"), false, "a malformed tool_choice is a real bug");
  assert.equal(isForcedToolChoiceRejection(400, "temperature is not supported"), false);
  assert.equal(isForcedToolChoiceRejection(401, FORCED_TOOL_400), false);
  assert.equal(isForcedToolChoiceRejection(500, FORCED_TOOL_400), false);
});

// ---------------------------------------------------------------------------
// Option 1 — auto + strict + instruction, learned per model.
// ---------------------------------------------------------------------------

test("FORCED MODE UNCHANGED: a model that accepts forced tool choice gets the exact pre-V2.8.7 request plus output_config.effort", async () => {
  const sent = stubAnthropic({});
  await callAnthropicTool(CALL);
  assert.equal(sent.length, 1);
  const body = sent[0]!.body;
  assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_adjudication" });
  assert.equal(body.system, "JUDGE RULES", "no instruction is appended in forced mode");
  const tool = (body.tools as Array<Record<string, unknown>>)[0]!;
  assert.equal("strict" in tool, false);
  assert.deepEqual(tool.input_schema, CALL.inputSchema, "the schema is untouched in forced mode");
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal(requestModeFor("claude-future-model"), "forced_tool");
});

test("KNOWN MODEL: Claude Fable 5.1 opens DIRECTLY in auto+strict mode — no unsupported forced request is ever sent", async () => {
  assert.equal(requestModeFor("claude-fable-5-1"), "auto_strict_tool");
  assert.equal(requestModeFor("claude-fable-5-1-20260901"), "auto_strict_tool", "dated snapshots match by prefix");
  assert.equal(requestModeFor("claude-sonnet-5"), "forced_tool", "unrelated models are untouched");

  const sent = stubAnthropic({ rejectForced: true });
  const observed: AnthropicCallObservation[] = [];
  await callAnthropicTool({ ...CALL, model: "claude-fable-5-1", onCallObserved: (o) => observed.push(o) });
  assert.equal(sent.length, 1, "exactly one request, and it is the auto+strict one");
  assert.deepEqual(sent[0]!.body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
  assert.equal((sent[0]!.body.tools as Array<Record<string, unknown>>)[0]!.strict, true);
  assert.match(String(sent[0]!.body.system), /RESPONSE CONTRACT/);
  assert.equal(observed[0]!.requestMode, "auto_strict_tool");
});

test("on the forced-tool-choice 400, retries ONCE in auto+strict mode with the response contract, then learns the model", async () => {
  const sent = stubAnthropic({ rejectForced: true });
  const observed: AnthropicCallObservation[] = [];
  const result = await callAnthropicTool<{ verdict: string }>({ ...CALL, onCallObserved: (o) => observed.push(o) });

  assert.equal(result.verdict, "correct");
  assert.equal(sent.length, 2, "expected the forced attempt then ONE auto+strict retry");
  const forced = sent[0]!.body;
  const auto = sent[sent.length - 1]!.body;

  assert.deepEqual(forced.tool_choice, { type: "tool", name: "submit_adjudication" });
  assert.deepEqual(auto.tool_choice, { type: "auto", disable_parallel_tool_use: true });

  const autoTool = (auto.tools as Array<Record<string, unknown>>)[0]!;
  assert.equal(autoTool.strict, true);
  assert.deepEqual(autoTool.input_schema, { ...CALL.inputSchema, additionalProperties: false });

  assert.equal(auto.system, "JUDGE RULES" + responseContractInstruction("submit_adjudication"));
  assert.match(String(auto.system), /calling the `submit_adjudication` tool exactly once/);
  // Everything else about the task is identical.
  assert.deepEqual(auto.messages, forced.messages);
  assert.equal(auto.model, forced.model);
  assert.deepEqual(auto.output_config, forced.output_config);

  assert.equal(observed.length, 1, "only the successful 200 is observed; a rejected 400 is not billed");
  assert.equal(observed[0]!.requestMode, "auto_strict_tool");
  assert.equal(observed[0]!.effort, "low");
  assert.equal(requestModeFor("claude-future-model"), "auto_strict_tool");

  // Learned: the next call for this model goes straight to auto mode.
  const again = stubAnthropic({ rejectForced: true });
  await callAnthropicTool(CALL);
  assert.equal(again.length, 1, "no wasted forced attempt once the model is known");
  assert.deepEqual(again[0]!.body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
});

test("the learned mode is per model: another model still opens in forced mode", async () => {
  stubAnthropic({ rejectForced: true });
  await callAnthropicTool(CALL);
  assert.equal(requestModeFor("claude-future-model"), "auto_strict_tool");
  assert.equal(requestModeFor("claude-sonnet-5"), "forced_tool");
});

test("a genuine 400 is still thrown, not retried away, in either mode", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: false, status: 400, text: async () => "max_tokens: must be greater than 0" };
  }) as unknown as typeof fetch;
  await assert.rejects(() => callAnthropicTool(CALL), /max_tokens/);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Validation of what comes back — in both modes.
// ---------------------------------------------------------------------------

test("under auto mode a prose answer with no tool call is an explicit failure", async () => {
  stubAnthropic({
    rejectForced: true,
    reply: () => ({ model: "claude-fable-5-1", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "I think it is correct." }] }),
  });
  await assert.rejects(() => callAnthropicTool(CALL), /did not return a tool_use block for submit_adjudication.*request_mode=auto_strict_tool/);
});

test("a tool_use block for the WRONG tool is refused, and the returned name is reported", async () => {
  stubAnthropic({
    reply: () => ({ model: "claude-fable-5-1", stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: "other_tool", input: { verdict: "correct" } }] }),
  });
  await assert.rejects(() => callAnthropicTool(CALL), /did not return a tool_use block for submit_adjudication \(returned: other_tool\)/);
});

test("a non-object tool input is refused", async () => {
  stubAnthropic({
    reply: (body) => ({ model: "claude-fable-5-1", stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: (body.tools as Array<{ name: string }>)[0]!.name, input: "correct" }] }),
  });
  await assert.rejects(() => callAnthropicTool(CALL), /non-object input/);
});

// ---------------------------------------------------------------------------
// Refusal — explicit failure, billed usage observed, no fallback, no retry.
// ---------------------------------------------------------------------------

test("stop_reason 'refusal' throws AnthropicRefusalError after observing usage; no retry, no substitute model", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const reply = {
      model: "claude-fable-5-1",
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber" },
      usage: { input_tokens: 700, output_tokens: 9 },
      content: [],
    };
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  }) as unknown as typeof fetch;

  const observed: AnthropicCallObservation[] = [];
  await assert.rejects(
    () => callAnthropicTool({ ...CALL, onCallObserved: (o) => observed.push(o) }),
    (err: unknown) => err instanceof AnthropicRefusalError && err.category === "cyber" && /No fallback model/.test(err.message)
  );
  assert.equal(calls, 1, "a refusal is never retried");
  assert.equal(observed.length, 1, "the (possibly billed) refusal is observed");
  assert.equal(observed[0]!.stopReason, "refusal");
  assert.equal(observed[0]!.usage.input_tokens, 700);
  assert.equal(observed[0]!.usage.output_tokens, 9);
});

// ---------------------------------------------------------------------------
// Usage normalisation.
// ---------------------------------------------------------------------------

test("Anthropic usage maps one-to-one and unreported figures stay null", () => {
  assert.deepEqual(
    readAnthropicUsage({ input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 }),
    { input_tokens: 900, cached_input_tokens: 300, cache_write_input_tokens: 50, output_tokens: 120, reasoning_tokens: null }
  );
  assert.deepEqual(readAnthropicUsage(undefined), {
    input_tokens: null, cached_input_tokens: null, cache_write_input_tokens: null, output_tokens: null, reasoning_tokens: null,
  });
});

// ---------------------------------------------------------------------------
// The two adjudication seats, end to end through their real functions.
// ---------------------------------------------------------------------------

const ADJ = { target: "fogantyú", privateClarification: "", guess: "fogantyút", gameLanguage: "hu" as const };
const REVIEW = { target: "PC", privateClarification: "", qaLog: [], gameLanguage: "hu" as const };

test("runAdjudicator uses the adjudication model at low effort, opens in auto+strict mode, and reports its observation", async () => {
  const sent = stubAnthropic({ rejectForced: true });
  const observed: AnthropicCallObservation[] = [];
  const r = await runAdjudicator({ ...ADJ, onCallObserved: (o) => observed.push(o) });
  assert.equal(sent.length, 1, "no forced attempt for the known Fable seat");
  assert.equal(sent[0]!.body.model, "claude-fable-5-1");
  assert.deepEqual(sent[0]!.body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
  assert.deepEqual(sent[0]!.body.output_config, { effort: "low" });
  assert.equal(r.verdict, "correct");
  assert.equal(observed[0]!.resolvedModel, "claude-fable-5-1");
  assert.equal(observed[0]!.usage.cached_input_tokens, 300);
});

test("the adjudication model and effort are environment-configurable, separately from modelStrong", async () => {
  process.env.ANTHROPIC_MODEL_ADJUDICATION = "claude-sonnet-5";
  process.env.ANTHROPIC_EFFORT_ADJUDICATION = "medium";
  const sent = stubAnthropic({});
  await runAdjudicator(ADJ);
  assert.equal(sent[0]!.body.model, "claude-sonnet-5");
  assert.deepEqual(sent[0]!.body.output_config, { effort: "medium" });
});

test("runAdjudicator refuses a verdict outside {correct, incorrect} instead of coercing it", async () => {
  stubAnthropic({
    reply: (body) => ({ model: "m", stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: (body.tools as Array<{ name: string }>)[0]!.name, input: { reasoning: "hmm", verdict: "partially", confidence: 0.5 } }] }),
  });
  await assert.rejects(() => runAdjudicator(ADJ), AdjudicationInvalidOutputError);
});

test("runAdjudicator refuses a verdict with no reasoning", async () => {
  stubAnthropic({
    reply: (body) => ({ model: "m", stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: (body.tools as Array<{ name: string }>)[0]!.name, input: { reasoning: "   ", verdict: "correct", confidence: 1 } }] }),
  });
  await assert.rejects(() => runAdjudicator(ADJ), AdjudicationInvalidOutputError);
});

test("runAdjudicator surfaces a refusal as AnthropicRefusalError — never a verdict", async () => {
  stubAnthropic({
    reply: () => ({ model: "m", stop_reason: "refusal", stop_details: { category: null }, usage: { input_tokens: 5, output_tokens: 0 }, content: [] }),
  });
  await assert.rejects(() => runAdjudicator(ADJ), AnthropicRefusalError);
});

test("runIntegrityReview uses the adjudication model at low effort; a malformed verdict is an invalid-output failure, not a retryable incomplete one", async () => {
  const sent = stubAnthropic({
    reply: (body) => ({ model: "claude-fable-5-1", stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: (body.tools as Array<{ name: string }>)[0]!.name, input: { reasoning: "ok", verdict: "upheld", contradicting_turns: [] } }] }),
  });
  const r = await runIntegrityReview(REVIEW);
  assert.equal(r.verdict, "upheld");
  assert.equal(sent[0]!.body.model, "claude-fable-5-1");
  assert.deepEqual(sent[0]!.body.output_config, { effort: "low" });

  stubAnthropic({
    reply: (body) => ({ model: "m", stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: (body.tools as Array<{ name: string }>)[0]!.name, input: { reasoning: "ok", verdict: "maybe", contradicting_turns: [] } }] }),
  });
  await assert.rejects(() => runIntegrityReview(REVIEW), (err: unknown) => err instanceof IntegrityReviewInvalidOutputError && !(err instanceof IntegrityReviewIncompleteError));

  stubAnthropic({
    reply: (body) => ({ model: "m", stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: (body.tools as Array<{ name: string }>)[0]!.name, input: { reasoning: "ok", verdict: "violated", contradicting_turns: "3" } }] }),
  });
  await assert.rejects(() => runIntegrityReview(REVIEW), IntegrityReviewInvalidOutputError);
});

// ---------------------------------------------------------------------------
// The resolve route — error contracts preserved, refusal never retried,
// every attempt recorded. Source-structure assertions (the route needs a
// live KV and secret store to execute).
// ---------------------------------------------------------------------------

const RESOLVE = readFileSync("app/api/game/[id]/resolve/route.ts", "utf8");

test("resolve keeps adjudicator_unavailable / integrity_review_unavailable and their localized messages", () => {
  assert.match(RESOLVE, /error: "adjudicator_unavailable"/);
  assert.match(RESOLVE, /Most nem sikerült értékelni\. A játék változatlan — próbáld újra\./);
  assert.match(RESOLVE, /error: "integrity_review_unavailable"/);
  assert.match(RESOLVE, /Most nem sikerült befejezni az ellenőrzést\. A játék változatlan — próbáld újra\./);
});

test("resolve records a refusal distinctly and retries only an INCOMPLETE integrity review, never a refusal or malformed output", () => {
  assert.match(RESOLVE, /err instanceof AnthropicRefusalError\) return \{ status: "refusal", errorClass: "refusal" \}/);
  assert.match(RESOLVE, /errorClass: "invalid_output"/);
  // The one bounded retry is gated on IntegrityReviewIncompleteError alone.
  assert.match(RESOLVE, /const incomplete = err instanceof IntegrityReviewIncompleteError;/);
  assert.match(RESOLVE, /if \(incomplete && attempt < MAX_INTEGRITY_REVIEW_ATTEMPTS\)/);
  assert.match(RESOLVE, /MAX_INTEGRITY_REVIEW_ATTEMPTS = 2/);
  // No substitute model anywhere in the route.
  assert.doesNotMatch(RESOLVE, /fallbacks|modelStrong\(\)/);
  // Every attempt — success, refusal, failure — lands in telemetry with its attempt number.
  assert.match(RESOLVE, /recordAdjudicationCall\(game, "integrity_review", attempt, reviewObserved\.value/);
  assert.match(RESOLVE, /recordAdjudicationCall\(game, "adjudicator", null, adjudicationObserved\.value/);
});

test("unrelated seats are unchanged: Validator and Composer target still use modelStrong, and only the two adjudication seats use the adjudication model", () => {
  for (const [path, expectModel] of [
    ["lib/prompts/validator.ts", "env.modelStrong()"],
    ["lib/prompts/composerTarget.ts", "env.modelStrong()"],
    ["lib/prompts/composerAnswer.ts", "env.modelRacer()"],
    ["lib/prompts/questionEdit.ts", "env.modelRacer()"],
  ] as const) {
    const src = readFileSync(path, "utf8");
    assert.ok(src.includes(expectModel), `${path} keeps ${expectModel}`);
    assert.doesNotMatch(src, /modelAdjudication|effortAdjudication/, `${path} is not an adjudication seat`);
  }
  const adj = readFileSync("lib/prompts/adjudicator.ts", "utf8");
  assert.match(adj, /env\.modelAdjudication\(\)/);
  assert.match(adj, /env\.effortAdjudication\(\)/);
  assert.doesNotMatch(adj, /modelStrong/);
  // The Integrity Review has its OWN explicitly configured seat (Fable 5.1's
  // classifier refuses this review); unset it follows the adjudication model.
  const rev = readFileSync("lib/prompts/integrityReview.ts", "utf8");
  assert.match(rev, /env\.modelIntegrityReview\(\)/);
  assert.match(rev, /env\.effortIntegrityReview\(\)/);
  assert.doesNotMatch(rev, /modelStrong/);
});

test("the Integrity Review model is separately configurable and defaults to the adjudication model — never a runtime fallback", async () => {
  delete process.env.ANTHROPIC_MODEL_INTEGRITY_REVIEW;
  let sent = stubAnthropic({ reply: (body) => ({ model: "m", stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: (body.tools as Array<{ name: string }>)[0]!.name, input: { reasoning: "ok", verdict: "upheld", contradicting_turns: [] } }] }) });
  await runIntegrityReview(REVIEW);
  assert.equal(sent[0]!.body.model, "claude-fable-5-1");

  process.env.ANTHROPIC_MODEL_INTEGRITY_REVIEW = "claude-sonnet-5";
  sent = stubAnthropic({ reply: (body) => ({ model: "m", stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: (body.tools as Array<{ name: string }>)[0]!.name, input: { reasoning: "ok", verdict: "upheld", contradicting_turns: [] } }] }) });
  await runIntegrityReview(REVIEW);
  assert.equal(sent[0]!.body.model, "claude-sonnet-5");
  assert.deepEqual(sent[0]!.body.output_config, { effort: "low" });
  assert.deepEqual(sent[0]!.body.tool_choice, { type: "tool", name: "submit_integrity_review" }, "Sonnet 5 keeps forced tool mode");
  delete process.env.ANTHROPIC_MODEL_INTEGRITY_REVIEW;

  // A refusal on whichever model is configured is still a failure, never a switch.
  stubAnthropic({ reply: () => ({ model: "m", stop_reason: "refusal", stop_details: { category: "reasoning_extraction" }, usage: {}, content: [] }) });
  await assert.rejects(() => runIntegrityReview(REVIEW), AnthropicRefusalError);
});
