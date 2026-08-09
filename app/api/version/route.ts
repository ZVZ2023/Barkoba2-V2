import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import pkg from "../../../package.json";

// ---------------------------------------------------------------------------
// Deployment identity, reported dynamically. Nothing here is hardcoded, so it
// cannot drift from reality the way a literal string would.
//
// Three sources, in descending order of trustworthiness:
//
//   commit  — VERCEL_GIT_COMMIT_SHA, injected by Vercel at build time from the
//             actual pushed commit. This is GROUND TRUTH: it cannot be stale,
//             because it is not something anyone can forget to update.
//   version — the VERSION file, read from the deployed bundle. The four-part
//             human tag. Accurate only insofar as whoever cut the release
//             edited it.
//   package_version — package.json, three-part because npm requires semver.
//
// If `version` and `commit` ever disagree with expectations, believe `commit`.
//
// Exists so deployment can be verified from outside with a plain HTTP GET,
// without Vercel API access or dashboard checking.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/**
 * The VERSION file is not importable (it is not JSON), so it is read from the
 * bundle at runtime. `outputFileTracingIncludes` in next.config.mjs is what
 * guarantees it is actually shipped — without that entry this read succeeds
 * locally and returns null in production, which is the worst failure shape:
 * silently wrong rather than broken.
 */
function readVersionFile(): string | null {
  try {
    const raw = readFileSync(path.join(process.cwd(), "VERSION"), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? null;

  return NextResponse.json({
    version: readVersionFile(),
    package_version: pkg.version,
    commit,
    commit_short: commit ? commit.slice(0, 7) : null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? null,
    deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    served_at: new Date().toISOString(),
  });
}
