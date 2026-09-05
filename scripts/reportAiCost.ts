/* eslint-disable no-console */
import { getSql, isCorpusConfigured } from "../lib/corpus/db";
import {
  summarizeCohort,
  summarizeGameCosts,
  type GameCostReport,
  type OperationCostRow,
} from "../lib/aiCost";

// ---------------------------------------------------------------------------
// V2.8.7 — per-game AI cost report.
//
// READ-ONLY. Reads corpus.turn_operations (migration 0013's usage columns)
// and corpus.games' lifecycle, prices every recorded call with lib/aiCost.ts,
// and prints Racer / adjudication / other / total per game, then completed
// and abandoned cohorts separately. It never writes, never calls a provider,
// and never reads a secret (both tables are quarantined from the secret by
// construction — see migrations/0012 and scripts/check-isolation.mjs).
//
//   Run:  npx tsx scripts/reportAiCost.ts [--days N] [--game GAME_ID]
//   Needs: DATABASE_URL (and CORPUS_ENABLED=true) in the environment.
// ---------------------------------------------------------------------------

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function seatLine(label: string, r: GameCostReport["racer"]): string {
  const caveat =
    r.unknown_usage_calls || r.unpriced_model_calls
      ? ` (+${r.unknown_usage_calls} unknown-usage, +${r.unpriced_model_calls} unpriced-model — NOT included)`
      : "";
  return `  ${label.padEnd(13)} ${usd(r.usd).padStart(10)}  ${r.priced_calls}/${r.calls} calls priced${caveat}`;
}

async function main(): Promise<void> {
  if (!isCorpusConfigured()) {
    console.error("[reportAiCost] corpus is not configured (DATABASE_URL / CORPUS_ENABLED). Nothing to read.");
    process.exit(1);
  }
  const sql = getSql();
  if (!sql) {
    console.error("[reportAiCost] could not initialise the SQL client.");
    process.exit(1);
  }

  const days = Number.parseInt(arg("--days") ?? "30", 10);
  const onlyGame = arg("--game");

  const rows = (await sql`
    SELECT game_id, operation_kind, provider, model_id, status,
           input_tokens, cached_input_tokens, cache_write_input_tokens,
           output_tokens, reasoning_tokens
    FROM corpus.turn_operations
    WHERE operation_kind <> 'corpus_write'
      AND started_at > now() - (${String(days)} || ' days')::interval
      AND (${onlyGame}::text IS NULL OR game_id = ${onlyGame})
    ORDER BY game_id, started_at
  `) as unknown as OperationCostRow[];

  const gameIds = Array.from(new Set(rows.map((r) => r.game_id)));
  const lifecycleRows = gameIds.length
    ? ((await sql`
        SELECT operational_game_id, lifecycle_state
        FROM corpus.games
        WHERE operational_game_id = ANY(${gameIds})
      `) as unknown as Array<{ operational_game_id: string; lifecycle_state: string }>)
    : [];
  const lifecycle = new Map(lifecycleRows.map((r) => [r.operational_game_id, r.lifecycle_state]));

  const reports = summarizeGameCosts(rows, lifecycle);

  console.log(`\nAI cost per game — last ${days} day(s), ${reports.length} game(s) with recorded calls\n`);
  for (const r of reports) {
    console.log(`${r.game_id}  [${r.lifecycle_state}]${r.fully_priced ? "" : "  ** partially priced **"}`);
    console.log(seatLine("racer", r.racer));
    console.log(seatLine("adjudication", r.adjudication));
    console.log(seatLine("other", r.other));
    console.log(seatLine("TOTAL", r.total));
  }

  const completed = summarizeCohort(reports.filter((r) => r.completed));
  const abandoned = summarizeCohort(reports.filter((r) => !r.completed));

  const cohort = (label: string, c: ReturnType<typeof summarizeCohort>) => {
    console.log(`\n${label}: ${c.games} game(s), ${c.fully_priced_games} fully priced`);
    if (c.fully_priced_games === 0) {
      console.log("  no fully priced game yet — no per-game figure is reported (unknown is not zero)");
      return;
    }
    console.log(`  racer        ${usd(c.racer_usd_fully_priced)}`);
    console.log(`  adjudication ${usd(c.adjudication_usd_fully_priced)}`);
    console.log(`  other        ${usd(c.other_usd_fully_priced)}`);
    console.log(`  total        ${usd(c.total_usd_fully_priced)}   mean/game ${usd(c.mean_total_usd ?? 0)}`);
  };
  cohort("COMPLETED games", completed);
  cohort("ABANDONED / unresolved games", abandoned);
  console.log("");
}

void main().catch((err) => {
  console.error("[reportAiCost] FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
