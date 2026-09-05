import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { env } from "@/lib/env";
import { corpusConfigStatus } from "@/lib/corpus/db";
import { splitSqlStatements } from "@/lib/corpus/sqlStatements";

// ---------------------------------------------------------------------------
// V2.8.7 — PREVIEW-ONLY, OPERATOR-AUTHORIZED database diagnostics and the
// ONE fixed migration plan for the verified Preview database.
//
// TEMPORARY. Removed once the V2.8.7 Preview field test is over.
//
// FOUR GATES, IN ORDER, ALL REQUIRED:
//   1. VERCEL_ENV === "preview" — anywhere else the route does not exist.
//   2. Vercel Deployment Protection in front of every Preview URL.
//   3. SERVER-SIDE OPERATOR AUTHORIZATION: the caller must present the
//      deployment's own BENCHMARK_INGRESS_SECRET (the existing operator
//      secret, compared in constant time). The account-based admin allowlist
//      (lib/admin.ts) cannot be used here: it needs the accounts tables that
//      this very plan creates on the Preview database. Unconfigured secret
//      means NO access for anyone — it never falls open.
//   4. DATABASE IDENTITY PIN: before reporting or changing anything, the
//      connected database must report exactly the Neon tenant id, timeline
//      (branch) id and database name observed on 2026-09-05 for the Preview
//      branch. Any other database — production above all — aborts with
//      identity_mismatch. VERCEL_ENV alone never establishes isolation.
//
// THE PLAN. Exactly the eight files below, in dependency order, each in ONE
// transaction with its own ledger row (identical to scripts/migrate.ts's
// per-file semantics). A file already in the ledger is skipped; the first
// failure stops the run with nothing after it attempted. The ledger is keyed
// by FULL FILENAME, so the unrelated `0012_racer_guidance_catalog.sql`
// already present neither hides nor collides with
// `0012_turn_operation_telemetry.sql` — both names are checked literally.
// Nothing here resets, drops, or deletes; nothing here can run outside
// Preview or against any other database.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/** Observed on 2026-09-05 via this route's own identity query on the Preview branch. */
const PINNED_IDENTITY = {
  tenant_id: "364938e972147a257364743636f6c500",
  timeline_id: "6dae9a7a8a8835838a103bd3d731e427",
  database: "neondb",
} as const;

/** The authorized plan — nothing else is ever read for application. */
const PLAN = [
  "0006_contest_verdict.sql",
  "0007_unlimited_play.sql",
  "0008_purchase_provenance.sql",
  "0009_player_accounts.sql",
  "0010_registration_email_photo.sql",
  "0011_email_unique.sql",
  "0012_turn_operation_telemetry.sql",
  "0013_ai_usage_telemetry.sql",
] as const;

const UNRELATED_SAME_PREFIX = "0012_racer_guidance_catalog.sql";

function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

function isPreview(): boolean {
  return process.env.VERCEL_ENV === "preview";
}

function operatorAuthorized(presented: string): boolean {
  const expected = env.benchmarkIngressSecret();
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type NeonSql = ReturnType<typeof neon>;

function client(): NeonSql | null {
  const url = env.databaseUrl();
  if (!url) return null;
  return neon(url, { fetchOptions: { cache: "no-store" } });
}

async function identity(sql: NeonSql) {
  const rows = (await sql`
    SELECT current_database()                        AS database,
           current_user                              AS role,
           pg_is_in_recovery()                       AS in_recovery,
           current_setting('neon.tenant_id',   true) AS tenant_id,
           current_setting('neon.timeline_id', true) AS timeline_id
  `) as Record<string, unknown>[];
  const r = rows[0] ?? {};
  return {
    database: typeof r.database === "string" ? r.database : null,
    role: typeof r.role === "string" ? r.role : null,
    in_recovery: r.in_recovery === true,
    tenant_id: typeof r.tenant_id === "string" && r.tenant_id ? r.tenant_id : null,
    timeline_id: typeof r.timeline_id === "string" && r.timeline_id ? r.timeline_id : null,
  };
}

function identityMatches(id: Awaited<ReturnType<typeof identity>>): boolean {
  return (
    id.tenant_id === PINNED_IDENTITY.tenant_id &&
    id.timeline_id === PINNED_IDENTITY.timeline_id &&
    id.database === PINNED_IDENTITY.database &&
    id.in_recovery === false
  );
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

async function usageColumnsPresent(sql: NeonSql): Promise<boolean> {
  const rows = (await sql`
    SELECT count(*)::int AS n
    FROM information_schema.columns
    WHERE table_schema = 'corpus' AND table_name = 'turn_operations'
      AND column_name IN ('input_tokens', 'output_tokens', 'requested_model_id', 'reasoning_effort')
  `) as Record<string, unknown>[];
  return Number(rows[0]?.n ?? 0) === 4;
}

/**
 * Usage evidence so far — per game and seat: call counts, how many carried
 * usage, and token SUMS (for pricing). Operational figures only: no
 * question text, answers, targets, or player identity.
 */
async function usageEvidence(sql: NeonSql) {
  try {
    const rows = (await sql`
      SELECT game_id, operation_kind, provider, model_id, status,
             count(*)::int                       AS calls,
             count(input_tokens)::int            AS with_usage,
             sum(input_tokens)::int              AS input_tokens,
             sum(cached_input_tokens)::int       AS cached_input_tokens,
             sum(cache_write_input_tokens)::int  AS cache_write_input_tokens,
             sum(output_tokens)::int             AS output_tokens,
             sum(reasoning_tokens)::int          AS reasoning_tokens
      FROM corpus.turn_operations
      WHERE operation_kind <> 'corpus_write'
      GROUP BY game_id, operation_kind, provider, model_id, status
      ORDER BY game_id, operation_kind, status
    `) as Record<string, unknown>[];
    return rows;
  } catch {
    return null;
  }
}

function page(): NextResponse {
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Preview database — operator</title>
<style>body{font:16px system-ui;margin:2rem;max-width:32rem}label{display:block;margin:1rem 0 .25rem}input,select,button{font:inherit;width:100%;padding:.6rem}button{margin-top:1rem}</style>
<h1>Preview database — operator</h1>
<p>Preview only. The secret is sent to this deployment and compared server-side; it is never stored or logged.</p>
<form method="post">
<label for="secret">Operator secret (BENCHMARK_INGRESS_SECRET)</label>
<input id="secret" name="secret" type="password" autocomplete="off" required>
<label for="action">Action</label>
<select id="action" name="action"><option value="status">Status only (read)</option><option value="apply">Apply the eight-file plan</option></select>
<button type="submit">Run</button>
</form>`;
  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
}

export async function GET() {
  if (!isPreview()) return notFound();
  return page();
}

async function readBody(req: Request): Promise<{ secret: string; action: string }> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return { secret: String(body.secret ?? ""), action: String(body.action ?? "") };
  }
  const form = await req.formData().catch(() => null);
  return { secret: String(form?.get("secret") ?? ""), action: String(form?.get("action") ?? "") };
}

export async function POST(req: Request) {
  if (!isPreview()) return notFound();

  const { secret, action } = await readBody(req);
  if (!env.benchmarkIngressSecret()) {
    return NextResponse.json({ error: "operator_secret_not_configured" }, { status: 500 });
  }
  if (!operatorAuthorized(secret)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (action !== "status" && action !== "apply") {
    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  }

  const status = corpusConfigStatus();
  const sql = client();
  if (!sql) return NextResponse.json({ error: "database_not_configured" }, { status: 500 });

  try {
    const id = await identity(sql);
    if (!identityMatches(id)) {
      // eslint-disable-next-line no-console
      console.error("[preview-db] identity_mismatch — refusing", { observed: id, pinned: PINNED_IDENTITY });
      return NextResponse.json({ error: "identity_mismatch", observed: id, pinned: PINNED_IDENTITY }, { status: 409 });
    }

    const before = await ledger(sql);
    const report = {
      environment: "preview",
      deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      corpus: { host: status.host, database: status.database, reason: status.reason },
      identity: id,
      ledger: before,
      unrelated_same_prefix_present: before.includes(UNRELATED_SAME_PREFIX),
      plan: PLAN,
      plan_pending: PLAN.filter((f) => !before.includes(f)),
      usage_columns_present: await usageColumnsPresent(sql),
      usage_evidence: await usageEvidence(sql),
    };

    if (action === "status") return NextResponse.json(report);

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const file of PLAN) {
      if (before.includes(file)) {
        skipped.push(file);
        continue;
      }
      const statements = splitSqlStatements(readFileSync(path.join(process.cwd(), "migrations", file), "utf8"));
      try {
        await sql.transaction([
          ...statements.map((statement) => sql.query(statement)),
          sql.query("INSERT INTO public.schema_migrations (filename) VALUES ($1)", [file]),
        ]);
        applied.push(file);
        // eslint-disable-next-line no-console
        console.log(`[preview-db] applied ${file} (${statements.length} statements) on timeline ${id.timeline_id}`);
      } catch (err) {
        const detail = err instanceof Error ? err.message.slice(0, 300) : String(err);
        // eslint-disable-next-line no-console
        console.error(`[preview-db] FAILED ${file} — rolled back, stopping: ${detail}`);
        return NextResponse.json(
          { ...report, error: "migration_failed", failed: file, detail, applied, skipped, ledger_after: await ledger(sql) },
          { status: 502 }
        );
      }
    }

    const after = await ledger(sql);
    // eslint-disable-next-line no-console
    console.log(`[preview-db] plan complete: applied=${applied.length} skipped=${skipped.length} ledger=${after.length}`);
    return NextResponse.json({
      ...report,
      ok: true,
      applied,
      skipped,
      ledger_after: after,
      usage_columns_present: await usageColumnsPresent(sql),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "diagnostic_failed", detail: err instanceof Error ? err.constructor.name : typeof err },
      { status: 502 }
    );
  }
}
