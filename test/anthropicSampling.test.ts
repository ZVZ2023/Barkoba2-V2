import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  callAnthropicTool,
  isSamplingParamRejection,
  resetSamplingParamCache,
} from "../lib/anthropic";

// ---------------------------------------------------------------------------
// Hermetic. global fetch is stubbed — no network, no key, no cost.
//
// Regression cover for a real production failure: Claude Sonnet 5 and 4.7+
// reject non-default sampling parameters with HTTP 400, which took down every
// Adjudicator call. The fix must recover from that WITHOUT masking genuine
// 400s, which is the part worth testing.
// ---------------------------------------------------------------------------

const DEPRECATION_BODY = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "temperature is deprecated for this model" },
});

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetSamplingParamCache();
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = realFetch;
});

test("recognises a sampling-parameter rejection", () => {
  assert.equal(isSamplingParamRejection(400, "temperature is deprecated for this model"), true);
  assert.equal(isSamplingParamRejection(400, "`top_p` is not supported for this model"), true);
  assert.equal(isSamplingParamRejection(400, "top_k: only the default value is accepted"), true);
});

test("does NOT swallow unrelated 400s", () => {
  // If this ever returns true, a real bad-request bug gets silently retried and
  // reported as a compatibility quirk. That is worse than the original failure.
  assert.equal(isSamplingParamRejection(400, "max_tokens: must be greater than 0"), false);
  assert.equal(isSamplingParamRejection(400, "messages: final message cannot be assistant"), false);
  assert.equal(isSamplingParamRejection(400, "temperature must be between 0 and 1"), false);
  assert.equal(isSamplingParamRejection(401, "temperature is deprecated for this model"), false);
  assert.equal(isSamplingParamRejection(500, "temperature is deprecated for this model"), false);
});

function stubFetch(rejectSampling: boolean) {
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push(body);
    if (rejectSampling && "temperature" in body) {
      return { ok: false, status: 400, text: async () => DEPRECATION_BODY };
    }
    // V2.8.7 — the client validates the returned tool's NAME; echo the one
    // the request asked for, as the real API does.
    const toolName = (body.tools as Array<{ name: string }>)[0]!.name;
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "tool_use", name: toolName, input: { verdict: "correct" } }] }),
    };
  }) as unknown as typeof fetch;
  return sent;
}

const CALL = {
  model: "test-model-5",
  system: "s",
  messages: [{ role: "user" as const, content: "c" }],
  toolName: "submit_adjudication",
  toolDescription: "d",
  inputSchema: { type: "object" },
  temperature: 0,
};

test("retries without sampling params and still returns a result", async () => {
  const sent = stubFetch(true);
  const result = await callAnthropicTool<{ verdict: string }>(CALL);

  assert.equal(result.verdict, "correct", "the call must succeed despite the rejection");
  assert.equal(sent.length, 2, "expected one rejected attempt then one retry");
  assert.equal("temperature" in sent[0]!, true, "first attempt should carry temperature");
  assert.equal("temperature" in sent[1]!, false, "retry must drop temperature");
});

test("learns per model: later calls skip sampling params entirely", async () => {
  const sent = stubFetch(true);
  await callAnthropicTool(CALL);
  assert.equal(sent.length, 2);

  // Second call to the same model must not repeat the wasted round trip.
  await callAnthropicTool(CALL);
  assert.equal(sent.length, 3, "expected a single request once the model is known");
  assert.equal("temperature" in sent[2]!, false);
});

test("still sends temperature to models that accept it", async () => {
  const sent = stubFetch(false);
  await callAnthropicTool(CALL);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.temperature, 0, "must not drop sampling params pre-emptively");
});

test("a genuine 400 still throws instead of being retried away", async () => {
  const sent: Array<unknown> = [];
  globalThis.fetch = (async () => {
    sent.push(1);
    return { ok: false, status: 400, text: async () => "max_tokens: must be greater than 0" };
  }) as unknown as typeof fetch;

  await assert.rejects(() => callAnthropicTool(CALL), /max_tokens/);
  assert.equal(sent.length, 1, "unrelated 400s must not trigger a retry");
});
