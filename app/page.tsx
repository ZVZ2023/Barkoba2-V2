import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import ComposerEntry from "./ComposerEntry";

// Server component. Its only job is to read the deployment version — which a
// client component cannot do — and hand it to the form.
//
// The badge is on this page as well as the game screen deliberately: this is
// the only screen reachable without first creating a game, which makes it the
// one place a deployed version can be confirmed from outside with a plain
// page fetch, no API access required.

export const dynamic = "force-dynamic";

export default function Page() {
  return <ComposerEntry versionLabel={formatVersionLabel(getAppVersion())} />;
}
