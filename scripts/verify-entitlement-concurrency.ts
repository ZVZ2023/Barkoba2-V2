#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// V2.4 — LIVE concurrency verification for the Play Credit charge.
//
// DISPOSABLE VERIFICATION HARNESS. Untracked on purpose: this is not product
// code and is not committed. Delete it after the gate closes.
//
// WHY IT EXISTS: the concurrency tests in test/entitlements.test.ts model
// PostgreSQL READ COMMITTED and model pg_advisory_xact_lock. Modelling proves
// the mechanism is sound; it cannot prove Neon behaves that way. This runs the
// SHIPPED code path — lib/entitlements.consumeForGame — against the real
// database.
//
// It is genuinely concurrent: each sql.transaction() is a separate HTTP
// request, so the two attempts land on two Postgres sessions and actually
// contend for the advisory lock.
//
//   DATABASE_URL='postgresql://…' npx tsx scripts/verify-entitlement-concurrency.ts
//
// SAFETY
//   - touches accounts.entitlement_ledger ONLY; never corpus.*, never Redis
//   - refuses to run unless the player id carries the synthetic prefix
//   - writes one grant and (expected) one consumption, then reads back
//   - performs NO cleanup: the ledger is append-only, and neutralising the test
//     is a decision for the owner, not this script
//
// Setting ENTITLEMENTS_ENABLED here affects THIS PROCESS ONLY. It does not
// enable entitlement in Vercel, and this script does not read or write any
// deployment configuration.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { getSql } from "../lib/corpus/db";
import { consumeForGame, getBalance, getStatus, grantComplimentary } from "../lib/entitlements";

const PREFIX = "test_verify_0004_";

/** Budget 20 costs 1 Play Credit, keeping this harness's arithmetic unambiguous. */
const BUDGET = 20;

function line() {
  console.log("─".repeat(74));
}

/**
 * Every write target must be synthetic. Called immediately before each write
 * rather than once at startup: a guard that runs on a value it just built
 * itself proves nothing, which is what the first version of this file did.
 */
function assertSynthetic(playerId: string): string {
  if (!playerId.startsWith(PREFIX)) {
    throw new Error(
      `refusing to write to a non-synthetic player id (${playerId.slice(0, 12)}…). ` +
        `This harness may only touch ids prefixed "${PREFIX}".`
    );
  }
  return playerId;
}

async function main(): Promise<void> {
  // TWO LOCKS, BOTH DELIBERATE.
  //
  // DATABASE_URL is commonly already exported in a shell that has just run a
  // migration. Requiring only that would mean an accidental `npx tsx
  // scripts/…` writes to production on the spot. So an explicit --confirm is
  // also required, and without it this does nothing but describe itself.
  const confirmed = process.argv.includes("--confirm");

  if (!process.env.DATABASE_URL) {
    console.error("\nDATABASE_URL is not set.\n  PowerShell: $env:DATABASE_URL='postgresql://…'\n");
    process.exit(1);
  }

  if (!confirmed) {
    line();
    console.log("DRY RUN — nothing was sent to any database.");
    line();
    console.log("This harness writes real rows to accounts.entitlement_ledger:");
    console.log(`  • 1 complimentary_grant for a fresh synthetic player ("${PREFIX}…")`);
    console.log("  • 1 consumption (the winning concurrent charge)");
    console.log("It never UPDATEs or DELETEs, never touches corpus.*, never touches");
    console.log("Redis, and only ever references the synthetic id it just minted.");
    console.log("The ledger is append-only, so those two rows are permanent.");
    line();
    console.log("Re-run with --confirm to execute against the DATABASE_URL now set.\n");
    return;
  }

  // Required by consumeForGame's own gate. Process-local: this mutates only
  // this process's environment and changes nothing in Vercel or any .env file.
  process.env.CORPUS_ENABLED = "true";
  process.env.ENTITLEMENTS_ENABLED = "true";

  const playerId = assertSynthetic(
    `${PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}`
  );

  const gameA = randomUUID();
  const gameB = randomUUID();

  line();
  console.log("V2.4 LIVE CONCURRENCY VERIFICATION — Play Credit double-spend guard");
  line();
  console.log("player_id :", playerId);
  console.log("game A    :", gameA);
  console.log("game B    :", gameB);
  console.log("cost/game : 1");
  line();

  // --- 1. exactly one credit -----------------------------------------------
  await grantComplimentary(assertSynthetic(playerId), 1, {
    grantKey: "verify_0004",
    note: "0004 concurrency verification — synthetic",
  });
  const opening = await getBalance(playerId);
  console.log(`opening balance                    : ${opening}`);
  if (opening !== 1) {
    console.error("\nFAIL: expected an opening balance of exactly 1.\n");
    process.exit(1);
  }

  // --- 2. two genuinely concurrent charges, different games -----------------
  // Fired together, not awaited in sequence: two HTTP requests, two Postgres
  // sessions, one advisory lock between them.
  const started = Date.now();
  // Budget 20 -> cost 1 (lib/questionBudget.ts), so the arithmetic stays the
  // one-credit case this harness was written to prove.
  const [a, b] = await Promise.all([
    consumeForGame(assertSynthetic(playerId), gameA, BUDGET),
    consumeForGame(assertSynthetic(playerId), gameB, BUDGET),
  ]);
  const elapsed = Date.now() - started;

  console.log(`game A outcome                     : ${JSON.stringify(a)}`);
  console.log(`game B outcome                     : ${JSON.stringify(b)}`);
  console.log(`both attempts completed in         : ${elapsed}ms`);

  // --- 3. read back the authoritative state --------------------------------
  const sql = getSql();
  if (!sql) throw new Error("no database client");

  const rows = await sql`
    SELECT entry_id, kind, amount, operational_game_id, grant_key, created_at, note
      FROM accounts.entitlement_ledger
     WHERE player_id = ${playerId}
     ORDER BY entry_id
  `;
  const status = await getStatus(playerId);

  line();
  console.log("LEDGER ROWS");
  line();
  for (const r of rows) {
    console.log(
      `  #${String(r.entry_id).padEnd(6)} ${String(r.kind).padEnd(20)} ` +
        `amount=${String(r.amount).padStart(3)}  game=${r.operational_game_id ?? "—"}`
    );
  }
  line();
  console.log("STATUS:", JSON.stringify(status));
  line();

  // --- 4. the assertions the gate requires ----------------------------------
  const succeeded = [a, b].filter((r) => r.ok && r.reason === "consumed").length;
  const refused = [a, b].filter((r) => !r.ok && r.reason === "insufficient_balance").length;
  const consumptions = rows.filter((r) => r.kind === "consumption").length;

  const checks: Array<[string, boolean, string]> = [
    ["exactly one consumption SUCCEEDED", succeeded === 1, `got ${succeeded}`],
    ["exactly one REFUSED for insufficient entitlement", refused === 1, `got ${refused}`],
    ["exactly one consumption ledger entry exists", consumptions === 1, `got ${consumptions}`],
    ["final balance is 0", status.balance === 0, `got ${status.balance}`],
    ["balance never negative", status.balance >= 0, `got ${status.balance}`],
    ["the two games are distinct", gameA !== gameB, "identical"],
  ];

  let failed = 0;
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `  (${detail})`}`);
    if (!pass) failed += 1;
  }
  line();

  if (failed > 0) {
    console.error(
      `\n${failed} CHECK(S) FAILED — live Neon behaviour differs from the modelled tests.\n` +
        `STOP. Report before modifying architecture.\n`
    );
    process.exit(1);
  }

  console.log("\nALL CHECKS PASSED — the per-player advisory lock holds on production Neon.\n");
  console.log("Cleanup: NONE APPLIED. The ledger is append-only and this script");
  console.log("does not neutralise anything. Balance already rests at 0.");
  console.log(`Locate this run later with:  player_id = '${playerId}'\n`);
}

main().catch((err: unknown) => {
  console.error("\nverification harness failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
