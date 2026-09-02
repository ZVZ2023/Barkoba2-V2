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
  /**
   * How much the model should think before answering, where the provider
   * exposes such a control. xAI's grok-4.6 and grok-4.5 take
   * "low" | "medium" | "high" | "xhigh" and default to "high" when unset — so
   * every Grok turn Barkóba has ever played ran at maximum effort.
   *
   * UNSET MUST MEAN UNCHANGED. An adapter may only send this when it is
   * defined; leaving it out has to produce a byte-identical request to the one
   * production sends today. A test asserts that.
   *
   * Providers without the concept ignore it. It is NOT a sampling parameter and
   * has nothing to do with `temperature`.
   */
  reasoningEffort?: string;
  /**
   * S2 / RB-2 — a LOCAL deadline only. When provided, an adapter must pass
   * this straight to its own transport's abort mechanism (fetch's `signal`
   * option) so Barkóba stops waiting once the caller's shared provider
   * budget (lib/turnBudget.ts) runs out.
   *
   * THIS DOES NOT CANCEL THE REMOTE PROVIDER'S INFERENCE, AND MUST NEVER BE
   * DESCRIBED AS DOING SO. Aborting a fetch closes Barkóba's own connection;
   * whether xAI or Anthropic actually stop computing, or whether the call is
   * still billed, is unconfirmed by either provider's public documentation
   * as of the S2 read-only discovery pass. An adapter may only USE this to
   * stop waiting locally — it must not claim, log, or imply cancellation
   * upstream.
   *
   * UNSET MEANS UNCHANGED, exactly like `reasoningEffort`: an adapter must
   * only pass `signal` to its transport when this is defined, so a caller
   * that never sets it (every existing script and test) gets a
   * byte-identical request to what production sent before S2.
   */
  signal?: AbortSignal;
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
  /**
   * Raw observable facts about the call, where the provider reports them.
   *
   * OPTIONAL AND UNUSED BY THE GAME. Nothing in the turn loop reads this; it
   * exists so a diagnostic harness can see why a call was slow without the
   * adapter having to be reimplemented outside the code path it is testing.
   * Populated best-effort — an absent field means the provider did not say,
   * never that the value was zero.
   */
  diagnostics?: {
    finishReason?: string;
    completionTokens?: number;
    reasoningTokens?: number;
  };
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
