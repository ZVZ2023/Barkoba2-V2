import type { Metadata } from "next";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";
import HumanSetup from "./HumanSetup";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Barkóba — Játék egy másik emberrel" };

/** V2.3 entry point. Server component only so it can read the deployed version. */
export default function HumanPlayPage() {
  return (
    <div className="flex min-h-screen w-full flex-col bg-[#f6ece0] text-neutral-900">
      <HumanSetup versionLabel={formatVersionLabel(getAppVersion())} />
    </div>
  );
}
