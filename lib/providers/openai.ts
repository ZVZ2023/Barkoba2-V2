import { env } from "../env";
import type {
  ModelCallUsage,
  ProviderAdapter,
  ToolCallRequest,
  ToolCallResult,
} from "./types";

// ---------------------------------------------------------------------------
// V2.8.7 — the OpenAI transport (GPT-6 Astra as Barkóba's public Racer).
//
// Same seat, same prompt, same schema, same rules as the Anthropic and xAI
// adapters; a different model on the other end of the wire. An adapter
// transports a request — it never authors one (lib/providers/types.ts).
//
// WHICH ENDPOINT: /v1/responses. OpenAI's model guide for gpt-6-astra states
// that tool calling requires the Responses API; chat/completions is not an
// option here the way it was for xAI. Verified against the official model
// page, the latest-model guide, and the function-calling guide on 2026-09-05.
//
// WHAT IS DIFFERENT FROM THE OTHER TWO ADAPTERS (verified, not assumed):
//   1. The system prompt is the top-level `instructions` field; the
//      transcript is `input` (an array of role/content messages).
//   2. Tools are FLAT: {type:"function", name, description, parameters,
//      strict}. This is the Responses shape — chat/completions nests under
//      `function`, and the two are not interchangeable.
//   3. Forcing one tool: tool_choice {type:"function", name}.
//   4. The call comes back as an `output[]` item of type "function_call"
//      whose `arguments` is a JSON *string*.
//   5. Parallel tool calls are switched off explicitly (one move per turn).
//   6. Reasoning depth is `reasoning: {effort}`; gpt-6-astra accepts
//      low/medium/high (never "none"). `temperature` / `top_p` are NOT sent —
//      the migration guide says to remove them, and the request never
//      carried them for this provider, so there is nothing to self-heal.
//   7. Truncation surfaces as status "incomplete" with
//      incomplete_details.reason === "max_output_tokens". Reasoning tokens
//      count against max_output_tokens and are billed as output tokens.
//   8. `strict` is sent as false so the Racer's schema passes through
//      byte-identical to what Anthropic and xAI receive. Strict mode would
//      require rewriting the schema (additionalProperties:false on every
//      object), which is exactly the per-vendor normalisation the boundary
//      forbids; the engine already validates every returned action and
//      Layer Two field itself.
//
// REASONING EFFORT IS SERVER-HELD CONFIGURATION for this provider, like the
// model id: production runs at OPENAI_REASONING_EFFORT_RACER (default "low",
// the V2.8.7 product decision) and never at a provider default. A caller
// that sets request.reasoningEffort (the latency probe) overrides it for that
// one call. Contrast lib/providers/xai.ts, where UNSET means "provider
// default" because that is what every recorded Grok game ran at.
//
// `store: false` — Barkóba holds its own transcript and never needs OpenAI to
// retain the request; it also keeps the Racer's view of the game out of any
// vendor-side history. The Racer never sees the secret regardless (it only
// ever receives RacerPublicState), and this adapter is quarantined from the
// secret store by scripts/check-isolation.mjs.
// ---------------------------------------------------------------------------

const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";

interface OpenAiOutputItem {
  type?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  status?: string;
}

interface OpenAiResponse {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: OpenAiOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * THE OUTPUT CAP IS A TRANSPORT CONCERN, NOT A TASK CHANGE — same reasoning
 * as xai.ts's outputCap. gpt-6-astra's reasoning tokens are charged against
 * max_output_tokens; a cap sized for Haiku's answer would truncate the
 * reasoning before the function call is ever emitted, and that would be
 * misattributed to the model playing badly.
 */
function outputCap(requested: number | undefined): number {
  return Math.max(requested ?? 1024, env.openaiMaxOutputTokensRacer());
}

function nonNegativeIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Normalise an OpenAI Responses `usage` object into Barkóba's provider-neutral
 * shape. OpenAI's `input_tokens` INCLUDES the cached share; Barkóba's
 * `input_tokens` is the uncached, full-rate share, so the cached count is
 * subtracted here. Anything the provider did not report stays null — never
 * zero — so a missing figure is recorded as unknown.
 */
export function readOpenAiUsage(usage: OpenAiResponse["usage"]): ModelCallUsage {
  const totalInput = nonNegativeIntOrNull(usage?.input_tokens);
  const cached = nonNegativeIntOrNull(usage?.input_tokens_details?.cached_tokens);
  return {
    input_tokens:
      totalInput === null ? null : Math.max(0, totalInput - (cached ?? 0)),
    cached_input_tokens: cached,
    // OpenAI has no cache-write concept to bill; the field is not applicable
    // rather than unknown, and lib/aiCost.ts treats null cache writes as 0.
    cache_write_input_tokens: null,
    output_tokens: nonNegativeIntOrNull(usage?.output_tokens),
    reasoning_tokens: nonNegativeIntOrNull(usage?.output_tokens_details?.reasoning_tokens),
  };
}

export const openaiAdapter: ProviderAdapter = {
  id: "openai",

  async callTool<T>(request: ToolCallRequest): Promise<ToolCallResult<T>> {
    const apiKey = env.openaiApiKey();
    if (!apiKey) {
      // Should be unreachable: game creation refuses an unavailable provider.
      // Kept because "unreachable" and "cannot happen" are different claims,
      // and the failure must never be a silent fallback to another model.
      throw new Error(
        "OpenAI provider selected but OPENAI_API_KEY is not configured in this runtime."
      );
    }

    const effort = request.reasoningEffort ?? env.openaiReasoningEffortRacer();
    const maxOutputTokens = outputCap(request.maxTokens);

    const body = {
      model: request.model,
      // Difference 1. The TEXT is untouched — an adapter transports a prompt,
      // it never authors one.
      instructions: request.system,
      input: request.messages.map((m) => ({ role: m.role, content: m.content })),
      tools: [
        {
          // Difference 2 (flat) and 8 (strict:false, schema byte-identical).
          type: "function",
          name: request.toolName,
          description: request.toolDescription,
          parameters: request.inputSchema,
          strict: false,
        },
      ],
      // Difference 3.
      tool_choice: { type: "function", name: request.toolName },
      // Difference 5. One move per turn.
      parallel_tool_calls: false,
      // Difference 6. Server-held effort; see the module doc.
      reasoning: { effort },
      max_output_tokens: maxOutputTokens,
      store: false,
      stream: false,
    };

    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      // S2 / RB-2 — local deadline only; see ToolCallRequest.signal's own doc
      // for what this does and does not claim about OpenAI's remote inference.
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });

    if (!response.ok) {
      const errText = await response.text();
      // Same contract as the other adapters: throw with status and body. The
      // /turn route catches this and returns 502 racer_unavailable with the
      // player's recorded answer preserved. No retry is added here — a
      // provider-specific retry would make failure rates incomparable.
      throw new Error(
        `OpenAI API error (${response.status}) for tool ${request.toolName}: ${errText}`
      );
    }

    const data = (await response.json()) as OpenAiResponse;

    // Provenance first, before any parse below can throw, so a truncated or
    // malformed response still says which model produced it.
    let resolvedModel = request.model;
    if (typeof data.model === "string" && data.model.length > 0) {
      resolvedModel = data.model;
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[barkoba] OpenAI response omitted a model id for ${request.toolName}; ` +
          `provenance falls back to the requested id (${request.model}). ` +
          "Resolved identity is unconfirmed for this turn."
      );
    }

    const usage = readOpenAiUsage(data.usage);
    const incompleteReason =
      data.status === "incomplete" ? (data.incomplete_details?.reason ?? "unknown") : null;

    // Difference 7.
    if (incompleteReason === "max_output_tokens") {
      // eslint-disable-next-line no-console
      console.warn(
        `[barkoba] OpenAI ${request.toolName} hit max_output_tokens (${maxOutputTokens}). ` +
          `output_tokens=${usage.output_tokens ?? "?"}, reasoning_tokens=${usage.reasoning_tokens ?? "?"}. ` +
          "Output was truncated — raise OPENAI_MAX_OUTPUT_TOKENS_RACER."
      );
    }

    const diagnostics: ToolCallResult<T>["diagnostics"] = {
      finishReason: incompleteReason ? `incomplete:${incompleteReason}` : (data.status ?? undefined),
      completionTokens: usage.output_tokens ?? undefined,
      reasoningTokens: usage.reasoning_tokens ?? undefined,
      usage,
      effortSent: effort,
      requestMode: "forced_tool",
    };

    const calls = (data.output ?? []).filter((item) => item.type === "function_call");
    const call = calls[0];
    if (!call?.arguments) {
      throw new Error(
        `OpenAI did not return a function call for ${request.toolName}. ` +
          `status=${data.status ?? "?"}${incompleteReason ? ` (incomplete: ${incompleteReason})` : ""}`
      );
    }

    // The forced tool is the only acceptable one. A different name is a
    // contract violation, not a move — refuse it rather than parse it.
    if (call.name !== request.toolName) {
      throw new Error(
        `OpenAI returned function "${call.name ?? "?"}" instead of the forced tool ${request.toolName}.`
      );
    }

    // Difference 4. Fail loudly rather than returning a half-parsed turn: a
    // malformed move must look like a failed call, not like a bad question.
    let output: T;
    try {
      output = JSON.parse(call.arguments) as T;
    } catch (err) {
      throw new Error(
        `OpenAI returned unparseable function arguments for ${request.toolName}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (output === null || typeof output !== "object") {
      throw new Error(
        `OpenAI returned non-object function arguments for ${request.toolName}.`
      );
    }

    return { output, resolvedModel, diagnostics };
  },
};
