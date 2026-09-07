import { resolveActingPlayer } from "./actingPlayer";
import { getPlayerAccount } from "./playerAccounts";
import {
  PLAYER_COOKIE,
  PLAYER_NAME_COOKIE,
  readPlayerName,
  verifyPlayerCookie,
} from "./playerIdentity";

/**
 * Structural subset of next/headers' ReadonlyRequestCookies — narrow enough
 * that a plain test fake satisfies it without pulling in Next's request
 * machinery.
 */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/**
 * Should this player be shown the "Hogy szólítsunk?" naming screen?
 *
 * Server-side because the cookies are httpOnly — a client component cannot
 * see them, which is the point. Asked exactly once per anonymous Player: the
 * skip writes the cookie too, so a skipped player is never asked again.
 *
 * Previously duplicated verbatim in app/compose/page.tsx and
 * app/play/ai/page.tsx; extracted here once both needed the same correction
 * below, so the two entry points cannot drift again.
 *
 * V2.9.1 CORRECTION — production evidence showed a signed-in registered
 * player, with the authenticated Profile control and avatar visible, still
 * receiving this screen. The prior fix only skipped it when the account
 * lookup ALSO returned a nonblank display_name, and even then it resolved
 * identity from the raw guest device cookie (verifyPlayerCookie), never from
 * the actual account session — so it could not distinguish "authenticated"
 * from "anonymous" at all, only "has a display name" from "does not".
 *
 * The fix checks resolveActingPlayer's authoritative context FIRST: any live
 * account session (kind === "account") always skips the screen, regardless
 * of whether accounts.players has a usable display_name yet — there is
 * nothing to reuse a name FROM here (this function only decides whether to
 * show the prompt, nothing else consumes a resolved name at this call site),
 * so "reuse the account name" and "fall back to nameless" both cash out to
 * the same thing: never block. A spoofed bk_player_name cookie cannot forge
 * this, because resolveActingPlayer never reads that cookie — only a genuine
 * server-side session token can produce kind === "account".
 *
 * Anonymous visitors (kind "guest"/"registered"/"none") are unaffected and
 * keep the exact pre-existing behavior: the per-device name cookie remains
 * the sole mechanism for a true guest, who has no accounts.players row.
 */
export async function shouldAskForName(
  requestHeaders: Headers,
  jar: CookieReader
): Promise<boolean> {
  const context = await resolveActingPlayer(requestHeaders);
  if (context.kind === "account") return false;

  const playerId = await verifyPlayerCookie(jar.get(PLAYER_COOKIE)?.value);
  if (!playerId) return false; // identity unavailable - nothing to attach a name to
  const account = await getPlayerAccount(playerId);
  if (account?.display_name && account.display_name.trim().length > 0) return false;
  const state = await readPlayerName(playerId, jar.get(PLAYER_NAME_COOKIE)?.value);
  return !state.asked;
}
