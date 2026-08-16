// ---------------------------------------------------------------------------
// V2.5-B2 — the model-provider boundary.
//
// WHAT THIS IS FOR: Barkóba must stop equating "AI player" with Anthropic. The
// AI Racer seat should be fillable by a chosen provider, so that Claude-vs-Grok
// is a comparison the corpus can actually record rather than a claim nobody can
// check.
//
// WHY THE INTERFACE LOOKS SO ORDINARY: it is not new. `AnthropicToolCallParams`
// was already provider-neutral in every field — model, system, messages, a tool
// name, a description, a JSON Schema, an output cap. Nothing in it was ever
// Anthropic-specific. This file mostly renames what was already true and gives
// it a second possible implementation.
//
// ---------------------------------------------------------------------------
// THE LINE THIS BOUNDARY MUST NOT CROSS
// ---------------------------------------------------------------------------
//
// An adapter transports a request. It does NOT author one.
//
// The system prompt, the input schema, the transcript rendering and the prompt
// version are built ONCE, provider-neutrally, in lib/prompts/racer.ts, and are
// handed to whichever adapter is selected. No adapter may rewrite, normalise,
// translate, or "fix up" any of them for its own vendor.
//
// That is not tidiness. It is the validity condition of the whole experiment:
// if two providers receive different prompts or different schemas, the result
// measures prompt×model and not model, and every conclusion drawn from the
// corpus about which Racer reasons better is unfounded. A test asserts the
// system prompt reaching each adapter is byte-identical.
// ---------------------------------------------------------------------------

/**
 * Providers Barkóba can currently route a seat to.
 *
 * A member may only be added together with its adapter: the registry is an
 * exhaustive `Record<ModelProviderId, ProviderAdapter>`, so a union member with
 * no implementation does not compile. B2 shipped this as a one-member union for
 * exactly that reason; B3 adds "xai" and lib/providers/xai.ts in one change.
 */
export type ModelProviderId = "anthropic" | "xai";

/**
 * One forced-tool call, described in vendor-neutral terms.
 *
 * Note what is absent: `onModelResolved`. That callback exists on the Anthropic
 * client because V2.5 needed provenance without touching six unrelated call
 * sites, and an optional callback was the only change that cost them nothing.
 * Now that a second implementation is possible, resolved-model identity is part
 * of the RESULT rather than a side channel — see ToolCallResult.
 */
export interface ToolCallRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
  /**
   * Requested only. Providers that have deprecated sampling parameters drop it;
   * how they do so is their own business and must not leak out of the adapter.
   */
  temperature?: number;
}

export interface ToolCallResult<T> {
  /** The tool input the model produced, typed by the caller. */
  output: T;
  /**
   * The model the API REPORTED having used — not the alias that was requested.
   *
   * These differ whenever a configured id resolves to a dated snapshot, and only
   * the resolved one is evidence of what actually played. Every adapter must
   * report the response's own model id, falling back to the requested id only
   * when the response omits it.
   */
  resolvedModel: string;
}

/**
 * One provider's transport.
 *
 * `id` is what lands in corpus.game_turns.model_provider, so an adapter's
 * identity and the recorded evidence cannot drift apart — there is no second
 * place where a provider name is written down.
 */
export interface ProviderAdapter {
  readonly id: ModelProviderId;
  callTool<T>(request: ToolCallRequest): Promise<ToolCallResult<T>>;
}
