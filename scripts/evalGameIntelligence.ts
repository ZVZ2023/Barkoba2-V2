/**
 * M2 — deterministic game-intelligence evaluation query.
 *
 *   npx tsx scripts/evalGameIntelligence.ts --benchmark-run-id <uuid>
 *   npx tsx scripts/evalGameIntelligence.ts --game-id <operational game uuid>
 *
 * DELIBERATELY NOT PART OF `npm test` OR `npm run verify` — it reads the real
 * Neon corpus and needs DATABASE_URL, matching scripts/evalAdjudicator.ts's own
 * reasoning for staying outside those.
 *
 * MAKES NO MODEL CALL OF ANY KIND. Every value it prints is either read
 * directly from corpus.* or computed by the pure, unit-tested
 * computeDeterministicSignals() in lib/corpus/gameIntelligenceSignals.ts. There
 * is no LLM judge on this path, per the M2 design lock against defaulting to
 * one for anything mechanically determinable.
 *
 * READ-ONLY. Every function this script calls issues SELECT statements only —
 * it cannot write to, or otherwise mutate, the corpus it reports on.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchGameIntelligenceByBenchmarkRun,
  fetchGameIntelligenceByOperationalGameId,
} from "../lib/corpus/gameIntelligenceSignals";

/** Same minimal .env.local loader as scripts/evalAdjudicator.ts — see that file for why. */
function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    return;
  }
}

loadEnvFiles();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.split("=").slice(1).join("=") : null;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "\nDATABASE_URL is not set — this script reads the real Neon corpus and " +
        "cannot run without it.\n\n" +
        "PowerShell:  $env:DATABASE_URL='postgresql://...'\n" +
        "bash:        export DATABASE_URL='postgresql://...'\n\n" +
        "CORPUS_ENABLED must also read as true (see lib/corpus/db.ts).\n"
    );
    process.exit(1);
  }
  if (!process.env.CORPUS_ENABLED) process.env.CORPUS_ENABLED = "true";

  const benchmarkRunId = arg("benchmark-run-id");
  const gameId = arg("game-id");

  if (!benchmarkRunId && !gameId) {
    console.error(
      "Usage: npx tsx scripts/evalGameIntelligence.ts --benchmark-run-id <uuid> | --game-id <uuid>"
    );
    process.exit(1);
  }

  const records = benchmarkRunId
    ? await fetchGameIntelligenceByBenchmarkRun(benchmarkRunId)
    : await fetchGameIntelligenceByOperationalGameId(gameId as string).then((r) =>
        r ? [r] : null
      );

  if (records === null) {
    console.error(
      "[evalGameIntelligence] read failed — corpus unreachable/unconfigured, or the " +
        "identifier matched no row. See the console error above for detail."
    );
    process.exit(1);
  }

  if (records.length === 0) {
    console.log("[evalGameIntelligence] no games matched.");
    return;
  }

  console.log(JSON.stringify(records, null, 2));
}

void main();
