import { cookies, headers } from "next/headers";
import { shouldAskForName } from "@/lib/nameScreen";
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


export default async function Page() {
  // V2.8.4.3 — see app/compose/page.tsx's identical comment.
  const accountHeaderState = await resolveAccountHeaderState(headers());
  return (
    <RacerSetup
      versionLabel={formatVersionLabel(getAppVersion())}
      askForName={await shouldAskForName(headers(), cookies())}
      accountAuthenticated={accountHeaderState.authenticated}
      accountPhotoUrl={accountHeaderState.photoUrl}
    />
  );
}
