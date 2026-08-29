import { NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { isAdminPlayer } from "@/lib/admin";
import { peekModelCallUsage } from "@/lib/callBudget";
import { questionBudgetDistributionToday } from "@/lib/corpus/gameCorpus";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * V2.7 — operational capacity telemetry: today's Racer/resolve model-call
 * usage against RACER_DAILY_CALL_CEILING / RESOLVE_DAILY_CALL_CEILING, the
 * 70% policy-review trigger, and today's question-budget selection
 * distribution.
 *
 * ADMIN-GATED, NOT MERELY "LOGGED IN". This was briefly public on
 * /api/version and moved here on review: unlike that endpoint's other
 * blocks — which exist so an external field tester can confirm DEPLOYMENT
 * CONFIGURATION before spending a game — this is aggregate business/capacity
 * data. It reveals roughly how many games Barkóba plays per day and how
 * close it is to its global spend ceiling, which any registered account
 * could otherwise read; "authenticated" alone is not a strong enough gate
 * for that.
 *
 * isAdminPlayer() — a distinct, env-var-configured allowlist (see
 * lib/admin.ts) — is the check, NOT accounts.unlimited_play. That grant is
 * entitlement exemption ("may play free forever") and a different privilege
 * entirely; conflating the two would mean a future unlimited-play grant
 * silently also grants operational-data access, and revoking one would
 * require touching a table whose actual job is something else.
 *
 * SAFE, EVEN SO, IF THE GATE EVER FAILED OPEN: aggregate counts only, and
 * nothing about any individual game or player — question_budget_distribution_today
 * is a GROUP BY over corpus.games.max_questions and nothing else.
 */
export async function GET(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  const authorized = context.kind === "account" && isAdminPlayer(context.playerId);
  if (!authorized) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: PRIVATE_NO_STORE });
  }

  const [racerCalls, resolveCalls, budgetDistribution] = await Promise.all([
    peekModelCallUsage("racer"),
    peekModelCallUsage("resolve"),
    questionBudgetDistributionToday(),
  ]);

  return NextResponse.json(
    {
      racer_calls_today: {
        used: racerCalls.used,
        ceiling: racerCalls.ceiling,
        utilization: racerCalls.utilization,
        // Informational only, per V2.7's own instruction: sustained 70%
        // utilization is when capacity POLICY gets revisited, not when
        // anything here restricts play. No 20/35Q cap is introduced by this
        // route or anywhere else.
        review_trigger: racerCalls.utilization >= 0.7,
      },
      resolve_calls_today: {
        used: resolveCalls.used,
        ceiling: resolveCalls.ceiling,
        utilization: resolveCalls.utilization,
      },
      question_budget_distribution_today: budgetDistribution,
      served_at: new Date().toISOString(),
    },
    { headers: PRIVATE_NO_STORE }
  );
}
