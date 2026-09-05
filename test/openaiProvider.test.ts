import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openaiAdapter, readOpenAiUsage } from "../lib/providers/openai";
import { getAdapter, isProviderAvailable } from "../lib/providers";
import { racerModelFor } from "../lib/prompts/racer";

// ---------------------------------------------------------------------------
// V2.8.7 — OpenAI GPT-6 Astra as Barkóba's public Racer.
//
// Hermetic: global fetch is stubbed, so no key, no network, no cost. Same
// idiom as test/xaiProvider.test.ts: the adapter tests are real behavioural
// coverage of the request Barkóba sends and the response it parses; the
// routing tests are SOURCE STRUCTURE assertions, said plainly.
//
// Model access itself (does this account reach gpt-6-astra?) is NOT proven
// here — that needs a live call, deferred to a Preview deployment per the
// V2.8.7 assignment. What this file proves is that the request Barkóba would
// send matches OpenAI's documented Responses API contract for that model.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubOpenAi(response: unknown, ok = true, status = 200): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return {
      ok,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  }) as unknown as typeof fetch;
  return sent;
}

/** A well-formed Responses API function call. */
function astraReply(args: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    model: "gpt-6-astra",
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "submit_turn", arguments: JSON.stringify(args), status: "completed" },
    ],
    usage: {
      input_tokens: 1500,
      output_tokens: 420,
      total_tokens: 1920,
      input_tokens_details: { cached_tokens: 1024 },
      output_tokens_details: { reasoning_tokens: 380 },
    },
    ...extra,
  };
}

const TURN = {
  model: "gpt-6-astra",
  system: "SYSTEM PROMPT TEXT",
  messages: [{ role: "user" as const, content: "transcript" }],
  toolName: "submit_turn",
  toolDescription: "Submit your move for this turn.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["question", "guess"] },
      question_text: { type: ["string", "null"] },
      guess_text: { type: ["string", "null"] },
      rationale: { type: "string" },
      question_kind: { type: ["string", "null"], enum: ["branch_gate", "discriminator", null] },
    },
    required: ["action", "question_text", "guess_text", "rationale", "question_kind"],
  },
  maxTokens: 512,
};

beforeEach(() => {
  globalThis.fetch = realFetch;
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_MODEL_RACER;
  delete process.env.OPENAI_REASONING_EFFORT_RACER;
  delete process.env.OPENAI_MAX_OUTPUT_TOKENS_RACER;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL_RACER;
  delete process.env.OPENAI_REASONING_EFFORT_RACER;
  delete process.env.OPENAI_MAX_OUTPUT_TOKENS_RACER;
});

// ---------------------------------------------------------------------------
// The request — each documented difference asserted, because each is a place
// this could have been written from chat/completions familiarity instead of
// the Responses API contract gpt-6-astra requires for tool calling.
// ---------------------------------------------------------------------------

test("the request goes to OpenAI's /v1/responses endpoint with bearer auth", async () => {
  const sent = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool(TURN);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://api.openai.com/v1/responses");
  assert.equal(sent[0]!.headers.Authorization, "Bearer test-openai-key");
  assert.doesNotMatch(sent[0]!.url, /test-openai-key/);
});

test("the system prompt is `instructions` and the transcript is `input`, both verbatim", async () => {
  const sent = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool(TURN);
  const body = sent[0]!.body;
  // BYTE-IDENTICAL. An adapter transports a prompt; it never authors one.
  assert.equal(body.instructions, TURN.system);
  assert.deepEqual(body.input, [{ role: "user", content: "transcript" }]);
  assert.equal("messages" in body, false, "chat/completions shape must not leak in");
});

test("the tool is the FLAT Responses shape, forced by name, non-strict, schema untouched", async () => {
  const sent = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool(TURN);
  const tools = sent[0]!.body.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.type, "function");
  assert.equal(tools[0]!.name, "submit_turn");
  assert.equal("function" in tools[0]!, false, "the nested chat/completions shape is wrong here");
  assert.deepEqual(tools[0]!.parameters, TURN.inputSchema, "the schema passes through untouched");
  // strict:false on purpose — strict mode would require rewriting the schema
  // (additionalProperties:false everywhere), which is per-vendor normalisation
  // the provider boundary forbids. The engine validates every field itself.
  assert.equal(tools[0]!.strict, false);
  assert.deepEqual(sent[0]!.body.tool_choice, { type: "function", name: "submit_turn" });
});

test("parallel tool calls are switched off and the request is not stored", async () => {
  const sent = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool(TURN);
  assert.equal(sent[0]!.body.parallel_tool_calls, false);
  assert.equal(sent[0]!.body.store, false);
  assert.equal(sent[0]!.body.stream, false);
});

test("reasoning effort defaults to the server-held 'low' and is sent as reasoning.effort", async () => {
  const sent = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool(TURN);
  assert.deepEqual(sent[0]!.body.reasoning, { effort: "low" });
});

test("the environment can change the default effort; a caller's explicit effort overrides it for that call", async () => {
  process.env.OPENAI_REASONING_EFFORT_RACER = "medium";
  const a = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool(TURN);
  assert.deepEqual(a[0]!.body.reasoning, { effort: "medium" });

  const b = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool({ ...TURN, reasoningEffort: "high" });
  assert.deepEqual(b[0]!.body.reasoning, { effort: "high" });
});

test("no sampling parameters are ever sent, even when the caller asks for a temperature", async () => {
  const sent = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool({ ...TURN, temperature: 0 });
  const json = JSON.stringify(sent[0]!.body);
  // The migration guide for gpt-6-astra says to remove these outright.
  assert.doesNotMatch(json, /temperature|top_p|logprobs/);
});

test("the output cap is raised for a reasoning model without changing the task", async () => {
  const sent = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool(TURN);
  // Barkóba asks for 512, sized for Haiku. Reasoning tokens count against
  // max_output_tokens on gpt-6-astra and would cut the call off before the
  // function call is emitted. Transport only: instructions/input/tools stay.
  assert.equal(sent[0]!.body.max_output_tokens, 8192);
  process.env.OPENAI_MAX_OUTPUT_TOKENS_RACER = "3000";
  const again = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool(TURN);
  assert.equal(again[0]!.body.max_output_tokens, 3000);
});

test("effort does not disturb the task the model receives", async () => {
  const a = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool({ ...TURN, reasoningEffort: "high" });
  const b = stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await openaiAdapter.callTool(TURN);
  assert.equal(a[0]!.body.instructions, b[0]!.body.instructions);
  assert.deepEqual(a[0]!.body.input, b[0]!.body.input);
  assert.deepEqual(a[0]!.body.tools, b[0]!.body.tools);
  assert.deepEqual(a[0]!.body.tool_choice, b[0]!.body.tool_choice);
});

// ---------------------------------------------------------------------------
// The response.
// ---------------------------------------------------------------------------

test("function-call arguments arrive as a JSON string and are parsed", async () => {
  stubOpenAi(astraReply({ action: "question", question_text: "Élőlény?", guess_text: null, rationale: "r" }));
  const { output } = await openaiAdapter.callTool<{ action: string; question_text: string }>(TURN);
  assert.equal(output.action, "question");
  assert.equal(output.question_text, "Élőlény?");
});

test("provenance reports the model the API says it used, falling back to the requested id with a warning", async () => {
  stubOpenAi(astraReply({ action: "guess", guess_text: "x" }, { model: "gpt-6-astra-2026-08-01" }));
  const { resolvedModel } = await openaiAdapter.callTool(TURN);
  assert.equal(resolvedModel, "gpt-6-astra-2026-08-01");

  const reply = astraReply({ action: "guess", guess_text: "x" });
  delete (reply as Record<string, unknown>).model;
  stubOpenAi(reply);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string) => void warnings.push(String(msg));
  try {
    const r = await openaiAdapter.callTool(TURN);
    assert.equal(r.resolvedModel, "gpt-6-astra");
    assert.match(warnings.join("\n"), /unconfirmed/i);
  } finally {
    console.warn = realWarn;
  }
});

test("usage is normalised: uncached input excludes the cached share; reasoning is a share of output; unreported = null", async () => {
  stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  const { diagnostics } = await openaiAdapter.callTool(TURN);
  assert.deepEqual(diagnostics?.usage, {
    input_tokens: 476, // 1500 total - 1024 cached
    cached_input_tokens: 1024,
    cache_write_input_tokens: null, // OpenAI has no cache-write line item
    output_tokens: 420, // includes the 380 reasoning tokens — never added again
    reasoning_tokens: 380,
  });
  assert.equal(diagnostics?.effortSent, "low");
  assert.equal(diagnostics?.requestMode, "forced_tool");
  assert.equal(diagnostics?.finishReason, "completed");

  assert.deepEqual(readOpenAiUsage(undefined), {
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
  });
  assert.deepEqual(readOpenAiUsage({ input_tokens: 10, output_tokens: 5 }), {
    input_tokens: 10,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    output_tokens: 5,
    reasoning_tokens: null,
  });
});

test("a truncated (incomplete: max_output_tokens) response with no function call throws and names the reason", async () => {
  stubOpenAi({
    model: "gpt-6-astra",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "reasoning", id: "rs_1", summary: [] }],
    usage: { input_tokens: 1500, output_tokens: 8192, output_tokens_details: { reasoning_tokens: 8192 } },
  });
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string) => void warnings.push(String(msg));
  try {
    await assert.rejects(() => openaiAdapter.callTool(TURN), /did not return a function call.*max_output_tokens/);
    assert.match(warnings.join("\n"), /OPENAI_MAX_OUTPUT_TOKENS_RACER/);
  } finally {
    console.warn = realWarn;
  }
});

test("a function call for a DIFFERENT tool than the forced one is refused, not parsed", async () => {
  const reply = astraReply({ action: "guess", guess_text: "x" });
  (reply.output[1] as Record<string, unknown>).name = "something_else";
  stubOpenAi(reply);
  await assert.rejects(() => openaiAdapter.callTool(TURN), /instead of the forced tool submit_turn/);
});

test("unparseable or non-object arguments throw rather than returning a bad move", async () => {
  const bad = astraReply({});
  (bad.output[1] as Record<string, unknown>).arguments = "{not json";
  stubOpenAi(bad);
  await assert.rejects(() => openaiAdapter.callTool(TURN), /unparseable function arguments/);

  const notObject = astraReply({});
  (notObject.output[1] as Record<string, unknown>).arguments = "42";
  stubOpenAi(notObject);
  await assert.rejects(() => openaiAdapter.callTool(TURN), /non-object function arguments/);
});

test("a non-2xx throws with status and body, matching the other adapters' contract", async () => {
  stubOpenAi({ error: { message: "rate limited" } }, false, 429);
  await assert.rejects(() => openaiAdapter.callTool(TURN), /OpenAI API error \(429\)/);
});

test("a missing key throws and never falls back to another provider", async () => {
  delete process.env.OPENAI_API_KEY;
  stubOpenAi(astraReply({ action: "guess", guess_text: "x" }));
  await assert.rejects(() => openaiAdapter.callTool(TURN), /OPENAI_API_KEY is not configured/);
});

// ---------------------------------------------------------------------------
// Registry, availability, model resolution.
// ---------------------------------------------------------------------------

test("openai is registered and resolves to the openai adapter", () => {
  assert.equal(getAdapter("openai"), openaiAdapter);
  assert.equal(getAdapter("openai").id, "openai");
});

test("availability is separate from registration", () => {
  assert.equal(isProviderAvailable("openai"), true);
  delete process.env.OPENAI_API_KEY;
  // Still a legitimate choice in the code; not usable in THIS runtime. Game
  // creation refuses on this, and must never use it to pick a substitute.
  assert.equal(isProviderAvailable("openai"), false);
  assert.equal(isProviderAvailable("anthropic"), true);
});

test("the Racer model for openai is server-held and defaults to the exact verified id", () => {
  assert.equal(racerModelFor("openai"), "gpt-6-astra");
  process.env.OPENAI_MODEL_RACER = "gpt-6-astra-2026-08-01";
  assert.equal(racerModelFor("openai"), "gpt-6-astra-2026-08-01");
});

// ---------------------------------------------------------------------------
// Routing and isolation — source-structure guards.
// ---------------------------------------------------------------------------

test("the public Racer seat is pinned to openai, server-side, declared once", () => {
  const create = readFileSync("app/api/game/create/route.ts", "utf8");
  const matches = create.match(/const PUBLIC_RACER_PROVIDER: ModelProviderId = "([^"]+)";/g) ?? [];
  assert.equal(matches.length, 1);
  assert.match(matches[0]!, /"openai"/);
});

test("the OpenAI adapter is quarantined from the secret store", () => {
  const iso = readFileSync("scripts/check-isolation.mjs", "utf8");
  const quarantined = iso.slice(iso.indexOf("const QUARANTINED"));
  assert.ok(quarantined.includes('"lib/providers/openai.ts"'));
  const src = readFileSync("lib/providers/openai.ts", "utf8");
  assert.doesNotMatch(src, /secretStore/);
  assert.doesNotMatch(src, /revealed_target|private_clarification/);
});

test("the key is server-side only and no public component names a provider or model", () => {
  assert.doesNotMatch(readFileSync("lib/env.ts", "utf8"), /NEXT_PUBLIC_OPENAI/);
  for (const path of ["app/ComposerEntry.tsx", "app/RacerSetup.tsx"]) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(src, /OPENAI_API_KEY|racer_provider|gpt-6|"GPT"|"OpenAI"|"Claude"|"Grok"/);
  }
});

test("the turn loop never sets reasoning effort — it is the adapter's server-held configuration", () => {
  const turnRoute = readFileSync("app/api/game/[id]/turn/route.ts", "utf8");
  assert.doesNotMatch(turnRoute, /reasoningEffort/);
});
