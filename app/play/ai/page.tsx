import { cookies, headers } from "next/headers";
import {
  PLAYER_COOKIE,
  PLAYER_NAME_COOKIE,
  readPlayerName,
  verifyPlayerCookie,
} from "@/lib/playerIdentity";
import { resolveAccountHeaderState } from "@/lib/actingPlayer";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import RacerSetup from "../../RacerSetup";

// 0.6.x default: AI Composer, human Racer.
//
// The 0.3.x human-Composer game is unchanged and lives at /compose. Both run on
// the same engine — same store, same secret module, same adjudication and
// integrity review — and differ only in which participant the server has to
// synthesise on a turn.

export const dynamic = "force-dynamic";


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
  // V2.8.4.3 — see app/compose/page.tsx's identical comment.
  const accountHeaderState = await resolveAccountHeaderState(headers());
  return (
    <RacerSetup
      versionLabel={formatVersionLabel(getAppVersion())}
      askForName={await shouldAskForName()}
      accountAuthenticated={accountHeaderState.authenticated}
      accountPhotoUrl={accountHeaderState.photoUrl}
    />
  );
}
