import { env } from "./env";

// ---------------------------------------------------------------------------
// V2.7 — admin/operator authorization. The smallest safe mechanism: an
// env-var-configured allowlist of player_ids, checked against a caller who
// already holds a real account session.
//
// NOT accounts.unlimited_play. That grant is entitlement exemption ("may
// play free forever") and nothing else — see lib/entitlements.ts's own V2.6
// header. It is a coincidence, not a design, that the same two people have
// held both privileges so far. Conflating them would mean a future
// unlimited-play grant silently also grants operational-data access, and
// revoking one would require touching a table whose actual job is
// something else entirely.
//
// NOT a new role system. No accounts.* column, no table, no role enum —
// see env.adminPlayerIds()'s own doc comment for why that trade is
// deliberate at this scale.
// ---------------------------------------------------------------------------

/**
 * Is this player_id on the admin allowlist?
 *
 * Callers must ALSO have confirmed real account authority (`context.kind
 * === "account"`) before calling this — an allowlisted id reached only via
 * a signed guest cookie, never through login, is not what this check is
 * for. This function checks the list membership only; it does not itself
 * resolve or trust identity.
 */
export function isAdminPlayer(playerId: string | null): boolean {
  if (!playerId) return false;
  return env.adminPlayerIds().has(playerId);
}
