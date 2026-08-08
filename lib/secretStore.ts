import { getKV } from "./kv";
import { env } from "./env";
import type { SecretRecord } from "./types";

// ---------------------------------------------------------------------------
// ISOLATION BOUNDARY.
//
// This module is the ONLY place in the codebase permitted to read or write
// SecretRecord data. It exports exactly three functions:
//
//   - createSecret          (called once, at game creation)
//   - getSecretForValidation (called once, by the Validator)
//   - getSecretForAdjudication (called once, by Adjudicator / Integrity Review)
//
// There is deliberately no generic `getSecret(gameId)` export. Anything
// that needs the target must go through one of the two named, purpose-
// specific getters below. The Racer prompt builder (lib/prompts/racer.ts,
// added in M3) must never import from this file — that absence is the
// isolation guarantee, not a comment promising good behavior.
// ---------------------------------------------------------------------------

function secretKey(gameId: string): string {
  return `secret:${gameId}`;
}

export async function createSecret(
  gameId: string,
  target: string,
  privateClarification: string
): Promise<void> {
  const record: SecretRecord = {
    game_id: gameId,
    target,
    private_clarification: privateClarification,
    locked_at: null,
  };
  await getKV().set(secretKey(gameId), record, env.gameTtlSeconds());
}

export async function lockSecret(gameId: string): Promise<void> {
  const kv = getKV();
  const record = await kv.get<SecretRecord>(secretKey(gameId));
  if (!record) {
    throw new Error(`lockSecret: no secret record found for game ${gameId}`);
  }
  if (record.locked_at) return; // already locked, no-op
  record.locked_at = new Date().toISOString();
  await kv.set(secretKey(gameId), record, env.gameTtlSeconds());
}

/** Used only by the pre-game Target Validator call. */
export async function getSecretForValidation(
  gameId: string
): Promise<SecretRecord | null> {
  return getKV().get<SecretRecord>(secretKey(gameId));
}

/** Used only by the post-guess Adjudicator and Integrity Review calls. */
export async function getSecretForAdjudication(
  gameId: string
): Promise<SecretRecord | null> {
  return getKV().get<SecretRecord>(secretKey(gameId));
}
