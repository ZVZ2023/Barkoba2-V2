import { cookies } from "next/headers";
import {
  PLAYER_COOKIE,
  PLAYER_NAME_COOKIE,
  readPlayerName,
  verifyPlayerCookie,
} from "@/lib/playerIdentity";
import type { Metadata } from "next";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import ComposerEntry from "../ComposerEntry";

// Server component. Its only job is to read the deployment version — which a
// client component cannot do — and hand it to the form.
//
// The badge is on this page as well as the game screen deliberately: this is
// the only screen reachable without first creating a game, which makes it the
// one place a deployed version can be confirmed from outside with a plain
// page fetch, no API access required.

export const dynamic = "force-dynamic";

/**
 * 0.3.x mode: the human sets the secret and the AI guesses. Kept intact and
 * reachable at /compose — role inversion added a mode, it did not replace one.
 *
 * The version also goes in a meta tag, not only in the visible badge.
 *
 * The badge is for the player. This is for machine verification: readability
 * extractors routinely discard a small inline span next to a heading, so the
 * badge alone could not be read from outside — which was the entire point of
 * putting it on the landing page. Meta tags survive extraction, so this is the
 * channel that actually confirms which build is live.
 */
export function generateMetadata(): Metadata {
  const v = getAppVersion();
  return {
    other: {
      "x-app-version": v.version ?? "unknown",
      "x-app-commit": v.commitShort ?? "unknown",
    },
  };
}


/**
 * Should this player be asked for a display name?
 *
 * Server-side because the cookies are httpOnly - a client component cannot see
 * them, which is the point. Asked exactly once per anonymous Player: the skip
 * writes the cookie too, so a skipped player is never asked again.
 */
async function shouldAskForName(): Promise<boolean> {
  const jar = cookies();
  const playerId = await verifyPlayerCookie(jar.get(PLAYER_COOKIE)?.value);
  if (!playerId) return false; // identity unavailable - nothing to attach a name to
  const state = await readPlayerName(playerId, jar.get(PLAYER_NAME_COOKIE)?.value);
  return !state.asked;
}

export default async function Page() {
  return (
    <ComposerEntry
      versionLabel={formatVersionLabel(getAppVersion())}
      askForName={await shouldAskForName()}
    />
  );
}
