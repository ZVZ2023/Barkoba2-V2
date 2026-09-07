import type { ModelProviderId } from "./providers/types";

// ---------------------------------------------------------------------------
// V2.8.8.7 — COST-SAFE AI ENGINE SELECTION.
//
// A STABLE INTERNAL IDENTIFIER, NEVER A PUBLIC LABEL OR A RAW PROVIDER/MODEL
// NAME. "standard" and "premium" are the only two values that ever cross an
// API boundary; the Hungarian public label ("Emberi szintű AI"), the actual
// provider, and the actual model id all live elsewhere and are resolved from
// this id, never sent alongside it. A client that requests "premium" learns
// nothing about what "premium" runs on.
//
// WHY A SEPARATE CONCEPT FROM ModelProviderId. lib/providers/index.ts's
// registry already resolves a provider id to a transport, and each provider
// already resolves to exactly ONE Racer model (racerModelFor in
// lib/prompts/racer.ts, via env.modelRacer/xaiModelRacer/openaiModelRacer).
// That is one axis: WHICH TRANSPORT. Engine tier is a second, independent
// axis: WHICH ECONOMIC CLASS, decided by the player and priced accordingly.
// Today each tier fixes its own provider (PREMIUM_RACER_PROVIDER for
// premium, PUBLIC_RACER_PROVIDER for standard) rather than varying the
// model within a single shared provider, but the tier id is what a game
// persists and re-resolves on every turn — never a raw provider name — so
// either mapping can change centrally without touching the UI or any
// stored game's contract.
// ---------------------------------------------------------------------------

export type RacerEngineTier = "standard" | "premium";

/** The behaviour of every game recorded before this feature, and the
 * player-facing default: preselected, unchanged credit charge. */
export const DEFAULT_RACER_ENGINE_TIER: RacerEngineTier = "standard";

export function isRacerEngineTier(value: unknown): value is RacerEngineTier {
  return value === "standard" || value === "premium";
}

/**
 * The premium ("Emberi szintű AI") tier's fixed transport.
 *
 * V2.8.8.7 CORRECTION — this is "openai" (GPT-6 Astra), the EXACT
 * configuration PUBLIC_RACER_PROVIDER (app/api/game/create/route.ts) already
 * used as the public default since V2.8.7, reused unchanged rather than
 * inventing a new one. An earlier draft of this feature pointed premium at
 * "anthropic" with a newly-introduced ANTHROPIC_MODEL_RACER_PREMIUM
 * ("claude-opus-5") — reverted: the approved product decision reuses
 * already-proven Racer configurations for both tiers, and Claude/Fable's
 * role stays confined to adjudication and Integrity Review (lib/env.ts's
 * modelAdjudication), never the premium Racer.
 *
 * Central and singular on purpose — see the module doc above. Kept separate
 * from PUBLIC_RACER_PROVIDER and from DEFAULT_RACER_PROVIDER
 * (lib/providers/index.ts, a transport-layer fallback for callers that pass
 * no provider at all): neither of those constants is a policy about what the
 * premium tier runs on, and this one must not silently start meaning
 * something else if either changes.
 */
export const PREMIUM_RACER_PROVIDER: ModelProviderId = "openai";
