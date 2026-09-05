import { NextResponse } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { env } from "@/lib/env";
import { corpusConfigStatus } from "@/lib/corpus/db";
import { splitSqlStatements } from "@/lib/corpus/sqlStatements";

// ---------------------------------------------------------------------------
// V2.8.7 — PREVIEW-ONLY database diagnostics and the ONE scoped migration.
//
// WHY THIS EXISTS. The V2.8.7 field test needs two facts about the Preview
// deployment's database that nothing outside the deployment can establish
// without holding its connection string: which Neon branch it is (so a
// migration here can be shown never to touch production), and which
// migrations are applied. This route answers both from INSIDE the
// deployment, which already holds DATABASE_URL, so nobody has to handle the
// string. It never returns the string, or any credential, or any game data.
//
// GATES (all three, in this order):
//   1. VERCEL_ENV === "preview" — anywhere else, including production and
//      local dev, the route does not exist (404). Production schema changes
//      are not authorized and cannot be made through this route.
//   2. Vercel Deployment Protection in front of every Preview URL.
//   3. POST additionally requires the exact confirmation body
//      {"confirm":"apply-0013-once"} — no other keys, no other value.
//
// WHAT POST DOES, EXACTLY. Applies migrations/0013_ai_usage_telemetry.sql —
// that one file, never "everything pending" — in one transaction with its
// ledger row, exactly as scripts/migrate.ts would, and only if 0012 is
// already in the ledger (0013 alters the table 0012 creates). A second POST
// is a no-op ("already applied").
//
// TEMPORARY, like the M1 benchmark trigger before it: remove once the V2.8.7
// Preview field test is over. Quarantined from the secret store by
// scripts/check-isolation.mjs.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const TARGET_MIGRATION = "0013_ai_usage_telemetry.sql";
const PREREQUISITE_MIGRATION = "0012_turn_operation_telemetry.sql";
const CONFIRMATION = "apply-0013-once";

function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

function isPreview(): boolean {
  return process.env.VERCEL_ENV === "preview";
}

function migrationsDir(): string {
  return path.join(process.cwd(), "migrations");
}

function migrationFiles(): string[] {
  try {
    return readdirSync(migrationsDir())
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    return [];
  }
}

type NeonSql = ReturnType<typeof neon>;

function client(): NeonSql | null {
  const url = env.databaseUrl();
  if (!url) return null;
  return neon(url, { fetchOptions: { cache: "no-store" } });
}

async function ledger(sql: NeonSql): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;
  const rows = (await sql`SELECT filename FROM public.schema_migrations ORDER BY filename`) as Record<string, unknown>[];
  return rows.map((r) => String(r.filename));
}

/**
 * Identity of the database this deployment is actually connected to. Neon
 * exposes its tenant and timeline (= branch) ids as server settings; both
 * are read with missing_ok so a non-Neon Postgres simply reports null.
 * `in_recovery` false means a read-write primary — Neon runs exactly one
 * read-write compute per branch, which is what makes two read-write
 * endpoints two different branches.
 */
async function identity(sql: NeonSql) {
  const rows = (await sql`
    SELECT current_database()                              AS database,
           current_user                                    AS role,
           pg_is_in_recovery()                             AS in_recovery,
           current_setting('neon.tenant_id',   true)       AS tenant_id,
           current_setting('neon.timeline_id', true)       AS timeline_id,
           version()                                       AS server_version
  `) as Record<string, unknown>[];
  const r = rows[0] ?? {};
  return {
    database: r.database ?? null,
    role: r.role ?? null,
    in_recovery: r.in_recovery ?? null,
    tenant_id: r.tenant_id || null,
    timeline_id: r.timeline_id || null,
    server_version: typeof r.server_version === "string" ? r.server_version.split(" on ")[0] : null,
  };
}

async function usageColumnsPresent(sql: NeonSql): Promise<boolean> {
  const rows = (await sql`
    SELECT count(*)::int AS n
    FROM information_schema.columns
    WHERE table_schema = 'corpus' AND table_name = 'turn_operations'
      AND column_name IN ('input_tokens', 'output_tokens', 'requested_model_id', 'reasoning_effort')
  `) as Record<string, unknown>[];
  return Number(rows[0]?.n ?? 0) === 4;
}

export async function GET() {
  if (!isPreview()) return notFound();
  const status = corpusConfigStatus();
  const sql = client();
  if (!sql) {
    return NextResponse.json({ environment: "preview", corpus: status, error: "database_not_configured" }, { status: 500 });
  }
  try {
    const applied = await ledger(sql);
    const files = migrationFiles();
    return NextResponse.json({
      environment: "preview",
      deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      corpus: { host: status.host, database: status.database, reason: status.reason },
      identity: await identity(sql),
      migrations: {
        files_bundled: files.length,
        applied,
        pending: files.filter((f) => !applied.includes(f)),
        target: TARGET_MIGRATION,
        target_applied: applied.includes(TARGET_MIGRATION),
        prerequisite_applied: applied.includes(PREREQUISITE_MIGRATION),
        usage_columns_present: await usageColumnsPresent(sql),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { environment: "preview", error: "diagnostic_failed", detail: err instanceof Error ? err.constructor.name : typeof err },
      { status: 502 }
    );
  }
}

export async function POST(req: Request) {
  if (!isPreview()) return notFound();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  }
  const keys = body && typeof body === "object" ? Object.keys(body as object) : [];
  if (
    keys.length !== 1 ||
    keys[0] !== "confirm" ||
    (body as { confirm?: unknown }).confirm !== CONFIRMATION
  ) {
    return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  }

  const sql = client();
  if (!sql) return NextResponse.json({ error: "database_not_configured" }, { status: 500 });

  try {
    const applied = await ledger(sql);
    if (applied.includes(TARGET_MIGRATION)) {
      return NextResponse.json({ ok: true, result: "already_applied", migration: TARGET_MIGRATION });
    }
    if (!applied.includes(PREREQUISITE_MIGRATION)) {
      return NextResponse.json(
        { error: "prerequisite_missing", migration: TARGET_MIGRATION, requires: PREREQUISITE_MIGRATION },
        { status: 409 }
      );
    }
    const file = path.join(migrationsDir(), TARGET_MIGRATION);
    const statements = splitSqlStatements(readFileSync(file, "utf8"));
    await sql.transaction([
      ...statements.map((statement) => sql.query(statement)),
      sql.query("INSERT INTO public.schema_migrations (filename) VALUES ($1)", [TARGET_MIGRATION]),
    ]);
    return NextResponse.json({
      ok: true,
      result: "applied",
      migration: TARGET_MIGRATION,
      statements: statements.length,
      usage_columns_present: await usageColumnsPresent(sql),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "migration_failed", migration: TARGET_MIGRATION, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) },
      { status: 502 }
    );
  }
}
