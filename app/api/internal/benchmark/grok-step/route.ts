import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { startGrokFixture, stepGrokFixture, GrokStepError, type GrokFixtureKey } from "@/scripts/runGrokStep";

// ---------------------------------------------------------------------------
// TEMPORARY — V2.8.x Grok turn-by-turn driver. Advances exactly ONE turn per
// call — mirrors production's own app/api/game/[id]/turn/route.ts shape —
// so a full game never needs to fit inside one Vercel function invocation.
// See scripts/runGrokStep.ts's own header comment for why this exists (Grok
// reasoning latency exceeds the 300s maxDuration a whole-game-per-request
// runner assumed, confirmed by a real FUNCTION_INVOCATION_TIMEOUT).
//
// AUTH MODEL, SAME SHAPE AS THE OTHER internal/benchmark ROUTES:
//   1. Preview-only. Refuses (404) unless VERCEL_ENV === "preview".
//   2. Exact confirmation body. Two actions, two distinct confirmation
//      strings so neither can be triggered by the other's body:
//        {"confirm":"run-grok-step-start","fixture":"d1-grok"|"d2-grok"}
//        {"confirm":"run-grok-step-continue","fixture":"...","gameId":"..."}
//   3. BENCHMARK_INGRESS_SECRET is a readiness gate only.
//   4. POST-only.
// ---------------------------------------------------------------------------

export const maxDuration = 60;

const START_CONFIRM = "run-grok-step-start";
const CONTINUE_CONFIRM = "run-grok-step-continue";
const VALID_FIXTURES: GrokFixtureKey[] = ["d1-grok", "d2-grok"];

function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: "bad_request", message }, { status: 400 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.VERCEL_ENV !== "preview") {
    return notFound();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON body");
  }

  if (typeof body !== "object" || body === null) {
    return badRequest("body must be an object");
  }
  const b = body as Record<string, unknown>;

  const fixture = b.fixture;
  if (typeof fixture !== "string" || !VALID_FIXTURES.includes(fixture as GrokFixtureKey)) {
    return badRequest(`fixture must be one of: ${VALID_FIXTURES.join(", ")}`);
  }

  if (!env.benchmarkIngressSecret()) {
    return NextResponse.json({ error: "benchmark_secret_not_configured" }, { status: 500 });
  }
  if (!env.xaiApiKey()) {
    return NextResponse.json(
      { error: "xai_key_not_configured", message: "XAI_API_KEY is not set in this Preview deployment's environment." },
      { status: 500 }
    );
  }

  try {
    if (b.confirm === START_CONFIRM && Object.keys(b).length === 2) {
      const status = await startGrokFixture(fixture as GrokFixtureKey);
      return NextResponse.json(status);
    }

    if (b.confirm === CONTINUE_CONFIRM && Object.keys(b).length === 3 && typeof b.gameId === "string") {
      const status = await stepGrokFixture(fixture as GrokFixtureKey, b.gameId);
      return NextResponse.json(status);
    }

    return badRequest(
      'expected either {"confirm":"run-grok-step-start","fixture":"..."} or {"confirm":"run-grok-step-continue","fixture":"...","gameId":"..."}'
    );
  } catch (err) {
    const message = err instanceof GrokStepError || err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[benchmark/grok-step] failed: ${message}`);
    return NextResponse.json({ error: "grok_step_failed", message }, { status: 502 });
  }
}
