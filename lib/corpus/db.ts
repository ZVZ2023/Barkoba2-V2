import { neon } from "@neondatabase/serverless";
import { env } from "../env";

// ---------------------------------------------------------------------------
// V2.2 — the Neon/PostgreSQL connection seam.
//
// Deliberately shaped like lib/kv.ts: one narrow interface, one memoized
// client, one "is this even configured?" predicate. Route handlers never see a
// driver, exactly as they never see a Redis client.
//
// THIS MODULE MUST NEVER IMPORT secretStore, gameStore, OR ANY GAME LOGIC.
// It is listed in QUARANTINED in scripts/check-isolation.mjs, so that is
// mechanically enforced rather than promised here.
//
// WHY @neondatabase/serverless RATHER THAN pg: this runs on Vercel's serverless
// functions, where a pooled TCP driver needs PgBouncer in front of it or it
// exhausts connections under ordinary concurrency. The Neon driver speaks
// SQL over HTTP, which makes each call stateless — the same property that makes
// Upstash-over-REST work for Redis here.
// ---------------------------------------------------------------------------

export type SqlValue = string | number | boolean | null | Date | number[] | object;

/**
 * The whole database surface the application uses. A tagged-template function,
 * nothing more. Narrow on purpose: it is what makes the in-memory fake in
 * test/ possible without pulling a real driver into the test run.
 */
export interface SqlClient {
  (strings: TemplateStringsArray, ...values: SqlValue[]): Promise<Record<string, unknown>[]>;
}

/**
 * WHY THIS EXISTS: on 2.2.0.0 the corpus wrote nothing in production and there
 * was no way to tell why. `isCorpusConfigured()` returned a bare boolean, the
 * skip path logged nothing, and "switched off", "misconfigured" and "never
 * called" were indistinguishable from outside the process. Diagnosis needed a
 * Redis inspection and a log hunt to answer a yes/no question.
 *
 * A reason code costs nothing and makes the state observable — see
 * /api/version, which reports it without ever exposing the connection string.
 */
export type CorpusConfigReason =
  /** Configured and switched on. Writes will be attempted. */
  | "ready"
  /** No DATABASE_URL in this runtime. */
  | "no_database_url"
  /** CORPUS_ENABLED is not set at all. This is the intended default. */
  | "flag_unset"
  /** CORPUS_ENABLED is set but does not read as true — a typo or stray quote. */
  | "flag_not_enabled";

export interface CorpusConfigStatus {
  configured: boolean;
  databaseUrlPresent: boolean;
  enabled: boolean;
  reason: CorpusConfigReason;
}

/**
 * Why corpus persistence is, or is not, active in THIS runtime.
 *
 * Deliberately reports only booleans and a reason code. The connection string
 * and the raw flag value never leave the process.
 */
export function corpusConfigStatus(): CorpusConfigStatus {
  const databaseUrlPresent = Boolean(env.databaseUrl());
  const enabled = env.corpusEnabled();
  const flagIsSet = env.corpusEnabledIsSet();

  let reason: CorpusConfigReason = "ready";
  if (!databaseUrlPresent) reason = "no_database_url";
  else if (!enabled) reason = flagIsSet ? "flag_not_enabled" : "flag_unset";

  return {
    configured: databaseUrlPresent && enabled,
    databaseUrlPresent,
    enabled,
    reason,
  };
}

/**
 * Is durable corpus persistence both configured AND switched on?
 *
 * Two conditions, not one. A configured DATABASE_URL with CORPUS_ENABLED unset
 * writes nothing — that is the deployment order the milestone depends on:
 * migrate, deploy, verify, and only then switch writes on.
 */
export function isCorpusConfigured(): boolean {
  return corpusConfigStatus().configured;
}

let cached: SqlClient | null = null;

/** Null when corpus persistence is unconfigured or disabled. Callers must handle null. */
export function getSql(): SqlClient | null {
  if (!isCorpusConfigured()) return null;
  if (cached) return cached;

  const url = env.databaseUrl();
  if (!url) return null;

  cached = neon(url) as unknown as SqlClient;
  return cached;
}

/** Test seam. Not used by any production path. */
export function __setSqlClientForTests(client: SqlClient | null): void {
  cached = client;
}
