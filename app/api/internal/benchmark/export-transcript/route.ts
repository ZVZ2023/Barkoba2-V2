import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  fetchFullTranscriptByCorpusGameId,
  fetchFullTranscriptByOperationalGameId,
  fetchFullTranscriptsByBenchmarkRunId,
  fetchRecentOrdinaryGames,
} from "@/lib/corpus/transcriptExport";

// ---------------------------------------------------------------------------
// TEMPORARY — evidence-preservation utility only, mirroring the pattern
// already used for M4/M1's own export-transcript route (never merged to
// main, added again here for a one-off player-facing evidence pull). Delete
// once this pull is complete.
//
// WHAT THIS IS. lib/corpus/transcriptExport.ts's existing read-only queries,
// exposed over HTTP so a Preview deployment (sharing the same corpus
// database as production, confirmed via /api/version's reported host on
// both) can be used to pull evidence-grade transcripts without a local
// DATABASE_URL, plus one new query (fetchRecentOrdinaryGames) for "most
// recent N non-benchmark human-Composer-vs-AI-Racer games."
//
// READ-ONLY, NO SECRET ACCESS. lib/corpus/transcriptExport.ts is QUARANTINED
// in scripts/check-isolation.mjs (never imports secretStore/gameStore) and
// issues only SELECTs. This route inherits both properties unchanged. It
// makes no model call and cannot mutate a game.
//
// AUTH MODEL (same shape as every other internal/benchmark route):
//   1. Preview-only. Refuses (404) unless process.env.VERCEL_ENV === "preview".
//   2. BENCHMARK_INGRESS_SECRET is a readiness gate only, never compared
//      against anything the caller supplies.
//   3. GET, not POST+confirmation — idempotent, no side effect or cost.
//   4. Exactly one of ?corpusGameId=, ?operationalGameId=, ?benchmarkRunId=,
//      ?recent=<N> is required.
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
  const recent = searchParams.get("recent");

  const given = [corpusGameId, operationalGameId, benchmarkRunId, recent].filter(Boolean).length;
  if (given !== 1) {
    return NextResponse.json(
      {
        error: "bad_request",
        message:
          "exactly one of corpusGameId, operationalGameId, benchmarkRunId, recent query params is required",
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
    if (benchmarkRunId) {
      const results = await fetchFullTranscriptsByBenchmarkRunId(benchmarkRunId);
      if (results === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json(results);
    }
    const limit = Math.max(1, Math.min(20, Number(recent) || 0));
    if (!limit) {
      return NextResponse.json({ error: "bad_request", message: "recent must be a positive integer" }, { status: 400 });
    }
    const results = await fetchRecentOrdinaryGames(limit);
    if (results === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[benchmark/export-transcript] read failed: ${message}`);
    return NextResponse.json({ error: "export_failed", message }, { status: 502 });
  }
}
