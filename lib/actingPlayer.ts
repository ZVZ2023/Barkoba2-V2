import {
  accountSessionTokenFromHeaders,
  resolveAccountSession,
} from "./accountSession";
import { getPlayerAccount, migrateLegacyPlayer } from "./playerAccounts";
import { playerIdFromHeaders } from "./playerIdentity";
import { getDurablePlayer } from "./playerStore";

export type ActingPlayerContext =
  | { kind: "account"; playerId: string }
  | { kind: "guest"; playerId: string }
  | { kind: "registered"; playerId: string }
  | { kind: "none"; playerId: null };

/**
 * Resolve the authority for this request.
 *
 * A valid server-side account session always wins. A signed bk_player remains
 * sufficient only while its id is genuinely an unregistered guest. Once that
 * id exists in accounts.players, the old device cookie is deliberately denied.
 * Legacy protected identities are migrated on sight, but the old cookie still
 * receives no authority; the player must present the recovery code to log in.
 */
export async function resolveActingPlayer(headers: Headers): Promise<ActingPlayerContext> {
  try {
    const presentedToken = accountSessionTokenFromHeaders(headers);
    const accountPlayerId = await resolveAccountSession(presentedToken);
    if (accountPlayerId) return { kind: "account", playerId: accountPlayerId };

    const guestId = playerIdFromHeaders(headers);
    if (!guestId) return { kind: "none", playerId: null };

    if (await getPlayerAccount(guestId)) return { kind: "registered", playerId: guestId };
    const legacy = await getDurablePlayer(guestId);
    if (legacy) {
      await migrateLegacyPlayer(legacy);
      return { kind: "registered", playerId: guestId };
    }
    return { kind: "guest", playerId: guestId };
  } catch (err) {
    // Authentication storage is authority. An outage cannot safely turn a
    // registered account back into whichever old device cookie was presented.
    // eslint-disable-next-line no-console
    console.error("[barkoba] account-aware identity resolution failed:", err);
    return { kind: "none", playerId: null };
  }
}

/** Player id usable for balance, games and seats. Legacy cookies are excluded. */
export async function resolveActingPlayerId(headers: Headers): Promise<string | null> {
  const context = await resolveActingPlayer(headers);
  return context.kind === "account" || context.kind === "guest" ? context.playerId : null;
}

export interface AccountHeaderState {
  authenticated: boolean;
  /** The requester's own saved profile photo, or null. Never another player's. */
  photoUrl: string | null;
}

/**
 * V2.8.4.3 — the account-control header state for the CURRENT request's own
 * player, shared by every header surface (SiteHeader, GameShell, and
 * GameClient's own header) so photo resolution has exactly one
 * implementation rather than three.
 *
 * Identity comes from resolveActingPlayer, exactly as everywhere else in this
 * file — session/cookies on the incoming request, never a caller-supplied id
 * — so this can only ever describe the requester's own account. "guest" and
 * "none" have no account row and therefore no photo; a lookup failure fails
 * closed to no photo rather than blocking the header from rendering at all.
 */
export async function resolveAccountHeaderState(headers: Headers): Promise<AccountHeaderState> {
  const context = await resolveActingPlayer(headers);
  const authenticated = context.kind === "account";

  if (context.kind !== "account" && context.kind !== "registered") {
    return { authenticated, photoUrl: null };
  }

  try {
    const account = await getPlayerAccount(context.playerId);
    return { authenticated, photoUrl: account?.photo_url ?? null };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] resolveAccountHeaderState: account lookup failed:", err);
    return { authenticated, photoUrl: null };
  }
}
