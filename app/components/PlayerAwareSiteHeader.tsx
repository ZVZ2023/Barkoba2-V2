import { cookies } from "next/headers";
import { PLAYER_COOKIE, verifyPlayerCookie } from "@/lib/playerIdentity";
import SiteHeader from "./SiteHeader";

/**
 * Server boundary for the global Play Credit status.
 *
 * A valid cookie must already be present on the incoming request. Middleware
 * may mint an identity during a first visit, but that response-side cookie is
 * deliberately not treated as established yet. This prevents the global
 * header from issuing a ledger aggregate for every first-time visitor or bot.
 */
export default async function PlayerAwareSiteHeader() {
  const jar = cookies();
  const playerId = await verifyPlayerCookie(jar.get(PLAYER_COOKIE)?.value);

  return <SiteHeader hasEstablishedPlayerIdentity={playerId !== null} />;
}
