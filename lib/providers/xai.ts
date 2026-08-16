import { env } from "../env";
import type { ProviderAdapter, ToolCallRequest, ToolCallResult } from "./types";

// ---------------------------------------------------------------------------
// V2.5-B3 — the xAI / Grok transport.
//
// Barkóba's second Racer. Same seat, same prompt, same schema, same rules; a
// different model on the other end of the wire.
//
// ---------------------------------------------------------------------------
// WHICH ENDPOINT, AND WHY THE LEGACY ONE
// ---------------------------------------------------------------------------
//
// xAI offers /v1/responses (recommended for new builds) and /v1/chat/completions
// (documented as legacy). This uses chat/completions, deliberately.
//
// Barkóba makes ONE forced-tool call per turn. No tool-execution loop, no
// server-side tools, no streaming, no conversation state — the engine holds the
// transcript and re-sends it, and has since V1. Every advantage the Responses
// API offers is an advantage in features Barkóba does not use, while its
// output[]/function_call/previous_response_id model is a strictly larger
// surface to adapt. chat/completions maps almost 1:1 onto the shape the
// Anthropic client already had.
//
// The cost of being wrong about this is one file. That is precisely what the
// B2 boundary bought, and it is why choosing the smaller adapter now is safe
// rather than short-sighted.
//
// ---------------------------------------------------------------------------
// WHAT IS ACTUALLY DIFFERENT FROM ANTHROPIC (verified against xAI docs, not
// assumed from OpenAI familiarity)
// ---------------------------------------------------------------------------
//
//   1. The system prompt is a MESSAGE with role "system", not a top-level
//      field.
//   2. Tools nest under `function`: {type:"function", function:{name,
//      description, parameters}}. The Responses API uses a flatter shape — the
//      two are NOT interchangeable, and mixing them is the easy mistake here.
//   3. Forcing one tool: tool_choice {type:"function", function:{name}}.
//   4. Arguments come back as a JSON *string* in
//      choices[0].message.tool_calls[0].function.arguments, not as an object.
//   5. Parallel tool calls are ON by default and must be switched off, or a
//      turn could contain two moves.
//   6. Truncation shows as finish_reason === "length", not stop_reason.
//
// WHAT IS NOT DIFFERENT, AND WAS THE MAIN RISK BEFORE CHECKING: the schema.
// xAI documents `{"type": ["string", "null"]}` as the way to declare a nullable
// field, which is exactly what turnInputSchema already emits for question_text
// and guess_text. Tool arguments are additionally strict-by-default — xAI
// applies the equivalent of strict:true implicitly — so the Racer's contract
// holds without a single change to the schema Anthropic receives.
// ---------------------------------------------------------------------------

const XAI_ENDPOINT = "https://api.x.ai/v1/chat/completions";

interface XaiToolCall {
  function?: { name?: string; arguments?: string };
}

interface XaiResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { tool_calls?: XaiToolCall[] };
  }>;
  usage?: { completion_tokens?: number };
}

/**
 * THE OUTPUT CAP IS A TRANSPORT CONCERN, NOT A TASK CHANGE.
 *
 * Barkóba asks for 512 tokens on a Racer turn, sized for Claude Haiku emitting
 * a question and a two-sentence rationale. Grok 4.6 is a reasoning model, and
 * reasoning tokens are charged against the same output allowance. A cap that
 * fits one model's answer can therefore truncate the other's before it ever
 * reaches the tool call — which would score as a failed turn and be
 * misattributed to the model playing badly.
 *
 * Raising the ceiling does NOT change the task: the system prompt, the schema,
 * the transcript and the question budget are byte-identical across providers.
 * It only stops one provider from being cut off mid-sentence. Configurable so
 * it can be tuned from evidence rather than guessed at again.
 */
function outputCap(requested: number | undefined): number {
  return Math.max(requested ?? 1024, env.xaiMaxTokensRacer());
}

export const xaiAdapter: ProviderAdapter = {
  id: "xai",

  async callTool<T>(request: ToolCallRequest): Promise<ToolCallResult<T>> {
    const apiKey = env.xaiApiKey();
    if (!apiKey) {
      // Should be unreachable: game creation refuses an unavailable provider.
      // Kept because "unreachable" and "cannot happen" are different claims,
      // and the failure must never be a silent fallback to another model.
      throw new Error(
        "xAI provider selected but XAI_API_KEY is not configured in this runtime."
      );
    }

    const body = {
      model: request.model,
      max_tokens: outputCap(request.maxTokens),
      messages: [
        // Difference 1. Anthropic takes `system` at the top level; here it is
        // the first message. The TEXT is untouched — an adapter transports a
        // prompt, it never authors one.
        { role: "system", content: request.system },
        ...request.messages,
      ],
      tools: [
        {
          // Difference 2. The nested shape belongs to chat/completions; the
          // Responses API uses a flat one.
          type: "function",
          function: {
            name: request.toolName,
            description: request.toolDescription,
            parameters: request.inputSchema,
          },
        },
      ],
      // Difference 3.
      tool_choice: { type: "function", function: { name: request.toolName } },
      // Difference 5. One move per turn. Barkóba's engine appends exactly one
      // log entry per Racer turn, so a second tool call would be silently lost
      // — evidence quietly missing rather than an error.
      parallel_tool_calls: false,
      stream: false,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    const response = await fetch(XAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      // Same contract as the Anthropic adapter: throw with status and body. The
      // /turn route already catches this and returns 502 racer_unavailable with
      // the player's recorded answer preserved. No retry is added here —
      // retrying on one provider and not the other would make their failure
      // rates incomparable.
      throw new Error(
        `xAI API error (${response.status}) for tool ${request.toolName}: ${errText}`
      );
    }

    const data = (await response.json()) as XaiResponse;

    // Provenance first, before any parse below can throw, so a truncated or
    // malformed response still says which model produced it.
    let resolvedModel = request.model;
    if (typeof data.model === "string" && data.model.length > 0) {
      resolvedModel = data.model;
    } else {
      // NOT fabricated: the requested id is what was asked for, and the fact
      // that the API did not confirm it is said out loud rather than hidden.
      // eslint-disable-next-line no-console
      console.warn(
        `[barkoba] xAI response omitted a model id for ${request.toolName}; ` +
          `provenance falls back to the requested id (${request.model}). ` +
          "Resolved identity is unconfirmed for this turn."
      );
    }

    const choice = data.choices?.[0];

    // Difference 6.
    if (choice?.finish_reason === "length") {
      // eslint-disable-next-line no-console
      console.warn(
        `[barkoba] xAI ${request.toolName} hit the output cap ` +
          `(${outputCap(request.maxTokens)}). completion_tokens=` +
          `${data.usage?.completion_tokens ?? "?"}. Output was truncated — ` +
          "raise XAI_MAX_TOKENS_RACER."
      );
    }

    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall?.function?.arguments) {
      throw new Error(
        `xAI did not return a tool call for ${request.toolName}. ` +
          `finish_reason=${choice?.finish_reason ?? "?"}`
      );
    }

    // Difference 4. Fail loudly rather than returning a half-parsed turn: a
    // malformed move must look like a failed call, not like a bad question.
    let output: T;
    try {
      output = JSON.parse(toolCall.function.arguments) as T;
    } catch (err) {
      throw new Error(
        `xAI returned unparseable tool arguments for ${request.toolName}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }

    return { output, resolvedModel };
  },
};
