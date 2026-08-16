import { anthropicAdapter } from "./anthropic";
import { xaiAdapter } from "./xai";
import { env } from "../env";
import type { ModelProviderId, ProviderAdapter } from "./types";

// ---------------------------------------------------------------------------
// V2.5-B2 — the provider registry.
//
// One lookup, one place where a provider id becomes a transport. Deliberately
// shaped like lib/kv.ts and lib/corpus/db.ts: a narrow seam, resolved centrally,
// so route handlers and prompt modules never construct a client.
//
// ANTHROPIC IS THE ONLY ENTRY, ON PURPOSE. B2's entire acceptance criterion is
// that nothing changed — 513 tests passing unmodified. Registering a second
// provider in the same task would mean a regression could be blamed on either
// the refactor or the new vendor, and neither could be ruled out.
//
// WHAT THE REGISTRY IS *NOT* FOR. This resolves transport only. It says nothing
// about which seat may use which provider, and it must never grow that opinion:
//
//   - The AI Composer, Validator, Adjudicator and Integrity Review stay on
//     Anthropic permanently, and not for convenience. They are the MEASURING
//     INSTRUMENT. If the judge changes when the player changes, Claude-vs-Grok
//     is not a controlled comparison and nothing the corpus records about it
//     means anything. The adjudication fixture corpus is calibrated against
//     Anthropic and is Barkóba's only regression harness for judgment quality.
//
//   - The Composer path is also a PERMITTED SECRET CALL SITE: it receives the
//     locked target on every turn. Keeping it on one provider is what makes
//     "the secret never leaves Anthropic" a structural property rather than a
//     hope. Routing the Composer through this registry to tidy things up would
//     silently destroy that guarantee.
//
// Both facts are recorded here because this file is where a future reader will
// be tempted to generalise.
// ---------------------------------------------------------------------------

/**
 * Exhaustive by construction. A Record keyed on ModelProviderId cannot compile
 * once B3 adds "xai" to the union without also supplying the adapter — which is
 * why the union is the one-member type it is today rather than a forward
 * declaration of intent.
 */
const REGISTRY: Record<ModelProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  xai: xaiAdapter,
};

/** The default seat provider, and the behaviour of every game recorded so far. */
export const DEFAULT_RACER_PROVIDER: ModelProviderId = "anthropic";

/**
 * Resolve a provider id to its transport.
 *
 * THROWS on an unknown id rather than falling back. A silent fallback would
 * mean a game believed to have been played by one provider was played by
 * another — evidence that looks like data and is not. The same rule governs the
 * B3 selection path: an unavailable provider refuses the game, it does not
 * quietly substitute a different player.
 */
export function getAdapter(id: ModelProviderId): ProviderAdapter {
  // OWN-PROPERTY CHECK, NOT A TRUTHINESS CHECK. `REGISTRY[id]` walks the
  // prototype chain, so a request body of {"racer_provider":"constructor"}
  // would resolve to Object.prototype.constructor — a function, therefore
  // truthy, therefore returned as if it were an adapter. In B3 this id arrives
  // from an HTTP body and from a stored record, so the cheap guard is the
  // correct one.
  if (!isModelProviderId(id)) {
    throw new Error(`Unknown model provider: ${id}`);
  }
  return REGISTRY[id];
}

/**
 * Is this a provider Barkóba can actually route to?
 *
 * The validator for B3's request body, and the guard inside getAdapter — one
 * definition of "registered", so the check at the edge and the check at the
 * lookup cannot disagree.
 */
export function isModelProviderId(value: unknown): value is ModelProviderId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REGISTRY, value);
}

/**
 * Is this provider usable by THIS runtime — registered AND credentialled?
 *
 * Registration and availability are different questions and must stay separate.
 * A provider can be a legitimate choice in the code and unusable in a given
 * deployment because its key was never set, and conflating the two would either
 * hide a real option or offer one that cannot run.
 *
 * WHAT THIS IS FOR, AND THE RULE IT ENFORCES: game creation calls this and
 * REFUSES when it returns false. It must never be used to pick a substitute.
 * Silently starting an Anthropic game because Grok was unavailable would put a
 * game in the corpus attributed to a player that never played it — evidence
 * that looks like data and is not, and the one failure mode that would make
 * the whole Claude-vs-Grok comparison worthless.
 */
export function isProviderAvailable(id: ModelProviderId): boolean {
  if (!isModelProviderId(id)) return false;
  // Anthropic's key is required for the referees and the Composer regardless of
  // seat choice, so a runtime that cannot reach Anthropic is broken in ways
  // this flag is not the right place to report.
  if (id === "anthropic") return true;
  return env.xaiApiKey() !== null;
}

export type { ModelProviderId, ProviderAdapter, ToolCallRequest, ToolCallResult } from "./types";
