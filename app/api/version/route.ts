import { NextResponse } from "next/server";
import { getAppVersion } from "@/lib/appVersion";
import { corpusConfigStatus } from "@/lib/corpus/db";
import { entitlementStatus } from "@/lib/entitlements";
import { isProviderAvailable } from "@/lib/providers";
import { env, siteUrlStatus } from "@/lib/env";

// Deployment identity as JSON. Reads lib/appVersion.ts — the same source the
// on-screen badge uses, so the two cannot disagree.
//
// `commit` is ground truth: injected by Vercel from the actual pushed commit,
// so it cannot go stale. `version` is the human tag. If they ever imply
// different things, believe the commit.

export const dynamic = "force-dynamic";

export async function GET() {
  const v = getAppVersion();
  const corpus = corpusConfigStatus();
  const entitlement = entitlementStatus();

  return NextResponse.json({
    version: v.version,
    package_version: v.packageVersion,
    commit: v.commit,
    commit_short: v.commitShort,
    branch: v.branch,
    environment: v.environment,
    deployment_id: v.deploymentId,
    // Whether THIS runtime will record games — and if not, why.
    //
    // 2.2.0.0: no way to answer "is the corpus on?" without inspecting Redis
    //          and hunting function logs.
    // 2.2.0.1: answered that, but only checked PRESENCE of DATABASE_URL, so a
    //          string the driver rejects still reported "ready".
    // 2.2.0.2: reports validity, the specific shape fault, and the host and
    //          database the runtime would actually write to — so a deployment
    //          pointed at the wrong Neon branch is visible before a game is
    //          played rather than after the rows fail to appear.
    //
    // SAFE TO SERVE PUBLICLY: host and database name only. No username, no
    // password, no query parameters, no part of the raw string. The problem
    // field names a SHAPE ("wrapped_in_quotes"), never content.
    corpus: {
      configured: corpus.configured,
      enabled: corpus.enabled,
      database_url_present: corpus.databaseUrlPresent,
      database_url_valid: corpus.databaseUrlValid,
      database_url_problem: corpus.databaseUrlProblem,
      host: corpus.host,
      database: corpus.database,
      reason: corpus.reason,
    },
    // V2.4.1 — is the Play Credit gate actually enforcing in THIS runtime?
    //
    // `enforced` is a conjunction of the flag and the store, so both halves are
    // reported: a bare false cannot say which one failed, and they have
    // different fixes. `complimentary_grant` is here because a gate that is on
    // with nothing behind it blocks every player and was otherwise invisible.
    //
    // CONFIGURATION ONLY — no player id, no balance, no ledger content, no
    // connection string. Entitlement has no credential of its own; it reuses
    // the corpus client, so there is nothing here to redact.
    entitlements: {
      enforced: entitlement.enforced,
      flag_enabled: entitlement.flagEnabled,
      store_ready: entitlement.storeReady,
      complimentary_grant: entitlement.complimentaryGrant,
      reason: entitlement.reason,
    },
    // V2.5 — WHICH MODEL FILLS THE RACER SEAT IN THIS RUNTIME.
    //
    // Same reasoning as the corpus and entitlement blocks above: the model is
    // chosen by an environment variable, environment changes do not reach a
    // running deployment, and until now there was no way to answer "is
    // production actually racing the model I think it is?" without playing a
    // game and reading the corpus afterwards. For a field test that is the
    // wrong order — you want to confirm the configuration BEFORE spending the
    // game, not diagnose it after.
    //
    // SAFE TO SERVE PUBLICLY: vendor model names and a boolean. No key, no
    // fragment of one, nothing per-player. `xai_available` is the same
    // predicate game creation refuses on, so a false here explains a refused
    // Grok game exactly.
    //
    // NOT AUTHORITATIVE FOR EVIDENCE. This is the CONFIGURATION now; the record
    // of what actually played is corpus.game_turns.model_id, written per turn.
    // If the two ever disagree, believe the turn.
    racer: {
      anthropic_model: env.modelRacer(),
      xai_available: isProviderAvailable("xai"),
      xai_model: env.xaiModelRacer(),
      xai_max_tokens: env.xaiMaxTokensRacer(),
      // V2.8.7 — the public Racer. `openai_available` is the same predicate
      // game creation refuses on, so a false here explains a refused public
      // game exactly. Vendor model names, an effort word and a number: no key.
      openai_available: isProviderAvailable("openai"),
      openai_model: env.openaiModelRacer(),
      openai_reasoning_effort: env.openaiReasoningEffortRacer(),
      openai_max_output_tokens: env.openaiMaxOutputTokensRacer(),
    },
    // V2.8.7 — which model and effort adjudicate (Adjudicator + Integrity
    // Review). Configuration only; the record of what actually judged is
    // corpus.turn_operations.model_id per call.
    adjudication: {
      anthropic_model: env.modelAdjudication(),
      effort: env.effortAdjudication(),
    },
    // V2.7.0.18 — WHICH origin outbound emails (verification, recovery) send
    // players' browsers to, and WHY. `source` matters as much as `url`: a
    // browser that completes email-link verification on a different host
    // than the one it's later browsed on never sees the account-session
    // cookie that verification just issued — ACCOUNT_SESSION_COOKIE is
    // deliberately host-only (see lib/accountSession.ts), so this is not a
    // hardening detail, it is the exact mechanism a "session cookie" report
    // traced back to. SAFE TO SERVE PUBLICLY: a public origin, not a secret
    // — the same value already leaves the server in every verification email.
    site: {
      url: siteUrlStatus().url,
      source: siteUrlStatus().source,
    },
    // V2.7 — capacity telemetry (daily call usage, budget distribution) is
    // deliberately NOT here. Unlike every block above — which exists so an
    // external field tester can confirm DEPLOYMENT CONFIGURATION before
    // spending a game — daily call volume and its proximity to the global
    // spend ceiling is operational/business data: it reveals rough scale and
    // would let anyone time a push toward RACER_DAILY_CALL_CEILING. No
    // concrete reason for public access, so it lives behind an admin-gated
    // surface instead — see app/api/admin/capacity/route.ts.
    served_at: new Date().toISOString(),
  });
}
