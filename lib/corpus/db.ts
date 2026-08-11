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
 * Is durable corpus persistence both configured AND switched on?
 *
 * Two conditions, not one. A configured DATABASE_URL with CORPUS_ENABLED unset
 * writes nothing — that is the deployment order the milestone depends on:
 * migrate, deploy, verify, and only then switch writes on.
 */
export function isCorpusConfigured(): boolean {
  return Boolean(env.databaseUrl()) && env.corpusEnabled();
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
