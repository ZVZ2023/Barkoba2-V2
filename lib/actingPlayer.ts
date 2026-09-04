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
 * V2.8.6 R1 Commit 3 — internal seam shared by resolveActingPlayer (below,
 * UNCHANGED behavior for its many existing callers) and
 * resolveActingPlayerIdentity (new). The actual resolution logic lives here
 * exactly once; the two public functions differ only in how they report a
 * failure inside this try block.
 */
type InnerResolution =
  | { ok: true; context: ActingPlayerContext }
  | { ok: false };

async function resolveActingPlayerInner(headers: Headers): Promise<InnerResolution> {
  try {
    const presentedToken = accountSessionTokenFromHeaders(headers);
    const accountPlayerId = await resolveAccountSession(presentedToken);
    if (accountPlayerId) return { ok: true, context: { kind: "account", playerId: accountPlayerId } };

    const guestId = playerIdFromHeaders(headers);
    if (!guestId) return { ok: true, context: { kind: "none", playerId: null } };

    if (await getPlayerAccount(guestId)) {
      return { ok: true, context: { kind: "registered", playerId: guestId } };
    }
    const legacy = await getDurablePlayer(guestId);
    if (legacy) {
      await migrateLegacyPlayer(legacy);
      return { ok: true, context: { kind: "registered", playerId: guestId } };
    }
    return { ok: true, context: { kind: "guest", playerId: guestId } };
  } catch (err) {
    // Authentication storage is authority. An outage cannot safely turn a
    // registered account back into whichever old device cookie was presented.
    // eslint-disable-next-line no-console
    console.error("[barkoba] account-aware identity resolution failed:", err);
    return { ok: false };
  }
}

/**
 * Resolve the authority for this request.
 *
 * A valid server-side account session always wins. A signed bk_player remains
 * sufficient only while its id is genuinely an unregistered guest. Once that
 * id exists in accounts.players, the old device cookie is deliberately denied.
 * Legacy protected identities are migrated on sight, but the old cookie still
 * receives no authority; the player must present the recovery code to log in.
 *
 * UNCHANGED by V2.8.6 R1 Commit 3: a backend failure still collapses to
 * `{kind:"none"}` here, exactly as before that commit, for every one of this
 * function's existing callers (account routes, /resolve, /contest, /hh/turn,
 * /join, player routes, PlayerAwareSiteHeader, and more). Only
 * resolveActingPlayerIdentity (below) distinguishes that failure from an
 * ordinary anonymous visitor — a new, additive export, not a change to this
 * one's contract.
 */
export async function resolveActingPlayer(headers: Headers): Promise<ActingPlayerContext> {
  const result = await resolveActingPlayerInner(headers);
  return result.ok ? result.context : { kind: "none", playerId: null };
}

/** Player id usable for balance, games and seats. Legacy cookies are excluded. */
export async function resolveActingPlayerId(headers: Headers): Promise<string | null> {
  const context = await resolveActingPlayer(headers);
  return context.kind === "account" || context.kind === "guest" ? context.playerId : null;
}

/**
 * V2.8.6 R1 Commit 3 — the typed identity-failure taxonomy a mutating
 * gameplay/read route needs, that resolveActingPlayerId's plain `string |
 * null` cannot express: "no usable identity was presented" (401
 * unauthenticated) and "the identity store itself could not be reached"
 * (503 identity_unavailable) are different failures needing different
 * responses, and conflating them — as ActingPlayerContext's `{kind:"none"}`
 * still deliberately does, for every one of resolveActingPlayer's many
 * OTHER existing callers — makes a transient backend outage indistinguishable
 * from an ordinary anonymous visitor at exactly the routes now authorizing
 * on identity.
 *
 * ADDITIVE ONLY. resolveActingPlayer/resolveActingPlayerId/
 * resolveAccountHeaderState are untouched by this — this is a new export
 * used only by the routes that need this distinction (see /turn, /correct,
 * /ask, /clue, /view and app/game/[id]/page.tsx), not a replacement for the
 * existing, much more widely depended-on helpers.
 */
export type IdentityResolution =
  | { kind: "identified"; playerId: string }
  | { kind: "absent" }
  | { kind: "backend_unavailable" };

export async function resolveActingPlayerIdentity(headers: Headers): Promise<IdentityResolution> {
  const result = await resolveActingPlayerInner(headers);
  if (!result.ok) return { kind: "backend_unavailable" };

  const { context } = result;
  // Mirrors resolveActingPlayerId's own policy exactly: "registered" (a
  // legacy device cookie whose id has since been claimed by an account) and
  // "none" both carry no authority here, for the identical reason that
  // function already excludes them.
  if (context.kind === "account" || context.kind === "guest") {
    return { kind: "identified", playerId: context.playerId };
  }
  return { kind: "absent" };
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
