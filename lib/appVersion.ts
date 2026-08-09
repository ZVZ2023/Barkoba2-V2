import { readFileSync } from "node:fs";
import path from "node:path";
import pkg from "../package.json";

// ---------------------------------------------------------------------------
// THE canonical deployment identity. Server-only.
//
// Both /api/version and the visible UI badge read from here, so they cannot
// disagree — not because someone remembers to keep them in step, but because
// there is only one of them. Two readers of one source is the whole point;
// a second copy of this logic anywhere else reintroduces the drift it exists
// to prevent.
//
// Never hardcode a version string. `commit` comes from Vercel and is ground
// truth; `version` is the human tag from the VERSION file.
// ---------------------------------------------------------------------------

export interface AppVersion {
  version: string | null;
  packageVersion: string;
  commit: string | null;
  commitShort: string | null;
  branch: string | null;
  environment: string | null;
  deploymentId: string | null;
}

/**
 * VERSION is not importable (not JSON), so it is read from the deployed
 * bundle. `outputFileTracingIncludes` in next.config.mjs is what guarantees it
 * ships — without an entry for the route that calls this, the read succeeds
 * locally and returns null in production. Silently wrong, not broken.
 */
function readVersionFile(): string | null {
  try {
    const raw = readFileSync(path.join(process.cwd(), "VERSION"), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function getAppVersion(): AppVersion {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  return {
    version: readVersionFile(),
    packageVersion: pkg.version,
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
  };
}

/**
 * Short label for the UI. Falls back to the commit when the VERSION file did
 * not ship, so a tracing failure is visible on screen rather than silent.
 */
export function formatVersionLabel(v: AppVersion): string {
  if (v.version) return `v${v.version}`;
  if (v.commitShort) return `build ${v.commitShort}`;
  return "version unknown";
}
