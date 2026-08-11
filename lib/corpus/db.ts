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
  /**
   * Submit an array of queries as a single non-interactive Postgres
   * transaction. Non-interactive means the array is static: no value returned
   * by one statement can be fed into the next. Statements execute in array
   * order on one session, so each sees the effects of those before it.
   */
  transaction(queries: Promise<Record<string, unknown>[]>[]): Promise<unknown>;
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
  /** Configured, valid and switched on. Writes will be attempted. */
  | "ready"
  /** No DATABASE_URL in this runtime. */
  | "no_database_url"
  /** DATABASE_URL is present but the driver cannot use it. See `databaseUrlProblem`. */
  | "invalid_database_url"
  /** CORPUS_ENABLED is not set at all. This is the intended default. */
  | "flag_unset"
  /** CORPUS_ENABLED is set but does not read as true — a typo or stray quote. */
  | "flag_not_enabled";

/**
 * What is wrong with the connection string, described by SHAPE only.
 *
 * Every value here is a category, never content. That is what makes it safe to
 * serve from a public endpoint: it says "there are quotes around it" without
 * ever saying what is inside them.
 */
export type DatabaseUrlProblem =
  | "wrapped_in_quotes"
  | "psql_prefix"
  | "unsupported_scheme"
  | "missing_username"
  | "missing_hostname"
  | "missing_database"
  | "unparseable";

export interface CorpusConfigStatus {
  configured: boolean;
  databaseUrlPresent: boolean;
  /** Does the driver accept this string? Presence is not validity — see below. */
  databaseUrlValid: boolean;
  databaseUrlProblem: DatabaseUrlProblem | null;
  /** Host only. No credentials. Enough to tell one Neon branch from another. */
  host: string | null;
  /** Database name only, e.g. "neondb". */
  database: string | null;
  enabled: boolean;
  reason: CorpusConfigReason;
}

interface ParsedDatabaseUrl {
  valid: boolean;
  problem: DatabaseUrlProblem | null;
  host: string | null;
  database: string | null;
}

/**
 * Validate a Postgres connection string the way `neon()` does, and extract the
 * two fields that are safe to publish.
 *
 * WHY THIS EXISTS: on 2.2.0.1 `/api/version` reported `reason: "ready"` while
 * every write failed, because the check was `Boolean(process.env.DATABASE_URL)`
 * — presence, not validity. `neon()` throws on a string wrapped in quotes, on a
 * `psql '...'` dashboard copy, and on a missing username. A diagnostic that
 * cannot distinguish "set" from "usable" answers the wrong question.
 *
 * DELIBERATELY STRICT, unlike the CORPUS_ENABLED flag. A boolean has exactly
 * two meanings and guessing is safe; a connection string points at a database,
 * and silently rewriting one could point it somewhere the operator did not
 * intend. So this reports the precise shape problem and changes nothing.
 *
 * WHAT IS NEVER RETURNED: username, password, query parameters, or any part of
 * the raw string. Host and database name only.
 */
export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl {
  const bad = (problem: DatabaseUrlProblem): ParsedDatabaseUrl => ({
    valid: false,
    problem,
    host: null,
    database: null,
  });

  const trimmed = raw.trim();

  // Checked before URL parsing so the report names the actual mistake rather
  // than the generic "unparseable" it would otherwise collapse into.
  if (/^psql\s/i.test(trimmed)) return bad("psql_prefix");
  if (/^["'].*["']$/s.test(trimmed)) return bad("wrapped_in_quotes");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return bad("unparseable");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return bad("unsupported_scheme");
  }
  if (!url.username) return bad("missing_username");
  if (!url.hostname) return bad("missing_hostname");

  const database = url.pathname.replace(/^\//, "");
  if (!database) return bad("missing_database");

  return { valid: true, problem: null, host: url.hostname, database };
}

/**
 * Why corpus persistence is, or is not, active in THIS runtime.
 *
 * Reports booleans, a reason code, and the host/database the runtime would
 * actually write to. The last two exist so a live deployment can be compared
 * against the branch the migration was applied to — a mismatch that is
 * otherwise invisible until the rows fail to appear.
 */
export function corpusConfigStatus(): CorpusConfigStatus {
  const raw = env.databaseUrl();
  const databaseUrlPresent = Boolean(raw);
  const parsed = raw
    ? parseDatabaseUrl(raw)
    : { valid: false, problem: null, host: null, database: null };

  const enabled = env.corpusEnabled();
  const flagIsSet = env.corpusEnabledIsSet();

  let reason: CorpusConfigReason = "ready";
  if (!databaseUrlPresent) reason = "no_database_url";
  else if (!parsed.valid) reason = "invalid_database_url";
  else if (!enabled) reason = flagIsSet ? "flag_not_enabled" : "flag_unset";

  return {
    configured: databaseUrlPresent && parsed.valid && enabled,
    databaseUrlPresent,
    databaseUrlValid: parsed.valid,
    databaseUrlProblem: parsed.problem,
    host: parsed.host,
    database: parsed.database,
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
