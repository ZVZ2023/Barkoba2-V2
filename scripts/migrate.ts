#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// Minimal forward-only migration runner.
//
// WHY NOT AN ORM MIGRATION ENGINE: this repository has five runtime
// dependencies, hand-written storage modules and a hand-written isolation
// checker. Prisma or Drizzle would bring codegen into `npm run verify`, which
// is currently four clean steps. The requirement is "apply numbered .sql files
// once, in order, and remember which ones you applied" — that is this file.
//
//   npm run migrate           apply every pending migration
//   npm run migrate:status    report without changing anything
//
// ---------------------------------------------------------------------------
// WHY THIS IS TYPESCRIPT AND NOT .mjs — a defect post-mortem.
//
// The first version of this runner called `sql(body)` to execute a whole file.
// @neondatabase/serverless v1 rejects that at runtime:
//
//   "This function can now be called only as a tagged-template function ...
//    For a conventional function call with value placeholders, use sql.query()"
//
// It failed on the first live Neon migration. The type declaration had said so
// all along — `NeonQueryFunction`'s call signature takes a `TemplateStringsArray`,
// so `sql(string)` is a type error. It shipped only because the runner was
// `.mjs` and `tsc --noEmit` never looked at it.
//
// Being TypeScript, run through the tsx that already runs
// `scripts/evalAdjudicator.ts`, is the actual fix: this whole class of driver
// misuse now fails `npm run typecheck` instead of failing in production.
//
// TWO TRANSPORT FACTS THAT SHAPE THE DESIGN:
//
//   1. Neon's SQL-over-HTTP sends ONE statement per request. A migration file
//      is many statements, so it is split by splitSqlStatements() — which is
//      dollar-quote aware, because 0001 defines two plpgsql functions whose
//      bodies contain semicolons.
//   2. sql.transaction([...]) submits an array of queries as a single
//      non-interactive transaction. That preserves the property that matters:
//      a migration lands whole or not at all, ledger insert included.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { splitSqlStatements } from "../lib/corpus/sqlStatements";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "\nDATABASE_URL is not set.\n\n" +
      "PowerShell:  $env:DATABASE_URL='postgresql://...'\n" +
      "bash:        export DATABASE_URL='postgresql://...'\n\n" +
      "Use the Neon connection string for the production branch.\n"
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
async function ensureLedger(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // zero-padded numeric prefixes make lexical order correct
}

async function appliedSet(): Promise<Set<string>> {
  const rows = await sql`SELECT filename FROM public.schema_migrations`;
  return new Set(rows.map((r) => String(r.filename)));
}

async function main(): Promise<void> {
  await ensureLedger();

  const files = migrationFiles();
  const applied = await appliedSet();
  const pending = files.filter((f) => !applied.has(f));

  console.log(
    `\nmigrations: ${files.length} total, ${applied.size} applied, ${pending.length} pending`
  );
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
    const statements = splitSqlStatements(body);
    process.stdout.write(`\napplying ${file} (${statements.length} statements) ... `);

    try {
      // One transaction per file: every statement plus the ledger insert. A
      // failure rolls the whole thing back, so a migration can never be
      // recorded as applied when it was not — which is what let the failed
      // first attempt leave the database untouched.
      await sql.transaction([
        ...statements.map((statement) => sql.query(statement)),
        sql.query("INSERT INTO public.schema_migrations (filename) VALUES ($1)", [file]),
      ]);
      console.log("ok");
    } catch (err) {
      console.log("FAILED");
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n${file} failed and was rolled back:\n  ${message}\n`);
      // Neon surfaces the offending statement position; printing the statement
      // list length and the message beats guessing which line broke.
      process.exit(1);
    }
  }

  console.log("\nmigrations complete\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("\nmigration runner failed:", message);
  process.exit(1);
});
