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
