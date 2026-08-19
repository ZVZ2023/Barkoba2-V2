import { headers } from "next/headers";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import SiteHeader from "./SiteHeader";

/**
 * Server boundary for the global Play Credit status.
 *
 * A verified guest or authenticated account must already be present on the
 * incoming request. Middleware may mint a guest during a first visit, but that
 * response-side cookie is deliberately not treated as established yet. A
 * registered player's old guest cookie is also excluded unless accompanied by
 * a valid server-side account session.
 */
export default async function PlayerAwareSiteHeader() {
  const context = await resolveActingPlayer(headers());

  return (
    <SiteHeader
      hasEstablishedPlayerIdentity={context.kind === "account" || context.kind === "guest"}
      accountAuthenticated={context.kind === "account"}
    />
  );
}
