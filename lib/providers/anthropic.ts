import { env } from "../env";
import type { ProviderAdapter, ToolCallRequest, ToolCallResult } from "./types";

// ---------------------------------------------------------------------------
// Thin wrapper over the Messages API. Every structured call in this app
// (Validator, Racer, Adjudicator, Integrity Review) uses forced tool-use so
// we get typed JSON back instead of parsing free text. This matters most for
// the Racer: it's what makes the Guess Detector's heuristic pass reliable —
// action is a declared enum field, not something inferred from prose.
//
// ---------------------------------------------------------------------------
// V2.5-B2 — MOVED, NOT CHANGED.
//
// This file was lib/anthropic.ts until the provider boundary existed. Its body
// is unaltered: same endpoint, same headers, same request shape, same
// self-healing, same errors, same diagnostics. Only the import path moved, and
// lib/anthropic.ts still re-exports everything, so the eight call sites that
// are NOT part of the Racer seat — Validator, Adjudicator, Integrity Review,
// AI Composer, question-edit judge — did not have to be edited at all.
//
// That was the point of doing the move this way. A refactor whose acceptance
// criterion is "513 tests pass UNMODIFIED" cannot afford to touch call sites it
// does not need to touch.
//
// ---------------------------------------------------------------------------
// SAMPLING PARAMETERS ARE DEPRECATED ON CURRENT MODELS
// ---------------------------------------------------------------------------
//
// Claude Sonnet 5 and Claude 4.7+ reject non-default `temperature`, `top_p`,
// and `top_k` with HTTP 400. Adaptive thinking requires the model to control
// its own sampling during reasoning, and an external override conflicts with
// that. Anthropic's documented replacement for behaviour previously controlled
// through sampling is system-prompt instruction, which is what the judgment
// prompts now use.
//
// This wrapper does NOT hard-code that assumption, because model IDs in this
// project are env-configurable by design (ANTHROPIC_MODEL_RACER /
// ANTHROPIC_MODEL_STRONG) and older models still accept sampling params. It
// is self-healing instead:
//
//   1. If a caller asks for a temperature, it is sent.
//   2. If the API rejects it as deprecated/unsupported, the model is recorded,
//      a warning is logged once, and the request is retried without sampling
//      params.
//   3. Every later call for that model skips sampling params outright — so the
//      cost is one extra request per model per process, not per call.
//
// The result: pointing ANTHROPIC_MODEL_STRONG at an old or new model both work,
// and neither requires a config change.
// ---------------------------------------------------------------------------

interface AnthropicToolCallParams {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
  /**
   * Requested only. Silently dropped on models that have deprecated sampling
   * parameters — see the note above. Determinism for judgment calls is carried
   * by the system prompt, not by this field, and is verified empirically by
   * `npm run eval:adjudicator -- --repeat N`.
   */
  temperature?: number;
  /**
   * V2.5 — receives the model the API reported having used, once, on success.
   *
   * OPTIONAL SO NOTHING ELSE CHANGES. Eight call sites use this wrapper; only
   * the two that write turn provenance pass a callback, and the other six are
   * untouched. Widening the return type instead would have forced every caller
   * to unwrap a result it does not need.
   *
   * WHY THE RESPONSE MODEL AND NOT `params.model`: they differ whenever a
   * configured alias resolves to a dated snapshot, and only the resolved id is
   * evidence of what actually played. The V2.5-1 audit found neither recorded
   * anywhere; recording the weaker of the two would have been a half-fix.
   */
  onModelResolved?: (modelId: string) => void;
}

/** Every call this wrapper makes goes to Anthropic. One constant, one source. */
export const MODEL_PROVIDER = "anthropic";

/** Models observed to reject sampling parameters, learned at runtime. */
const modelsRejectingSamplingParams = new Set<string>();
const warnedModels = new Set<string>();

/**
 * Does this error say the request failed *because* of sampling parameters?
 *
 * Exported and pure so it can be unit-tested without a network call. Kept
 * deliberately narrow: a 400 for some other reason must NOT be silently
 * retried, or a real bad-request bug would be masked as a compatibility quirk.
 */
export function isSamplingParamRejection(status: number, body: string): boolean {
  if (status !== 400) return false;
  const text = body.toLowerCase();
  const mentionsSampling =
    text.includes("temperature") || text.includes("top_p") || text.includes("top_k");
  if (!mentionsSampling) return false;
  return (
    text.includes("deprecat") ||
    text.includes("not supported") ||
    text.includes("unsupported") ||
    text.includes("only the default") ||
    text.includes("default value")
  );
}

/** Test seam: forget what has been learned about a model. */
export function resetSamplingParamCache(): void {
  modelsRejectingSamplingParams.clear();
  warnedModels.clear();
}

export async function callAnthropicTool<T>(
  params: AnthropicToolCallParams
): Promise<T> {
  const send = async (includeSampling: boolean) => {
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? 1024,
      system: params.system,
      messages: params.messages,
      tools: [
        {
          name: params.toolName,
          description: params.toolDescription,
          input_schema: params.inputSchema,
        },
      ],
      tool_choice: { type: "tool", name: params.toolName },
    };

    if (includeSampling && params.temperature !== undefined) {
      body.temperature = params.temperature;
    }

    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.anthropicApiKey(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
  };

  const wantsSampling =
    params.temperature !== undefined &&
    !modelsRejectingSamplingParams.has(params.model);

  let response = await send(wantsSampling);

  if (!response.ok) {
    const errText = await response.text();

    if (wantsSampling && isSamplingParamRejection(response.status, errText)) {
      modelsRejectingSamplingParams.add(params.model);
      if (!warnedModels.has(params.model)) {
        warnedModels.add(params.model);
        // eslint-disable-next-line no-console
        console.warn(
          `[barkoba] ${params.model} has deprecated sampling parameters; ` +
            "retrying without them. Determinism for judgment calls is carried " +
            "by the system prompt and measured via --repeat, not by temperature."
        );
      }
      response = await send(false);
      if (!response.ok) {
        const retryErr = await response.text();
        throw new Error(
          `Anthropic API error (${response.status}) for tool ${params.toolName} ` +
            `after dropping sampling params: ${retryErr}`
        );
      }
    } else {
      throw new Error(
        `Anthropic API error (${response.status}) for tool ${params.toolName}: ${errText}`
      );
    }
  }

  const data = await response.json();

  // V2.5 provenance. Reported before any parsing below can throw, so a
  // truncated or malformed response still tells us which model produced it.
  // Falls back to the requested id when the response omits `model`.
  if (params.onModelResolved) {
    const resolved = typeof data.model === "string" && data.model.length > 0
      ? data.model
      : params.model;
    params.onModelResolved(resolved);
  }

  // DIAGNOSTIC ONLY (0.3.0.12) — no behavioural change.
  //
  // Adaptive thinking is on by default on current models, and thinking tokens
  // count against max_tokens. A max_tokens sized for a no-thinking response can
  // therefore truncate once the model starts reasoning on a hard case. This
  // logs the evidence rather than leaving it to be inferred.
  if (data.stop_reason === "max_tokens") {
    const thinkingTokens = data.usage?.output_tokens_details?.thinking_tokens;
    // eslint-disable-next-line no-console
    console.warn(
      `[barkoba] ${params.toolName} hit max_tokens (${params.maxTokens ?? 1024}). ` +
        `output_tokens=${data.usage?.output_tokens ?? "?"}` +
        (thinkingTokens !== undefined ? `, thinking_tokens=${thinkingTokens}` : "") +
        ". Output was truncated — raise max_tokens or lower effort."
    );
  }

  const toolUseBlock = (data.content as Array<Record<string, unknown>>).find(
    (block) => block.type === "tool_use"
  );

  if (!toolUseBlock) {
    throw new Error(
      `Anthropic API did not return a tool_use block for ${params.toolName}. ` +
        `Raw content: ${JSON.stringify(data.content)}`
    );
  }

  return toolUseBlock.input as T;
}

// ---------------------------------------------------------------------------
// The adapter.
//
// A thin bridge over callAnthropicTool rather than a reimplementation of it.
// Two callers now exist for the same transport and they want different shapes:
//
//   - the six out-of-scope judgment/Composer call sites want the tool input and
//     nothing else, exactly as they always have;
//   - the Racer seat wants the resolved model id as well, because it writes
//     provenance.
//
// Rewriting the client to return a wrapper everywhere would have forced six
// untouched call sites to unwrap a result they do not use — churn in code this
// task is explicitly not allowed to change.
// ---------------------------------------------------------------------------
export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",

  async callTool<T>(request: ToolCallRequest): Promise<ToolCallResult<T>> {
    // Seeded with the REQUESTED id so a provider that omits `model` from its
    // response still yields honest provenance rather than an empty string.
    let resolvedModel = request.model;

    const output = await callAnthropicTool<T>({
      ...request,
      onModelResolved: (id) => {
        resolvedModel = id;
      },
    });

    return { output, resolvedModel };
  },
};
