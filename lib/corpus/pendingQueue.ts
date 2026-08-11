import { getKV } from "../kv";

// ---------------------------------------------------------------------------
// V2.2 — the deferred-write queue behind opportunistic reconciliation.
//
// THE PROBLEM IT SOLVES: if Neon is briefly unavailable, the corpus write for a
// turn fails. Redis still holds the authoritative GameRecord for
// GAME_TTL_SECONDS, so the evidence is not lost yet — but nothing would ever go
// back for it. That would turn a transient outage into permanent evidence loss,
// which the milestone explicitly rules out.
//
// WHY A SINGLE JSON ARRAY AND NOT A REDIS SET: lib/kv.ts exposes get/set/del
// and nothing else, on purpose ("no pattern delete, no scan, no bulk"). Widening
// the KV interface to add set operations for a reconciliation detail would be a
// worse trade than accepting a bounded array. This is the minimum coherent
// mechanism, and it is deliberately not a job queue.
//
// KNOWN LIMITATIONS, stated rather than discovered later:
//
//  1. Read-modify-write on one key is not atomic. Two concurrent failures can
//     race and lose one entry. At the present scale (single-family testing)
//     concurrent corpus failures are close to hypothetical, and the cost of the
//     race is one game reverting to the behaviour Barkóba had before V2.2.
//  2. The queue is bounded. A sustained outage past MAX_PENDING drops the
//     oldest ids — an unbounded queue would be a memory leak with no owner.
//  3. Entries are only replayable while Redis still holds the game. After the
//     24h TTL the id is dropped on the next pass rather than retried forever.
//
// All three are acceptable for 2.2.0.0 and all three get better, not worse, if
// this is later replaced by scheduled reconciliation.
// ---------------------------------------------------------------------------

const PENDING_KEY = "corpus:pending";

/** Beyond this the outage is not transient and a queue is the wrong instrument. */
export const MAX_PENDING = 200;

export async function readPending(): Promise<string[]> {
  const raw = await getKV().get<string[]>(PENDING_KEY);
  return Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [];
}

/** Newest last. Idempotent: an id already queued is not queued twice. */
export async function enqueuePending(gameId: string): Promise<void> {
  const current = await readPending();
  if (current.includes(gameId)) return;
  const next = [...current, gameId].slice(-MAX_PENDING);
  await getKV().set(PENDING_KEY, next);
}

export async function removePending(gameId: string): Promise<void> {
  const current = await readPending();
  if (!current.includes(gameId)) return;
  const next = current.filter((id) => id !== gameId);
  if (next.length === 0) await getKV().del(PENDING_KEY);
  else await getKV().set(PENDING_KEY, next);
}

/** Oldest first — a transient outage should drain in the order it happened. */
export async function claimBatch(limit: number): Promise<string[]> {
  return (await readPending()).slice(0, Math.max(0, limit));
}
