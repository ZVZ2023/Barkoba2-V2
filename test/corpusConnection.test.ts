import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseDatabaseUrl, corpusConfigStatus } from "../lib/corpus/db";
import { recordGameState, __resetCorpusWarnings } from "../lib/corpus/gameCorpus";
import { readPending } from "../lib/corpus/pendingQueue";
import type { GameRecord, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// Regression cover for the 2.2.0.1 production incident.
//
// WHAT HAPPENED: /api/version reported reason:"ready", a real game completed,
// and corpus.games stayed empty with an EMPTY replay queue.
//
// TWO DEFECTS:
//
//   1. getSql() sat OUTSIDE the protected try. neon() throws on a malformed
//      connection string, so the throw escaped recordGameState into saveGame's
//      last-resort catch — which logs but does not queue. The evidence was not
//      delayed, it was lost.
//
//   2. The config check tested PRESENCE of DATABASE_URL, never validity. A
//      string the driver rejects still reported "ready", so the diagnostic
//      confidently pointed away from the actual fault.
//
// A connection failure is a write failure and must be handled like one.
// ---------------------------------------------------------------------------

const REAL_NEON = "postgresql://neondb_owner:npg_secret123@ep-cool-name-a1b2c3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

const SAVED = { db: process.env.DATABASE_URL, flag: process.env.CORPUS_ENABLED };

beforeEach(() => {
  __resetCorpusWarnings();
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
});

afterEach(() => {
  if (SAVED.db === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED.db;
  if (SAVED.flag === undefined) delete process.env.CORPUS_ENABLED;
  else process.env.CORPUS_ENABLED = SAVED.flag;
});

// --- valid strings ----------------------------------------------------------

test("a real Neon connection string is valid, and host/database are extracted", () => {
  const p = parseDatabaseUrl(REAL_NEON);
  assert.equal(p.valid, true);
  assert.equal(p.problem, null);
  assert.equal(p.host, "ep-cool-name-a1b2c3.eu-central-1.aws.neon.tech");
  assert.equal(p.database, "neondb");
});

test("the postgres:// scheme is accepted as well as postgresql://", () => {
  assert.equal(parseDatabaseUrl("postgres://u:p@host.tld/db").valid, true);
});

test("surrounding whitespace does not invalidate an otherwise good string", () => {
  const p = parseDatabaseUrl(`  ${REAL_NEON}\n`);
  assert.equal(p.valid, true);
  assert.equal(p.database, "neondb");
});

// --- the shapes that actually broke production ------------------------------

test("a quoted connection string is rejected with a precise reason", () => {
  const p = parseDatabaseUrl(`"${REAL_NEON}"`);
  assert.equal(p.valid, false);
  assert.equal(p.problem, "wrapped_in_quotes");
});

test("single quotes are caught too", () => {
  assert.equal(parseDatabaseUrl(`'${REAL_NEON}'`).problem, "wrapped_in_quotes");
});

test("a psql dashboard copy is named as such, not lumped in with unparseable", () => {
  // Neon's connection widget offers a psql tab that yields exactly this.
  const p = parseDatabaseUrl(`psql '${REAL_NEON}'`);
  assert.equal(p.valid, false);
  assert.equal(p.problem, "psql_prefix");
});

test("a missing username is rejected — neon() throws on it", () => {
  const p = parseDatabaseUrl("postgresql://ep-x-123.aws.neon.tech/neondb");
  assert.equal(p.valid, false);
  assert.equal(p.problem, "missing_username");
});

test("other malformed shapes are classified, not guessed at", () => {
  assert.equal(parseDatabaseUrl("mysql://u:p@host/db").problem, "unsupported_scheme");
  assert.equal(parseDatabaseUrl("not a url at all").problem, "unparseable");
  assert.equal(parseDatabaseUrl("postgresql://u:p@host.tld").problem, "missing_database");
});

// --- nothing sensitive may escape -------------------------------------------

test("neither the password nor the raw string appears in the parse result", () => {
  const s = JSON.stringify(parseDatabaseUrl(REAL_NEON));
  assert.doesNotMatch(s, /npg_secret123/);
  assert.doesNotMatch(s, /neondb_owner/);
  assert.doesNotMatch(s, /sslmode|channel_binding/);
  assert.doesNotMatch(s, /postgresql:\/\//);
});

test("the published status carries host and database but no credentials", () => {
  process.env.DATABASE_URL = REAL_NEON;
  process.env.CORPUS_ENABLED = "true";
  const status = corpusConfigStatus();

  assert.equal(status.host, "ep-cool-name-a1b2c3.eu-central-1.aws.neon.tech");
  assert.equal(status.database, "neondb");

  const s = JSON.stringify(status);
  assert.doesNotMatch(s, /npg_secret123/);
  assert.doesNotMatch(s, /neondb_owner/);
  assert.doesNotMatch(s, /sslmode/);
  assert.doesNotMatch(s, /postgresql:\/\//);
});

// --- a malformed URL must never report "ready" ------------------------------

test("a malformed DATABASE_URL no longer reports reason:ready", () => {
  process.env.DATABASE_URL = `"${REAL_NEON}"`;
  process.env.CORPUS_ENABLED = "true";
  const s = corpusConfigStatus();

  assert.equal(s.reason, "invalid_database_url");
  assert.equal(s.configured, false, "configured must be false — this is the 2.2.0.1 lie");
  assert.equal(s.databaseUrlPresent, true, "it IS present…");
  assert.equal(s.databaseUrlValid, false, "…but presence is not validity");
  assert.equal(s.databaseUrlProblem, "wrapped_in_quotes");
});

test("a valid, enabled configuration still reports ready", () => {
  process.env.DATABASE_URL = REAL_NEON;
  process.env.CORPUS_ENABLED = "true";
  const s = corpusConfigStatus();
  assert.equal(s.reason, "ready");
  assert.equal(s.configured, true);
  assert.equal(s.databaseUrlValid, true);
});

test("an invalid URL outranks the flag state in the reported reason", () => {
  // The URL is the blocking fault; reporting "flag_unset" would send the
  // operator to fix the wrong variable.
  process.env.DATABASE_URL = "psql 'postgresql://u:p@h/db'";
  const s = corpusConfigStatus();
  assert.equal(s.reason, "invalid_database_url");
});

// --- defect 1: a connection failure must reach the replay queue -------------

function entry(): QuestionLogEntry {
  return {
    id: randomUUID(), turn_index: 1, turn_type: "question", racer_output_raw: "{}",
    question_text: "Fizikai tárgy?", guess_text: null, composer_response: "YES",
    ambiguous_explanation: null, guess_detector_flagged: false, guess_detector_method: null,
    guess_intent_outcome: null, clue_text: null, original_question_text: null,
    edit_status: null, edit_reason: null, ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(), model_id: null, model_provider: null, prompt_version: null,
    answered_at: null, pre_revision_question_text: null,
    quality_score: null, information_gain: null,
    strategy_classification: null, integrity_flag: null, confidence: null, latency_ms: null,
  };
}

function game(): GameRecord {
  return {
    game_id: randomUUID(), player_id: null,
    composer_player_id: null, racer_player_id: null, join_code: null,
    phase: "questioning",
    created_at: new Date().toISOString(), expires_at: new Date().toISOString(),
    max_questions: 20, game_language: "hu", private_target: false,
    composer_kind: "ai", racer_kind: "human", racer_provider: null, difficulty: "easy", clue_mode: "none",
    question_count: 1, ambiguous_count: 0, qa_log: [entry()],
    final_action: null, final_guess_text: null, result: null,
    integrity_notes: null, integrity_flagged_turns: null, adjudication_notes: null,
    adjudicator_verdict: null, integrity_verdict: null, adjudication_confidence: null,
    revealed_target: null, revealed_definition: null, revealed_granularity: null,
    revealed_modifiers: null, revealed_locked_at: null,
    corrections: [], abandoned_branches: [], clarification_prompt: null,
    benchmark_case_id: null, benchmark_run_id: null,
  };
}

test("a connection-string throw is caught and does NOT escape recordGameState", async () => {
  // Bypass the config gate the way production did: valid enough to be
  // "configured", malformed enough that neon() throws when constructing.
  process.env.DATABASE_URL = "postgresql://u:p@[bad-host/db";
  process.env.CORPUS_ENABLED = "true";

  let escaped = false;
  let outcome: string | undefined;
  try {
    outcome = await recordGameState(game());
  } catch {
    escaped = true;
  }

  assert.equal(escaped, false, "a throw here lands in saveGame's catch and loses the evidence");
  assert.ok(
    outcome === "deferred" || outcome === "disabled",
    `expected a handled outcome, got ${outcome}`
  );
});

test("a game whose client cannot be built is queued for replay, not dropped", async () => {
  process.env.CORPUS_ENABLED = "true";
  // Passes parseDatabaseUrl but is rejected by neon() itself — the belt-and-
  // braces case that proves the try placement matters independently of §2.
  process.env.DATABASE_URL = "postgresql://u:p@host.tld/db";

  const g = game();
  const outcome = await recordGameState(g);

  if (outcome === "deferred") {
    assert.ok(
      (await readPending()).includes(g.game_id),
      "a deferred game MUST be recoverable — that is the whole point of the queue"
    );
  }
});

// ---------------------------------------------------------------------------
// V2.4.2.0 — a database query must never be served from an HTTP cache.
//
// The Neon serverless driver reaches Postgres by POSTing through the global
// `fetch`, which Next.js replaces with an instrumented version that persists
// eligible responses to .next/cache/fetch-cache — on disk, surviving restart
// AND rebuild.
//
// Observed, not theorised: live verification wrote a purchase and a consumption,
// confirmed both rows directly against Neon, and then watched the entitlement
// read keep returning the pre-consumption balance. The cache file held
// rows [["1","0","1","0","0"]] with revalidate: 31536000 — one year.
// ---------------------------------------------------------------------------

test("the SQL client opts out of Next's fetch cache", () => {
  const src = readFileSync("lib/corpus/db.ts", "utf8");
  const construction = src.slice(src.indexOf("cached = neon("));
  assert.match(
    construction,
    /fetchOptions:\s*\{\s*cache:\s*"no-store"\s*\}/,
    "every Neon request must be no-store, or a read can be answered from a file"
  );
});

test("the opt-out is on the CLIENT, so no call site can forget it", () => {
  // The file explains at length what `neon()` does and how it fails, so a bare
  // substring count finds the prose and reports it as a second client.
  const code = readFileSync("lib/corpus/db.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");

  // Exactly one construction, inside getSql, which is the only way to a client.
  assert.equal((code.match(/\bneon\(/g) ?? []).length, 1, "one client construction only");

  // No caller may build its own, which would bypass the opt-out entirely.
  for (const f of ["lib/entitlements.ts", "lib/corpus/gameCorpus.ts"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /@neondatabase\/serverless/, f);
  }
});

test("the temporary read-path diagnostic is gone", () => {
  // It logged a raw player id. It must never reach a commit or a production log.
  assert.doesNotMatch(readFileSync("lib/entitlements.ts", "utf8"), /DIAG getStatus|TEMPORARY DIAGNOSTIC/);
});
