/**
 * M3 — read-only full-transcript export, for scoring against docs/racer-scorecard.md.
 *
 *   npx tsx scripts/exportFullTranscript.ts --corpus-game-id <uuid>
 *   npx tsx scripts/exportFullTranscript.ts --operational-game-id <uuid>
 *   npx tsx scripts/exportFullTranscript.ts --benchmark-run-id <uuid>
 *   npx tsx scripts/exportFullTranscript.ts --corpus-game-id <uuid> --out path/to/file.json
 *
 * DELIBERATELY NOT PART OF `npm test` OR `npm run verify` — it reads the real
 * Neon corpus and needs DATABASE_URL, matching scripts/evalGameIntelligence.ts's
 * own reasoning for staying outside those.
 *
 * MAKES NO MODEL CALL OF ANY KIND. Every value it prints comes from a SELECT
 * against corpus.* via lib/corpus/transcriptExport.ts. No scoring, no
 * judgment, no Racer Guidance change — this script only reconstructs the
 * turn-by-turn record so a later, separate step can score it.
 *
 * READ-ONLY. Never writes to corpus.*. --out, if given, writes only to the
 * local filesystem, never back to the database.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  fetchFullTranscriptByCorpusGameId,
  fetchFullTranscriptByOperationalGameId,
  fetchFullTranscriptsByBenchmarkRunId,
  type FullTranscript,
} from "../lib/corpus/transcriptExport";

/** Same minimal .env.local loader as scripts/evalGameIntelligence.ts — see that file for why. */
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

  const corpusGameId = arg("corpus-game-id");
  const operationalGameId = arg("operational-game-id");
  const benchmarkRunId = arg("benchmark-run-id");
  const outPath = arg("out");

  const identifiersGiven = [corpusGameId, operationalGameId, benchmarkRunId].filter(
    Boolean
  ).length;
  if (identifiersGiven !== 1) {
    console.error(
      "Usage: npx tsx scripts/exportFullTranscript.ts " +
        "(--corpus-game-id <uuid> | --operational-game-id <uuid> | --benchmark-run-id <uuid>) " +
        "[--out path/to/file.json]\n" +
        "Exactly one identifier is required."
    );
    process.exit(1);
  }

  let result: FullTranscript[] | null;
  if (corpusGameId) {
    const one = await fetchFullTranscriptByCorpusGameId(corpusGameId);
    result = one ? [one] : one;
  } else if (operationalGameId) {
    const one = await fetchFullTranscriptByOperationalGameId(operationalGameId);
    result = one ? [one] : one;
  } else {
    result = await fetchFullTranscriptsByBenchmarkRunId(benchmarkRunId as string);
  }

  if (result === null) {
    console.error(
      "[exportFullTranscript] read failed — corpus unreachable/unconfigured, or the " +
        "identifier matched no row. See the console error above for detail."
    );
    process.exit(1);
  }

  if (result.length === 0) {
    console.log("[exportFullTranscript] no games matched.");
    return;
  }

  const json = JSON.stringify(corpusGameId || operationalGameId ? result[0] : result, null, 2);
  console.log(json);

  if (outPath) {
    const resolvedOut = resolve(process.cwd(), outPath);
    mkdirSync(dirname(resolvedOut), { recursive: true });
    writeFileSync(resolvedOut, json + "\n", "utf8");
    console.error(`\n[exportFullTranscript] wrote ${resolvedOut}`);
  }
}

void main();
