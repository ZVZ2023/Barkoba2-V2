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
    // Whether THIS runtime will record games — and if not, why.
    //
    // 2.2.0.0: no way to answer "is the corpus on?" without inspecting Redis
    //          and hunting function logs.
    // 2.2.0.1: answered that, but only checked PRESENCE of DATABASE_URL, so a
    //          string the driver rejects still reported "ready".
    // 2.2.0.2: reports validity, the specific shape fault, and the host and
    //          database the runtime would actually write to — so a deployment
    //          pointed at the wrong Neon branch is visible before a game is
    //          played rather than after the rows fail to appear.
    //
    // SAFE TO SERVE PUBLICLY: host and database name only. No username, no
    // password, no query parameters, no part of the raw string. The problem
    // field names a SHAPE ("wrapped_in_quotes"), never content.
    corpus: {
      configured: corpus.configured,
      enabled: corpus.enabled,
      database_url_present: corpus.databaseUrlPresent,
      database_url_valid: corpus.databaseUrlValid,
      database_url_problem: corpus.databaseUrlProblem,
      host: corpus.host,
      database: corpus.database,
      reason: corpus.reason,
    },
    served_at: new Date().toISOString(),
  });
}
