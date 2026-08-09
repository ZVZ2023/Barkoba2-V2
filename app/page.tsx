import type { Metadata } from "next";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import Stage from "./components/Stage";
import FrontDoor from "./components/FrontDoor";

// The Barkóba front door. Artwork stage + real HTML interface.
//
// Both game modes live behind /play and are unchanged: /compose is the 0.3.x
// human-Composer game, /play/ai is the 0.6.x AI-Composer game. Milestone 3 adds
// a front door; it does not touch either engine.

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const v = getAppVersion();
  return {
    title: "Barkóba",
    other: {
      "x-app-version": v.version ?? "unknown",
      "x-app-commit": v.commitShort ?? "unknown",
    },
  };
}

export default function Page() {
  const label = formatVersionLabel(getAppVersion());
  return (
    <>
      <Stage />
      <FrontDoor />
      <span className="pointer-events-none fixed bottom-1 right-2 z-40 text-[10px] text-neutral-500/70">
        {label}
      </span>
    </>
  );
}
