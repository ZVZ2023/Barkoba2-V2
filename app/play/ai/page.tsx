import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import RacerSetup from "../../RacerSetup";

// 0.6.x default: AI Composer, human Racer.
//
// The 0.3.x human-Composer game is unchanged and lives at /compose. Both run on
// the same engine — same store, same secret module, same adjudication and
// integrity review — and differ only in which participant the server has to
// synthesise on a turn.

export const dynamic = "force-dynamic";

export default function Page() {
  return <RacerSetup versionLabel={formatVersionLabel(getAppVersion())} />;
}
