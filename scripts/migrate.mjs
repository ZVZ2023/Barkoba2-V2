#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Minimal forward-only migration runner.
//
// WHY NOT AN ORM MIGRATION ENGINE: this repository has four runtime
// dependencies, hand-written storage modules and a hand-written isolation
// checker. Prisma or Drizzle would bring codegen into `npm run verify`, which
// is currently four clean steps. The whole requirement here is "apply numbered
// .sql files once, in order, and remember which ones you applied" — that is
// this file, and it is auditable in one sitting.
//
//   npm run migrate           apply every pending migration
//   npm run migrate:status    report without changing anything
//
// Each file runs inside a single transaction, so a migration either lands whole
// or not at all. Migrations are forward-only by design: there is no `down`,
// because a down-migration against real evidence is a data-loss tool wearing a
// safety label.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "\nDATABASE_URL is not set.\n\n" +
      "Local:  export DATABASE_URL='postgresql://...'  (Neon connection string)\n" +
      "Vercel: already configured in Production and Preview.\n"
  );
  process.exit(1);
}

const sql = neon(url);
const statusOnly = process.argv.includes("--status");

/**
 * The ledger lives in `public` rather than `corpus`, because migration 0001 is
 * what creates `corpus`. A ledger inside the schema it is responsible for
 * creating cannot record its own creation.
 */
async function ensureLedger() {
  await sql`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;
}

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // zero-padded numeric prefixes make lexical order correct
}

async function appliedSet() {
  const rows = await sql`SELECT filename FROM public.schema_migrations`;
  return new Set(rows.map((r) => r.filename));
}

async function main() {
  await ensureLedger();

  const files = migrationFiles();
  const applied = await appliedSet();
  const pending = files.filter((f) => !applied.has(f));

  console.log(`\nmigrations: ${files.length} total, ${applied.size} applied, ${pending.length} pending`);
  for (const f of files) console.log(`  ${applied.has(f) ? "✓" : "·"} ${f}`);

  if (statusOnly) {
    console.log("\n(--status: nothing was applied)\n");
    return;
  }
  if (pending.length === 0) {
    console.log("\nup to date\n");
    return;
  }

  for (const file of pending) {
    const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    process.stdout.write(`\napplying ${file} ... `);
    try {
      // A migration is one transaction: it lands whole or not at all. The
      // ledger insert is inside it, so a failure cannot leave a migration
      // recorded as applied when it was not.
      await sql.transaction([sql(body), sql`INSERT INTO public.schema_migrations (filename) VALUES (${file})`]);
      console.log("ok");
    } catch (err) {
      console.log("FAILED");
      console.error(`\n${file} failed and was rolled back:\n`, err?.message ?? err);
      process.exit(1);
    }
  }

  console.log("\nmigrations complete\n");
}

main().catch((err) => {
  console.error("\nmigration runner failed:", err?.message ?? err);
  process.exit(1);
});
