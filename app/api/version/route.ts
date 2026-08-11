import { NextResponse } from "next/server";
import { getAppVersion } from "@/lib/appVersion";
import { corpusConfigStatus } from "@/lib/corpus/db";

// Deployment identity as JSON. Reads lib/appVersion.ts — the same source the
// on-screen badge uses, so the two cannot disagree.
//
// `commit` is ground truth: injected by Vercel from the actual pushed commit,
// so it cannot go stale. `version` is the human tag. If they ever imply
// different things, believe the commit.

export const dynamic = "force-dynamic";

export async function GET() {
  const v = getAppVersion();
  const corpus = corpusConfigStatus();

  return NextResponse.json({
    version: v.version,
    package_version: v.packageVersion,
    commit: v.commit,
    commit_short: v.commitShort,
    branch: v.branch,
    environment: v.environment,
    deployment_id: v.deploymentId,
    // V2.2.0.1 — whether THIS runtime will record games, and if not, why.
    //
    // Booleans and a reason code only. The connection string and the raw flag
    // value never leave the process, so this is safe on a public endpoint.
    //
    // Exists because 2.2.0.0 shipped with no way to answer "is the corpus on?"
    // without inspecting Redis and hunting through function logs.
    corpus: {
      configured: corpus.configured,
      enabled: corpus.enabled,
      database_url_present: corpus.databaseUrlPresent,
      reason: corpus.reason,
    },
    served_at: new Date().toISOString(),
  });
}
