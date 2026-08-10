import { getKV } from "./kv";
import { recoveryKey } from "./recoveryCode";

// ---------------------------------------------------------------------------
// Durable Player identity — V2.1.3.0.
//
// The ONLY module permitted to touch durable identity storage, mirroring the
// secretStore pattern. Everything else goes through these functions, so moving
// identity to a real database later is a one-file change and cannot leak into
// route handlers in the meantime.
//
// This is deliberately NOT the V2.2 game-history store. Identity is small,
// low-volume and looked up by key; history wants ranges, ordering and growth.
// Different shapes, different stores, and this module is the seam between them.
//
// Two key families, both written with NO TTL — the first thing in Barkoba that
// must never expire:
//
//   player:<playerId>    { display_name, created_at, claimed_at, recovery_key }
//   recovery:<sha256>    { player_id }
//
// The player record carries recovery_key so deletion can remove both records
// directly. Redis cannot search values cheaply, and a scan would get slower
// with every player.
// ---------------------------------------------------------------------------

export interface DurablePlayer {
  player_id: string;
  display_name: string | null;
  created_at: string;
  claimed_at: string;
  /** Pointer to this player's recovery record, so deletion needs no search. */
  recovery_key: string;
}

interface RecoveryRecord {
  player_id: string;
}

function playerKey(playerId: string): string {
  return `player:${playerId}`;
}

function recoveryRecordKey(hash: string): string {
  return `recovery:${hash}`;
}

/** Has this Player been protected? Null for the anonymous majority. */
export async function getDurablePlayer(playerId: string): Promise<DurablePlayer | null> {
  return getKV().get<DurablePlayer>(playerKey(playerId));
}

/**
 * Protect an EXISTING player. Never mints a new identity — the id passed in is
 * the id that keeps playing, which is the whole point of claiming rather than
 * registering.
 *
 * Returns null if already claimed. V2.1 refuses re-claiming rather than
 * rotating: silently invalidating a code the player may have written down is
 * the fastest way to destroy trust in a recovery mechanism.
 */
export async function claimPlayer(
  playerId: string,
  displayName: string | null,
  rawCode: string
): Promise<DurablePlayer | null> {
  if (await getDurablePlayer(playerId)) return null;

  const hash = await recoveryKey(rawCode);
  const now = new Date().toISOString();
  const record: DurablePlayer = {
    player_id: playerId,
    display_name: displayName,
    created_at: now,
    claimed_at: now,
    recovery_key: hash,
  };

  // Recovery record first: if the second write fails, the code resolves to a
  // player that does not exist yet and recovery simply reports "not found".
  // The reverse order would leave a claimed player no code could ever reach.
  await getKV().set<RecoveryRecord>(recoveryRecordKey(hash), { player_id: playerId });
  await getKV().set<DurablePlayer>(playerKey(playerId), record);
  return record;
}

/** Resolve a code to its Player. Null covers wrong, deleted and never-existed alike. */
export async function recoverPlayer(rawCode: string): Promise<DurablePlayer | null> {
  const hit = await getKV().get<RecoveryRecord>(recoveryRecordKey(await recoveryKey(rawCode)));
  if (!hit?.player_id) return null;
  return getDurablePlayer(hit.player_id);
}

/** Keep the durable name in step when a claimed player renames themselves. */
export async function setDurableDisplayName(
  playerId: string,
  displayName: string | null
): Promise<void> {
  const record = await getDurablePlayer(playerId);
  if (!record) return;
  await getKV().set<DurablePlayer>(playerKey(playerId), { ...record, display_name: displayName });
}

/**
 * Delete a claimed identity. Recovery record first, deliberately: a crash
 * between the two leaves an unreachable player record, which is inert. The
 * other order leaves a live code pointing at a deleted player.
 */
export async function deleteDurablePlayer(playerId: string): Promise<boolean> {
  const record = await getDurablePlayer(playerId);
  if (!record) return false;
  await getKV().del(recoveryRecordKey(record.recovery_key));
  await getKV().del(playerKey(playerId));
  return true;
}
