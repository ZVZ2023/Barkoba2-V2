import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  fetchFullTranscriptByCorpusGameId,
  fetchFullTranscriptByOperationalGameId,
  fetchFullTranscriptsByBenchmarkRunId,
} from "@/lib/corpus/transcriptExport";

// ---------------------------------------------------------------------------
// TEMPORARY — M4 evidence-preservation utility only. Delete this route once
// M4's evidence has been pulled and committed to docs/m4-evidence/.
//
// WHAT THIS IS. scripts/exportFullTranscript.ts's exact read, exposed over
// HTTP instead of a local CLI, so an M4 session without a local DATABASE_URL
// can still pull evidence-grade transcripts from a Preview deployment that
// already has one configured. Reuses lib/corpus/transcriptExport.ts
// unchanged — per the M1/M3 convention this milestone was told to follow
// ("reuse this for any further evidence-gathering; do not rebuild it") —
// rather than reimplementing the query.
//
// READ-ONLY, NO SECRET ACCESS. lib/corpus/transcriptExport.ts is QUARANTINED
// in scripts/check-isolation.mjs (never imports secretStore/gameStore) and
// issues only SELECTs — this route inherits both properties unchanged. It
// makes no model call and cannot mutate a game.
//
// AUTH MODEL (same shape as the other internal/benchmark routes):
//   1. Preview-only. Refuses (404) unless process.env.VERCEL_ENV === "preview".
//   2. BENCHMARK_INGRESS_SECRET is a readiness gate only, exactly as in the
//      sibling routes — never compared against anything the caller supplies.
//   3. GET, not POST+confirmation — this is idempotent and has no side
//      effect or cost, unlike the fixture-running routes, so the heavier
//      exact-confirmation-body ceremony those need does not apply here.
//   4. Exactly one of ?corpusGameId=, ?operationalGameId=, ?benchmarkRunId=
//      is required — mirrors exportFullTranscript.ts's own CLI contract.
// ---------------------------------------------------------------------------

export const maxDuration = 60;

function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (process.env.VERCEL_ENV !== "preview") {
    return notFound();
  }

  if (!env.benchmarkIngressSecret()) {
    return NextResponse.json({ error: "benchmark_secret_not_configured" }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const corpusGameId = searchParams.get("corpusGameId");
  const operationalGameId = searchParams.get("operationalGameId");
  const benchmarkRunId = searchParams.get("benchmarkRunId");

  const given = [corpusGameId, operationalGameId, benchmarkRunId].filter(Boolean).length;
  if (given !== 1) {
    return NextResponse.json(
      {
        error: "bad_request",
        message:
          "exactly one of corpusGameId, operationalGameId, benchmarkRunId query params is required",
      },
      { status: 400 }
    );
  }

  try {
    if (corpusGameId) {
      const result = await fetchFullTranscriptByCorpusGameId(corpusGameId);
      if (result === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json(result);
    }
    if (operationalGameId) {
      const result = await fetchFullTranscriptByOperationalGameId(operationalGameId);
      if (result === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json(result);
    }
    const results = await fetchFullTranscriptsByBenchmarkRunId(benchmarkRunId as string);
    if (results === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[benchmark/export-transcript] read failed: ${message}`);
    return NextResponse.json({ error: "export_failed", message }, { status: 502 });
  }
}
