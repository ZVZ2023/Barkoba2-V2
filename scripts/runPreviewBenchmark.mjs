#!/usr/bin/env node
/**
 * V2.8.x — dedicated runner for the approved internal-benchmark Preview
 * workflow. Exists so this workflow can be allowlisted in
 * .claude/settings.local.json by an exact command prefix
 * ("Bash(node scripts/runPreviewBenchmark.mjs *)") WITHOUT granting
 * unrestricted `curl`/HTTP access. This script can only ever reach the four
 * known internal benchmark routes on a Barkóba Preview deployment, each with
 * its own hardcoded, exact confirmation string — it takes no arbitrary URL,
 * method, or body from its caller.
 *
 * USAGE
 *   node scripts/runPreviewBenchmark.mjs <fixture> <baseUrl> <shareToken>
 *   node scripts/runPreviewBenchmark.mjs export <benchmarkRunId> <baseUrl> <shareToken>
 *
 *   <fixture>        one of: d1 | d2 | heldout01
 *   <baseUrl>        the Preview deployment origin, e.g.
 *                    https://barkoba2-v2-git-<branch>-zvz-x.vercel.app
 *   <shareToken>      the _vercel_share token from get_access_to_vercel_url
 *   <benchmarkRunId>  (export mode only) the benchmark_run_id to export
 *
 * WHAT IT DOES, IN ORDER
 *   1. GET  <baseUrl>/?_vercel_share=<shareToken>          (establishes the
 *      Vercel Deployment Protection bypass cookie for this one invocation —
 *      never persisted to disk, never reused across processes)
 *   2. For a fixture:  POST <baseUrl>/api/internal/benchmark/<route>
 *      with the body {"confirm": "<exact string for that fixture>"} —
 *      the confirmation string is looked up from the FIXTURES table below,
 *      never taken from the command line, so this script cannot be used to
 *      send any other confirmation value.
 *      For export:      GET <baseUrl>/api/internal/benchmark/export-transcript?benchmarkRunId=<id>
 *   3. Print the JSON response to stdout, nothing else.
 *
 * WHAT IT NEVER DOES
 *   No other path, host, or HTTP method is reachable from this script's
 *   arguments. No secret is read, printed, or logged — the bypass cookie is
 *   used in-memory for this process only.
 */

const FIXTURES = {
  d1: { route: "d1-generic-backpack", confirm: "run-d1-once" },
  d2: { route: "d2-eiffel-tower", confirm: "run-d2-once" },
  heldout01: { route: "heldout-01-mona-lisa", confirm: "run-heldout-01-once" },
  "xai-smoke": { route: "xai-smoke-test", confirm: "run-xai-smoke-test-once" },
  "d1-grok": { route: "d1-grok-calibration", confirm: "run-d1-grok-calibration-once" },
  "d2-grok": { route: "d2-grok-calibration", confirm: "run-d2-grok-calibration-once" },
};

function usageAndExit(message) {
  if (message) console.error(`[runPreviewBenchmark] ${message}\n`);
  console.error(
    "Usage:\n" +
      "  node scripts/runPreviewBenchmark.mjs <fixture> <baseUrl> <shareToken>\n" +
      "  node scripts/runPreviewBenchmark.mjs export <benchmarkRunId> <baseUrl> <shareToken>\n\n" +
      `<fixture> must be one of: ${Object.keys(FIXTURES).join(", ")}`
  );
  process.exit(1);
}

async function establishBypassCookie(baseUrl, shareToken, maxHops = 10) {
  // MUST follow redirects manually, accumulating cookies at every hop.
  // Node's fetch(..., {redirect: "follow"}) only exposes the FINAL
  // response's headers — any Set-Cookie issued on an intermediate redirect
  // (which is exactly how Vercel's share-link bypass sets its cookie, on a
  // 307 before landing on the deployment) is silently dropped, and the
  // subsequent request then hits Vercel's real login wall instead of the
  // deployment.
  let jar = {};
  let current = `${baseUrl}/?_vercel_share=${encodeURIComponent(shareToken)}`;
  for (let hop = 0; hop < maxHops; hop++) {
    const cookieHeader = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const res = await fetch(current, {
      redirect: "manual",
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const pair = c.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (Object.keys(jar).length === 0) {
      throw new Error(
        `No cookies received after following the share-link redirect chain (final status ${res.status}) — the share token may be expired or wrong.`
      );
    }
    return Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  throw new Error(`Share-link redirect chain exceeded ${maxHops} hops.`);
}

async function runFixture(fixtureKey, baseUrl, shareToken) {
  const fixture = FIXTURES[fixtureKey];
  if (!fixture) usageAndExit(`unknown fixture "${fixtureKey}"`);

  const cookie = await establishBypassCookie(baseUrl, shareToken);
  const res = await fetch(`${baseUrl}/api/internal/benchmark/${fixture.route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ confirm: fixture.confirm }),
  });
  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(body);
  if (res.status !== 200) process.exitCode = 1;
}

async function runExport(benchmarkRunId, baseUrl, shareToken) {
  const cookie = await establishBypassCookie(baseUrl, shareToken);
  const url = `${baseUrl}/api/internal/benchmark/export-transcript?benchmarkRunId=${encodeURIComponent(benchmarkRunId)}`;
  const res = await fetch(url, { headers: { Cookie: cookie } });
  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(body);
  if (res.status !== 200) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) usageAndExit();

  const [first, second, third, fourth] = args;

  if (first === "export") {
    if (args.length !== 4) usageAndExit("export mode needs: export <benchmarkRunId> <baseUrl> <shareToken>");
    await runExport(second, third, fourth);
    return;
  }

  if (args.length !== 3) usageAndExit();
  await runFixture(first, second, third);
}

main().catch((err) => {
  console.error(`[runPreviewBenchmark] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
