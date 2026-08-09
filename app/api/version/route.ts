import { NextResponse } from "next/server";
import { getAppVersion } from "@/lib/appVersion";

// Deployment identity as JSON. Reads lib/appVersion.ts — the same source the
// on-screen badge uses, so the two cannot disagree.
//
// `commit` is ground truth: injected by Vercel from the actual pushed commit,
// so it cannot go stale. `version` is the human tag. If they ever imply
// different things, believe the commit.

export const dynamic = "force-dynamic";

export async function GET() {
  const v = getAppVersion();
  return NextResponse.json({
    version: v.version,
    package_version: v.packageVersion,
    commit: v.commit,
    commit_short: v.commitShort,
    branch: v.branch,
    environment: v.environment,
    deployment_id: v.deploymentId,
    served_at: new Date().toISOString(),
  });
}
