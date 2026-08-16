import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { xaiAdapter } from "../lib/providers/xai";
import { getAdapter, isProviderAvailable } from "../lib/providers";
import { RACER_PROMPT_VERSION } from "../lib/prompts/racer";

// ---------------------------------------------------------------------------
// V2.5-B3 — xAI / Grok as Barkóba's second Racer.
//
// Hermetic: global fetch is stubbed, so no key, no network, no cost.
//
// The adapter tests are real behavioural coverage of the request Barkóba sends
// and the response it parses. The selection/persistence tests are SOURCE
// STRUCTURE assertions, in the cluePolicy.test.ts idiom — the create and turn
// routes need a live KV, a live secret store and a network call to invoke, so
// nothing here executes them. Said plainly rather than implied, because a
// source match is a weaker claim than an executed one.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubXai(response: unknown, ok = true, status = 200): Sent[] {
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

/** A well-formed Grok tool call, in the chat/completions shape. */
function grokReply(args: unknown, extra: Record<string, unknown> = {}) {
  return {
    model: "grok-4.6-20260714",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            { function: { name: "submit_turn", arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
    ...extra,
  };
}

const TURN = {
  model: "grok-4.6",
  system: "SYSTEM PROMPT TEXT",
  messages: [{ role: "user" as const, content: "transcript" }],
  toolName: "submit_turn",
  toolDescription: "Submit your move for this turn.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["question", "guess", "concede"] },
      question_text: { type: ["string", "null"] },
      guess_text: { type: ["string", "null"] },
      rationale: { type: "string" },
    },
    required: ["action", "question_text", "guess_text", "rationale"],
  },
  maxTokens: 512,
};

beforeEach(() => {
  globalThis.fetch = realFetch;
  process.env.XAI_API_KEY = "test-xai-key";
  delete process.env.XAI_MAX_TOKENS_RACER;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.XAI_API_KEY;
  delete process.env.XAI_MAX_TOKENS_RACER;
});

// ---------------------------------------------------------------------------
// The request. Six documented differences from Anthropic, each asserted, because
// each was a place this could have been written from OpenAI familiarity rather
// than from xAI's actual contract.
// ---------------------------------------------------------------------------

test("the request goes to xAI's chat/completions endpoint with bearer auth", async () => {
  const sent = stubXai(grokReply({ action: "concede" }));
  await xaiAdapter.callTool(TURN);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(sent[0]!.headers.Authorization, "Bearer test-xai-key");
  // The key must never travel as a query parameter, where it would land in logs.
  assert.doesNotMatch(sent[0]!.url, /test-xai-key/);
});

test("the system prompt becomes the first message, verbatim", async () => {
  const sent = stubXai(grokReply({ action: "concede" }));
  await xaiAdapter.callTool(TURN);

  const messages = sent[0]!.body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]!.role, "system");
  // BYTE-IDENTICAL. An adapter transports a prompt; it never authors one. If
  // this ever fails, Claude and Grok are being given different tasks and the
  // comparison between them measures the prompt rather than the model.
  assert.equal(messages[0]!.content, TURN.system);
  assert.equal(messages[1]!.content, "transcript");
});

test("the tool nests under `function` and is forced", async () => {
  const sent = stubXai(grokReply({ action: "concede" }));
  await xaiAdapter.callTool(TURN);

  const body = sent[0]!.body;
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0]!.type, "function");

  // chat/completions nests; the Responses API is flatter. Mixing them is the
  // easy mistake, and it fails at request time rather than at review time.
  const fn = tools[0]!.function as Record<string, unknown>;
  assert.equal(fn.name, "submit_turn");
  assert.deepEqual(fn.parameters, TURN.inputSchema, "the schema passes through untouched");

  assert.deepEqual(body.tool_choice, {
    type: "function",
    function: { name: "submit_turn" },
  });
});

test("parallel tool calls are switched off", async () => {
  const sent = stubXai(grokReply({ action: "concede" }));
  await xaiAdapter.callTool(TURN);
  // On by default at xAI. Barkóba appends exactly one log entry per turn, so a
  // second tool call would be silently dropped — evidence quietly missing.
  assert.equal(sent[0]!.body.parallel_tool_calls, false);
});

test("the nullable-union schema is sent as-is", async () => {
  const sent = stubXai(grokReply({ action: "concede" }));
  await xaiAdapter.callTool(TURN);

  const schema = (sent[0]!.body.tools as Array<Record<string, unknown>>)[0]!
    .function as Record<string, unknown>;
  const props = (schema.parameters as Record<string, unknown>).properties as Record<
    string,
    { type: unknown }
  >;
  // xAI documents {"type": ["string","null"]} as THE way to declare a nullable
  // field, so no per-provider normalisation is needed — and none is permitted,
  // because a schema rewritten for one vendor changes the task it receives.
  assert.deepEqual(props.question_text!.type, ["string", "null"]);
  assert.deepEqual(props.guess_text!.type, ["string", "null"]);
});

// ---------------------------------------------------------------------------
// The response.
// ---------------------------------------------------------------------------

test("tool arguments arrive as a JSON string and are parsed", async () => {
  stubXai(grokReply({ action: "question", question_text: "Élőlény?", guess_text: null, rationale: "r" }));
  const { output } = await xaiAdapter.callTool<{ action: string; question_text: string }>(TURN);
  assert.equal(output.action, "question");
  assert.equal(output.question_text, "Élőlény?");
});

test("provenance reports the model the API says it used, not the alias asked for", async () => {
  stubXai(grokReply({ action: "concede" }));
  const { resolvedModel } = await xaiAdapter.callTool(TURN);
  // Requested "grok-4.6"; the response resolved it to a dated snapshot. Only
  // the resolved id is evidence of what actually played.
  assert.equal(resolvedModel, "grok-4.6-20260714");
  assert.notEqual(resolvedModel, TURN.model);
});

test("a response with no model id falls back to the requested id and says so", async () => {
  const reply = grokReply({ action: "concede" });
  delete (reply as Record<string, unknown>).model;
  stubXai(reply);

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string) => void warnings.push(String(msg));
  try {
    const { resolvedModel } = await xaiAdapter.callTool(TURN);
    // Not fabricated — the requested id IS what was asked for. What must not
    // happen is the limitation going unrecorded.
    assert.equal(resolvedModel, "grok-4.6");
    assert.match(warnings.join("\n"), /unconfirmed/i);
  } finally {
    console.warn = realWarn;
  }
});

test("a missing tool call throws rather than returning a half-turn", async () => {
  stubXai({ model: "grok-4.6", choices: [{ finish_reason: "stop", message: {} }] });
  await assert.rejects(() => xaiAdapter.callTool(TURN), /did not return a tool call/);
});

test("unparseable arguments throw rather than returning a bad move", async () => {
  stubXai({
    model: "grok-4.6",
    choices: [
      {
        finish_reason: "tool_calls",
        message: { tool_calls: [{ function: { name: "submit_turn", arguments: "{not json" } }] },
      },
    ],
  });
  // A malformed move must look like a failed call, not like a bad question —
  // otherwise the corpus records a reasoning failure that never happened.
  await assert.rejects(() => xaiAdapter.callTool(TURN), /unparseable tool arguments/);
});

test("a non-2xx throws with status and body, matching the Anthropic contract", async () => {
  stubXai({ error: "rate limited" }, false, 429);
  // Same shape of failure means /turn returns 502 racer_unavailable for both
  // providers, with the player's recorded answer preserved. No retry is added
  // for one provider only, which would make their failure rates incomparable.
  await assert.rejects(() => xaiAdapter.callTool(TURN), /xAI API error \(429\)/);
});

test("the output cap is raised for a reasoning model without changing the task", async () => {
  const sent = stubXai(grokReply({ action: "concede" }));
  await xaiAdapter.callTool(TURN);
  // Barkóba asks for 512, sized for Haiku. Grok 4.6 spends reasoning tokens
  // against the same allowance and would be cut off before reaching the tool
  // call. Transport only: prompt, schema and question budget are untouched.
  assert.equal(sent[0]!.body.max_tokens, 2048);
  assert.equal((sent[0]!.body.messages as unknown[]).length, 2, "the task is unchanged");
});

test("a missing key throws and never falls back to another provider", async () => {
  delete process.env.XAI_API_KEY;
  stubXai(grokReply({ action: "concede" }));
  await assert.rejects(() => xaiAdapter.callTool(TURN), /XAI_API_KEY is not configured/);
});

// ---------------------------------------------------------------------------
// Registry and availability.
// ---------------------------------------------------------------------------

test("xai is registered and resolves to the xai adapter", () => {
  assert.equal(getAdapter("xai"), xaiAdapter);
  assert.equal(getAdapter("xai").id, "xai");
});

test("availability is separate from registration", () => {
  assert.equal(isProviderAvailable("xai"), true);
  delete process.env.XAI_API_KEY;
  // Still a legitimate choice in the code; not usable in THIS runtime. Game
  // creation refuses on this, and must never use it to pick a substitute.
  assert.equal(isProviderAvailable("xai"), false);
  assert.equal(isProviderAvailable("anthropic"), true);
});

// ---------------------------------------------------------------------------
// Selection, persistence and routing. Source-structure guards.
// ---------------------------------------------------------------------------

const CREATE_ROUTE = readFileSync("app/api/game/create/route.ts", "utf8");
const TURN_ROUTE = readFileSync("app/api/game/[id]/turn/route.ts", "utf8");
const RACER_SRC = readFileSync("lib/prompts/racer.ts", "utf8");

test("game creation refuses an unknown or unavailable provider — never substitutes", () => {
  const fn = CREATE_ROUTE.slice(
    CREATE_ROUTE.indexOf("function resolveRacerProvider"),
    CREATE_ROUTE.indexOf("interface CreateGameBody")
  );
  assert.ok(fn.length > 0, "could not isolate resolveRacerProvider");

  assert.match(fn, /unknown_provider/, "an unrecognised name must be refused");
  assert.match(fn, /provider_unavailable/, "a provider with no key must be refused");
  assert.match(fn, /isProviderAvailable\(/);
  // THE RULE. A fallback here would put a game in the corpus attributed to a
  // player that never played it. Exactly two paths accept — no choice at all,
  // and a validated available choice — and exactly two refuse.
  // Commas match the RETURNS; the type signature above uses semicolons.
  const code = fn.replace(/\/\/.*$/gm, "");
  assert.equal((code.match(/ok: true,/g) ?? []).length, 2, "exactly two accepting paths");
  assert.equal((code.match(/ok: false,/g) ?? []).length, 2, "exactly two refusing paths");
});

test("the model id is server-held and never taken from the request", () => {
  // The body may name a PROVIDER. It may never name a MODEL — the same rule
  // that keeps a Play Credit price out of a caller's hands.
  assert.doesNotMatch(CREATE_ROUTE, /body\.(racer_)?model/i);
  assert.doesNotMatch(CREATE_ROUTE, /body\.\w*model_id/i);
  assert.match(RACER_SRC, /env\.xaiModelRacer\(\)/);
});

test("the provider is persisted on the game and read back on every turn", () => {
  assert.match(CREATE_ROUTE, /racer_provider: humanVsHuman \? null :/);
  // Read from the record, never from the request body: turn N+1 must reach the
  // same player as turn N.
  assert.match(TURN_ROUTE, /game\.racer_provider/);
  assert.doesNotMatch(TURN_ROUTE, /body\.racer_provider/);
});

test("a stored provider that is no longer registered refuses the turn", () => {
  assert.match(TURN_ROUTE, /isModelProviderId\(game\.racer_provider\)/);
  // One game whose turns were played by two different models, reading as one
  // continuous player, is worse than a stalled game.
  assert.match(TURN_ROUTE, /refusing rather than substituting/);
});

test("the guess-intent call uses the same provider as the turn it resolves", () => {
  assert.match(TURN_ROUTE, /resolveGuessIntent\(\s*racerState,\s*turn\.question_text,\s*racerProvider/);
});

test("both providers receive the same prompt version", () => {
  // Forking the prompt per provider would mean measuring prompt×model. If that
  // ever becomes necessary, the version must fork with it or the evidence lies.
  assert.equal(RACER_PROMPT_VERSION, "racer/2.5.0");
  const versions = RACER_SRC.match(/RACER_PROMPT_VERSION = "[^"]+"/g) ?? [];
  assert.equal(versions.length, 1, "exactly one prompt version, shared by both providers");
});

test("only the Racer seat is provider-selectable", () => {
  // The referees and the AI Composer stay on Anthropic: they are the measuring
  // instrument, and the Composer path additionally reads the locked target,
  // which is what keeps the secret from ever reaching a second vendor.
  for (const path of [
    "lib/prompts/validator.ts",
    "lib/prompts/adjudicator.ts",
    "lib/prompts/integrityReview.ts",
    "lib/prompts/composerTarget.ts",
    "lib/prompts/composerAnswer.ts",
    "lib/prompts/questionEdit.ts",
  ]) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(src, /getAdapter|xaiAdapter|xaiModelRacer/, `${path} must stay Anthropic`);
  }
});

test("the xAI adapter is quarantined from the secret store", () => {
  const iso = readFileSync("scripts/check-isolation.mjs", "utf8");
  const quarantined = iso.slice(iso.indexOf("const QUARANTINED"));
  assert.ok(quarantined.includes('"lib/providers/xai.ts"'));

  // A secretStore import here would not merely leak the target into a prompt —
  // it would send it to a second vendor.
  const src = readFileSync("lib/providers/xai.ts", "utf8");
  assert.doesNotMatch(src, /secretStore/);
  assert.doesNotMatch(src, /revealed_target|private_clarification/);
});

test("the key is server-side only and never reaches a client bundle", () => {
  assert.doesNotMatch(readFileSync("lib/env.ts", "utf8"), /NEXT_PUBLIC_XAI/);
  assert.doesNotMatch(readFileSync("app/ComposerEntry.tsx", "utf8"), /XAI_API_KEY/);
  // The selector sends a provider NAME. Nothing else.
  assert.match(readFileSync("app/ComposerEntry.tsx", "utf8"), /racer_provider: racerProvider/);
});
