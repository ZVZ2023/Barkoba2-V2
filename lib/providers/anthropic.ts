import { env } from "../env";
import type {
  ModelCallUsage,
  ProviderAdapter,
  ToolCallRequest,
  ToolCallResult,
} from "./types";

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
//
// ---------------------------------------------------------------------------
// V2.8.7 — FORCED TOOL CHOICE IS REJECTED ON CLAUDE FABLE 5.1
// ---------------------------------------------------------------------------
//
// Claude Fable 5.1 (`claude-fable-5-1`, the V2.8.7 adjudication model) returns
// HTTP 400 for `tool_choice: {type:"tool"}` and `{type:"any"}`:
//
//   tool_choice: type "tool" and "any" are not supported for this model.
//
// Anthropic's documented migration is `tool_choice: auto`, `strict: true` on
// the tool (with `additionalProperties: false`) so the arguments stay
// schema-valid, and an explicit instruction that the tool call is required.
// That is exactly what this wrapper does, with the SAME self-healing shape
// as the sampling-parameter rule above, per model, learned at runtime:
//
//   1. The request is sent in FORCED mode — byte-identical to what every
//      call sent before V2.8.7.
//   2. If the API rejects the tool_choice as unsupported, the model is
//      recorded, a warning is logged once, and the request is retried in
//      AUTO+STRICT mode: tool_choice auto with parallel tool use disabled,
//      strict:true plus additionalProperties:false on the one tool, and a
//      RESPONSE CONTRACT paragraph appended to the system prompt naming the
//      tool. Nothing else in the prompt changes.
//   3. Every later call for that model goes straight to auto+strict mode.
//
// In BOTH modes the returned tool_use block must carry the expected tool name
// and an object input; anything else throws. A model that answers in prose
// under auto mode therefore fails exactly like a transport error — the caller's
// existing "unavailable" path — and never becomes an accepted verdict.
//
// REFUSALS ARE FAILURES, NOT FALLBACKS. Claude Fable 5.1 can return a
// successful HTTP 200 with stop_reason "refusal". This wrapper throws
// AnthropicRefusalError for it: no substitute model, no automatic retry, no
// inferred result. The usage the provider reported for that call is still
// handed to onCallObserved first, so a billed refusal is recorded as billed.
//
// EFFORT. `effort` becomes `output_config: {effort}` when set; unset means
// the request is unchanged (Fable 5.1 then runs at its default, "high").
//
// USAGE. Every 200 response's `usage` is normalised (readAnthropicUsage) and
// handed to the optional onCallObserved callback, alongside the resolved
// model, stop reason, and which request mode actually produced the answer —
// the raw material for per-game cost accounting (lib/aiCost.ts). Optional so
// the call sites that do not record cost are untouched.
// ---------------------------------------------------------------------------

export type AnthropicRequestMode = "forced_tool" | "auto_strict_tool";

/**
 * Observable, non-sensitive facts about one completed HTTP 200 call. Never
 * carries prompt text, the tool input, or the target.
 */
export interface AnthropicCallObservation {
  resolvedModel: string;
  stopReason: string | null;
  usage: ModelCallUsage;
  requestMode: AnthropicRequestMode;
  effort: string | null;
}

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
   * V2.8.7 — `output_config.effort` ("low" | "medium" | "high" | "xhigh" |
   * "max"). Sent only when defined; unset leaves the request unchanged.
   */
  effort?: string;
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
  /**
   * V2.8.7 — receives usage/provenance for every HTTP 200 response, INCLUDING
   * a refusal (which is billed when it happens mid-output) and a response
   * that later fails validation. Called before any parse below can throw.
   */
  onCallObserved?: (observation: AnthropicCallObservation) => void;
  /**
   * S2 / RB-2 — see ToolCallRequest.signal's own doc for the exact contract:
   * a local deadline only, never a claim about Anthropic's remote inference
   * or its billing. Passed straight to fetch() when defined; unset means
   * every request built before S2 is byte-identical.
   */
  signal?: AbortSignal;
}

/** Every call this wrapper makes goes to Anthropic. One constant, one source. */
export const MODEL_PROVIDER = "anthropic";

/**
 * V2.8.7 — thrown when the API answers 200 with stop_reason "refusal". Not a
 * transport error and not a malformed response: the model declined. Callers
 * treat it as an explicit failure of the call it was made for.
 */
export class AnthropicRefusalError extends Error {
  readonly category: string | null;
  constructor(toolName: string, category: string | null) {
    super(
      `Anthropic refused the ${toolName} call (stop_reason=refusal` +
        `${category ? `, category=${category}` : ""}). No fallback model is used.`
    );
    this.name = "AnthropicRefusalError";
    this.category = category;
  }
}

/** Models observed to reject sampling parameters, learned at runtime. */
const modelsRejectingSamplingParams = new Set<string>();
/** Models observed to reject forced tool choice, learned at runtime. */
const modelsRejectingForcedToolChoice = new Set<string>();
const warnedModels = new Set<string>();
const warnedToolChoiceModels = new Set<string>();

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

/**
 * Does this error say the request failed *because* forced tool choice is not
 * supported by the model? Same narrowness rule as isSamplingParamRejection.
 */
export function isForcedToolChoiceRejection(status: number, body: string): boolean {
  if (status !== 400) return false;
  const text = body.toLowerCase();
  if (!text.includes("tool_choice")) return false;
  return text.includes("not supported") || text.includes("unsupported");
}

/** Test seam: forget what has been learned about every model. */
export function resetSamplingParamCache(): void {
  modelsRejectingSamplingParams.clear();
  modelsRejectingForcedToolChoice.clear();
  warnedModels.clear();
  warnedToolChoiceModels.clear();
}

/**
 * Models KNOWN (from Anthropic's own migration guide) to reject forced tool
 * choice. A call to one of these opens directly in auto+strict mode — no
 * deliberately-unsupported forced request is ever sent first. Prefix match,
 * so a dated snapshot id resolves. The runtime self-heal below remains as the
 * safety net for any model not listed here.
 */
const KNOWN_FORCED_TOOL_CHOICE_REJECTING_MODELS = ["claude-fable-5-1", "claude-mythos-5-1"];

/** Which mode the next call for `model` opens with. */
export function requestModeFor(model: string): AnthropicRequestMode {
  if (KNOWN_FORCED_TOOL_CHOICE_REJECTING_MODELS.some((prefix) => model.startsWith(prefix))) {
    return "auto_strict_tool";
  }
  return modelsRejectingForcedToolChoice.has(model) ? "auto_strict_tool" : "forced_tool";
}

function nonNegativeIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Normalise a Messages API `usage` object. Anthropic's `input_tokens` already
 * EXCLUDES cache reads and writes, so the four figures map one-to-one. A
 * figure the provider did not report stays null — unknown, never zero.
 */
export function readAnthropicUsage(usage: unknown): ModelCallUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const outputDetails = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  return {
    input_tokens: nonNegativeIntOrNull(u.input_tokens),
    cached_input_tokens: nonNegativeIntOrNull(u.cache_read_input_tokens),
    cache_write_input_tokens: nonNegativeIntOrNull(u.cache_creation_input_tokens),
    output_tokens: nonNegativeIntOrNull(u.output_tokens),
    reasoning_tokens: nonNegativeIntOrNull(outputDetails.thinking_tokens),
  };
}

/**
 * The one paragraph auto+strict mode appends to the system prompt. Named the
 * tool explicitly, per Anthropic's migration guidance; nothing about the
 * judgment rules above it changes.
 */
export function responseContractInstruction(toolName: string): string {
  return (
    "\n\nRESPONSE CONTRACT\n" +
    `Respond by calling the \`${toolName}\` tool exactly once, with every field filled in. ` +
    "Do not answer in prose, and do not call any other tool."
  );
}

export async function callAnthropicTool<T>(
  params: AnthropicToolCallParams
): Promise<T> {
  const send = async (includeSampling: boolean, mode: AnthropicRequestMode) => {
    const forced = mode === "forced_tool";
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? 1024,
      system: forced ? params.system : params.system + responseContractInstruction(params.toolName),
      messages: params.messages,
      tools: [
        forced
          ? {
              name: params.toolName,
              description: params.toolDescription,
              input_schema: params.inputSchema,
            }
          : {
              name: params.toolName,
              description: params.toolDescription,
              strict: true,
              input_schema: { ...params.inputSchema, additionalProperties: false },
            },
      ],
      tool_choice: forced
        ? { type: "tool", name: params.toolName }
        : { type: "auto", disable_parallel_tool_use: true },
    };

    if (includeSampling && params.temperature !== undefined) {
      body.temperature = params.temperature;
    }
    if (params.effort !== undefined) {
      body.output_config = { effort: params.effort };
    }

    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.anthropicApiKey(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      // S2 / RB-2 — local deadline only; see AnthropicToolCallParams.signal.
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
  };

  let includeSampling =
    params.temperature !== undefined &&
    !modelsRejectingSamplingParams.has(params.model);
  let mode = requestModeFor(params.model);

  let response = await send(includeSampling, mode);

  // At most two compatibility retries, each for a DISTINCT, recognised
  // rejection (sampling params, then forced tool choice). Any other error —
  // or a third failure — throws exactly as before.
  for (let heal = 0; heal < 2 && !response.ok; heal += 1) {
    const status = response.status;
    const errText = await response.text();

    if (includeSampling && isSamplingParamRejection(status, errText)) {
      modelsRejectingSamplingParams.add(params.model);
      includeSampling = false;
      if (!warnedModels.has(params.model)) {
        warnedModels.add(params.model);
        // eslint-disable-next-line no-console
        console.warn(
          `[barkoba] ${params.model} has deprecated sampling parameters; ` +
            "retrying without them. Determinism for judgment calls is carried " +
            "by the system prompt and measured via --repeat, not by temperature."
        );
      }
      response = await send(includeSampling, mode);
      continue;
    }

    if (mode === "forced_tool" && isForcedToolChoiceRejection(status, errText)) {
      modelsRejectingForcedToolChoice.add(params.model);
      mode = "auto_strict_tool";
      if (!warnedToolChoiceModels.has(params.model)) {
        warnedToolChoiceModels.add(params.model);
        // eslint-disable-next-line no-console
        console.warn(
          `[barkoba] ${params.model} rejects forced tool choice; retrying in ` +
            "auto+strict tool mode with an explicit response contract. " +
            "The tool name and payload are still validated on the way back."
        );
      }
      response = await send(includeSampling, mode);
      continue;
    }

    throw new Error(
      `Anthropic API error (${status}) for tool ${params.toolName}: ${errText}`
    );
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Anthropic API error (${response.status}) for tool ${params.toolName} ` +
        `after compatibility retries: ${errText}`
    );
  }

  const data = await response.json();

  // V2.5 provenance. Reported before any parsing below can throw, so a
  // truncated or malformed response still tells us which model produced it.
  // Falls back to the requested id when the response omits `model`.
  const resolved = typeof data.model === "string" && data.model.length > 0
    ? data.model
    : params.model;
  if (params.onModelResolved) {
    params.onModelResolved(resolved);
  }

  const stopReason = typeof data.stop_reason === "string" ? data.stop_reason : null;

  // V2.8.7 — observed before any validation below can throw, so a refusal or
  // a malformed response still has its billed usage recorded.
  if (params.onCallObserved) {
    params.onCallObserved({
      resolvedModel: resolved,
      stopReason,
      usage: readAnthropicUsage(data.usage),
      requestMode: mode,
      effort: params.effort ?? null,
    });
  }

  if (stopReason === "refusal") {
    const category = data.stop_details?.category;
    throw new AnthropicRefusalError(
      params.toolName,
      typeof category === "string" ? category : null
    );
  }

  // DIAGNOSTIC ONLY (0.3.0.12) — no behavioural change.
  //
  // Adaptive thinking is on by default on current models, and thinking tokens
  // count against max_tokens. A max_tokens sized for a no-thinking response can
  // therefore truncate once the model starts reasoning on a hard case. This
  // logs the evidence rather than leaving it to be inferred.
  if (stopReason === "max_tokens") {
    const thinkingTokens = data.usage?.output_tokens_details?.thinking_tokens;
    // eslint-disable-next-line no-console
    console.warn(
      `[barkoba] ${params.toolName} hit max_tokens (${params.maxTokens ?? 1024}). ` +
        `output_tokens=${data.usage?.output_tokens ?? "?"}` +
        (thinkingTokens !== undefined ? `, thinking_tokens=${thinkingTokens}` : "") +
        ". Output was truncated — raise max_tokens or lower effort."
    );
  }

  const blocks: Array<Record<string, unknown>> = Array.isArray(data.content) ? data.content : [];
  const toolUseBlocks = blocks.filter((block) => block.type === "tool_use");
  const toolUseBlock = toolUseBlocks.find((block) => block.name === params.toolName);

  if (!toolUseBlock) {
    const otherNames = toolUseBlocks
      .map((block) => (typeof block.name === "string" ? block.name : "?"))
      .join(", ");
    throw new Error(
      `Anthropic API did not return a tool_use block for ${params.toolName}` +
        (otherNames ? ` (returned: ${otherNames})` : "") +
        `. stop_reason=${stopReason ?? "?"}, request_mode=${mode}.`
    );
  }

  const input = toolUseBlock.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      `Anthropic API returned a non-object input for ${params.toolName}. request_mode=${mode}.`
    );
  }

  return input as T;
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
    const observed: { value: AnthropicCallObservation | null } = { value: null };

    const output = await callAnthropicTool<T>({
      ...request,
      effort: request.reasoningEffort,
      onModelResolved: (id) => {
        resolvedModel = id;
      },
      onCallObserved: (observation) => {
        observed.value = observation;
      },
    });

    const o = observed.value;
    return {
      output,
      resolvedModel,
      diagnostics: o
        ? {
            finishReason: o.stopReason ?? undefined,
            completionTokens: o.usage.output_tokens ?? undefined,
            reasoningTokens: o.usage.reasoning_tokens ?? undefined,
            usage: o.usage,
            effortSent: o.effort ?? undefined,
            requestMode: o.requestMode,
          }
        : undefined,
    };
  },
};
