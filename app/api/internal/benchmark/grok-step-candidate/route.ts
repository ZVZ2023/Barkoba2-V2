import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  startGrokFixtureCandidate,
  stepGrokFixtureCandidate,
} from "@/scripts/runGrokStepCandidate";
import { GrokStepError, type GrokFixtureKey } from "@/scripts/runGrokStep";

// ---------------------------------------------------------------------------
// V2.8.x — candidate-validation-gate turn-by-turn driver, HTTP surface.
//
// SIBLING of app/api/internal/benchmark/grok-step/route.ts, not a variant of
// it — same auth model, same Preview-only gate, same maxDuration, but wired
// to scripts/runGrokStepCandidate.ts so the control route (and the frozen
// discovery-batch evidence it produced) is never touched by this file.
//
// Only the 5 frozen regression fixtures are valid here — see
// docs/v2.8-grok-baseline/candidate-validation-gate-spec.md Phase 4. The
// other 7 discovery keys remain in GrokFixtureKey (imported from
// runGrokStep.ts, so fixture identity can never drift between the control
// and candidate paths) but are refused by VALID_FIXTURES below: this
// experiment is scoped to the regression set only, not a second full
// 10-game candidate batch.
// ---------------------------------------------------------------------------

export const maxDuration = 300;

const START_CONFIRM = "run-grok-step-candidate-start";
const CONTINUE_CONFIRM = "run-grok-step-candidate-continue";
const VALID_FIXTURES: GrokFixtureKey[] = [
  "disc-02-guitar",
  "disc-06-golden-gate-bridge",
  "disc-08-chess",
  "disc-05-platypus",
  "d2-grok",
];

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
      const status = await startGrokFixtureCandidate(fixture as GrokFixtureKey);
      return NextResponse.json(status);
    }

    if (b.confirm === CONTINUE_CONFIRM && Object.keys(b).length === 3 && typeof b.gameId === "string") {
      const status = await stepGrokFixtureCandidate(fixture as GrokFixtureKey, b.gameId);
      return NextResponse.json(status);
    }

    return badRequest(
      'expected either {"confirm":"run-grok-step-candidate-start","fixture":"..."} or {"confirm":"run-grok-step-candidate-continue","fixture":"...","gameId":"..."}'
    );
  } catch (err) {
    const message = err instanceof GrokStepError || err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[benchmark/grok-step-candidate] failed: ${message}`);
    return NextResponse.json({ error: "grok_step_candidate_failed", message }, { status: 502 });
  }
}
