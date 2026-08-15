import { getKV } from "./kv";

// ---------------------------------------------------------------------------
// V2.4 — opaque purchase references for the commercial adapter boundary.
//
// The adapter must be able to name a Barkóba player without ever holding a
// player_id. A raw player_id would travel through URLs, referrers and a third
// party's logs, and knowing one is enough to direct credits at it.
//
// So the adapter gets an opaque, short-lived, single-use reference instead.
// This is deliberately the SAME SHAPE as lib/joinCode.ts — one Redis key
// mapping a random Crockford-Base32 token to an id, minted by Barkóba, consumed
// on use. No new token mechanism was invented for this.
//
//   purchase_ref:<REF>  ->  { player_id }                    TTL 30 minutes
//   purchase_ref:<REF>  ->  { player_id, consumed_by }       TTL 24 hours
//
// 16 characters is 80 bits: far beyond guessing for a key that lives half an
// hour and is spent on first use. Longer than a join code because this one is
// not meant to be read aloud — it is passed machine to machine.
//
// WHAT THIS IS NOT: a credential. It authorises nothing on its own. The grant
// endpoint additionally requires the server-to-server secret, so a leaked
// reference cannot move credits by itself.
//
// ---------------------------------------------------------------------------
// CONSUMED REFERENCES, AND WHY THEY ARE KEPT
//
// The first version of this file DELETED the key on use. That made a retry
// indistinguishable from a forgery: an adapter that lost the response to a
// successful grant and retried the identical call got "unknown reference" back,
// and could reasonably conclude the purchase had failed — while the player was
// already holding the credits. Worse, the delete was best-effort, so the same
// retry returned 404 or 200 depending on whether an unrelated Redis call
// happened to succeed. The contract was not just unhelpful, it was undecidable.
//
// A used reference is therefore MARKED rather than removed, recording which
// order spent it. That single field is what lets the grant endpoint separate
// three cases that previously collapsed into one:
//
//   fresh                     -> may authorise a grant
//   consumed by THIS order    -> a retry; harmless, reports already-processed
//   consumed by ANOTHER order -> refused, exactly like an unknown reference
//
// This is retry-state, not purchase history. The durable record of what was
// bought lives in the ledger and always did; this key exists only so that a
// second delivery attempt of the same callback can be answered truthfully.
// ---------------------------------------------------------------------------

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REF_LENGTH = 16;

/** Thirty minutes: long enough to complete a checkout, short enough to expire. */
export const PURCHASE_REF_TTL_SECONDS = 30 * 60;

/**
 * How long a SPENT reference is remembered, measured from the moment it was
 * spent rather than from when it was minted.
 *
 * It has to be measured from consumption, and it has to be longer than the
 * checkout window, or the defect this exists to fix simply moves later: a grant
 * landing at minute 29 of a 30-minute reference would leave roughly sixty
 * seconds of deterministic retry before the record aged out and the retry
 * started reporting "unknown reference" again. Resetting the clock on use gives
 * every grant the same full retry window regardless of when in the checkout it
 * landed.
 *
 * Twenty-four hours because that is the horizon over which a payment provider
 * actually redelivers a webhook — the early backoff attempts that matter all
 * fall inside a day, and anything still failing after that needs a human, not a
 * longer TTL. It also matches the game TTL, so it is not a new retention
 * philosophy, just an existing one applied to a much smaller record.
 *
 * The stored value is two short strings and self-expires. Nothing here is
 * needed to prove a purchase; that is the ledger's job, permanently.
 */
export const PURCHASE_REF_CONSUMED_TTL_SECONDS = 24 * 60 * 60;

interface PurchaseRefRecord {
  player_id: string;
  /** The order that spent this reference. Absent while it is still fresh. */
  consumed_by?: string;
}

/** A reference that exists. `consumedBy` is null while it is still unspent. */
export interface PurchaseRefState {
  playerId: string;
  consumedBy: string | null;
}

function refKey(ref: string): string {
  return `purchase_ref:${ref}`;
}

export function normalizePurchaseRef(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function generatePurchaseRef(): string {
  const bytes = new Uint8Array(REF_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export async function createPurchaseRef(playerId: string): Promise<string> {
  const ref = generatePurchaseRef();
  await getKV().set<PurchaseRefRecord>(
    refKey(ref),
    { player_id: playerId },
    PURCHASE_REF_TTL_SECONDS
  );
  return ref;
}

/**
 * Null covers wrong, expired and long-forgotten references alike.
 *
 * A reference that HAS been spent still resolves, with `consumedBy` set. The
 * caller decides what that means; this layer only reports it. Deciding here
 * would force the two refusal cases to be answered differently, and telling an
 * unauthenticated caller apart "unknown" from "spent" is exactly the leak the
 * grant endpoint is careful not to produce.
 */
export async function resolvePurchaseRef(rawRef: string): Promise<PurchaseRefState | null> {
  const ref = normalizePurchaseRef(rawRef);
  if (ref.length !== REF_LENGTH) return null;
  const hit = await getKV().get<PurchaseRefRecord>(refKey(ref));
  if (!hit?.player_id) return null;
  return { playerId: hit.player_id, consumedBy: hit.consumed_by ?? null };
}

/**
 * Mark a reference spent by a specific order, and restart its clock.
 *
 * Called after a successful grant. Re-reads rather than trusting a player id
 * passed back in, so a stale caller cannot rewrite whose reference this is.
 *
 * NOT the idempotency mechanism — that is `external_order_id` mapped onto the
 * ledger's grant_key, which holds even if this write fails. This exists so a
 * retry can be RECOGNISED, and so a reference cannot be turned on a different
 * order once it has been spent.
 */
export async function consumePurchaseRef(
  rawRef: string,
  externalOrderId: string
): Promise<void> {
  const ref = normalizePurchaseRef(rawRef);
  if (ref.length !== REF_LENGTH) return;
  const hit = await getKV().get<PurchaseRefRecord>(refKey(ref));
  if (!hit?.player_id) return;
  await getKV().set<PurchaseRefRecord>(
    refKey(ref),
    { player_id: hit.player_id, consumed_by: externalOrderId },
    PURCHASE_REF_CONSUMED_TTL_SECONDS
  );
}
