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

    // V2.7.0.15 TEMPORARY DIAGNOSTIC — production finding: a browser that had
    // an authenticated account session (Profil visible, +5 credits spent
    // down to 1) later showed "Regisztráció / Belépés" instead, while still
    // displaying a balance — a strong signal that the account session was
    // presented but no longer resolved, and the request fell through to a
    // DIFFERENT guest identity. Logged ONLY in that exact shape (a
    // well-formed token that did not resolve) — never the token itself,
    // never a player_id, never fires for the ordinary "no session cookie at
    // all" case every anonymous visitor is in.
    if (presentedToken) {
      // Cookie header byte length is included as a cheap, non-secret signal
      // for a second live hypothesis: a browser that has accumulated many
      // cookies across a long testing session hitting a header-size limit
      // somewhere in the request path, silently dropping or truncating one.
      const cookieHeaderLength = (headers.get("cookie") ?? "").length;
      // eslint-disable-next-line no-console
      console.error(
        `[barkoba] account session token presented but did not resolve (revoked, expired, or account disabled) — cookie_header_bytes=${cookieHeaderLength}`
      );
    }

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
