import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { corpusConfigStatus } from "../lib/corpus/db";
import {
  recordGameState,
  hasPreservableEvidence,
  __resetCorpusWarnings,
} from "../lib/corpus/gameCorpus";
import type { GameRecord, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// Regression cover for the 2.2.0.0 production incident.
//
// WHAT HAPPENED: a genuine 9-question game produced zero corpus rows. No error,
// no log, no replay entry — because the config gate returned a bare `false` and
// the skip path was silent. Diagnosing it required a Redis inspection and a log
// hunt to answer what should have been a single question: is the corpus on?
//
// TWO DEFECTS, TESTED SEPARATELY:
//
//   1. `CORPUS_ENABLED === "true"` was strict, so "True", "true " or a value
//      that kept its quotes all silently meant OFF.
//   2. Being off was unobservable from outside the process.
// ---------------------------------------------------------------------------

/**
 * A structurally valid connection string. Must have a username: since 2.2.0.2
 * the config check validates the URL rather than merely detecting it, so
 * "postgresql://x/y" is now correctly reported as invalid and would mask the
 * flag behaviour these tests are about.
 */
const VALID_URL = "postgresql://u:p@db.example.tld/neondb";

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

// --- defect 1: the flag parse was too strict --------------------------------

const ACCEPTED = ["true", "TRUE", "True", " true ", '"true"', "'true'", "1", "yes", "on", "  TRUE\n"];

for (const value of ACCEPTED) {
  test(`CORPUS_ENABLED=${JSON.stringify(value)} enables the corpus`, () => {
    process.env.DATABASE_URL = VALID_URL;
    process.env.CORPUS_ENABLED = value;
    const s = corpusConfigStatus();
    assert.equal(s.enabled, true, `${JSON.stringify(value)} should read as true`);
    assert.equal(s.configured, true);
    assert.equal(s.reason, "ready");
  });
}

const REJECTED = ["false", "no", "0", "off", "", "   ", "enabled", "truthy"];

for (const value of REJECTED) {
  test(`CORPUS_ENABLED=${JSON.stringify(value)} does NOT enable the corpus`, () => {
    process.env.DATABASE_URL = VALID_URL;
    process.env.CORPUS_ENABLED = value;
    assert.equal(corpusConfigStatus().enabled, false);
  });
}

// --- defect 2: the state must be observable ---------------------------------

test("reason distinguishes a missing DATABASE_URL", () => {
  process.env.CORPUS_ENABLED = "true";
  const s = corpusConfigStatus();
  assert.equal(s.configured, false);
  assert.equal(s.databaseUrlPresent, false);
  assert.equal(s.reason, "no_database_url");
});

test("reason distinguishes an unset flag from a wrong one", () => {
  process.env.DATABASE_URL = VALID_URL;

  // Unset — the shipped default, not a mistake.
  assert.equal(corpusConfigStatus().reason, "flag_unset");

  // Set but unrecognised — a typo, and a different problem entirely.
  process.env.CORPUS_ENABLED = "ture";
  assert.equal(corpusConfigStatus().reason, "flag_not_enabled");
});

test("the fully configured case reports ready", () => {
  process.env.DATABASE_URL = VALID_URL;
  process.env.CORPUS_ENABLED = "true";
  assert.deepEqual(corpusConfigStatus(), {
    configured: true,
    databaseUrlPresent: true,
    databaseUrlValid: true,
    databaseUrlProblem: null,
    host: "db.example.tld",
    database: "neondb",
    enabled: true,
    reason: "ready",
  });
});

test("status never exposes the connection string or the raw flag", () => {
  process.env.DATABASE_URL = "postgresql://user:SECRET@host/db";
  process.env.CORPUS_ENABLED = "true";
  const serialized = JSON.stringify(corpusConfigStatus());
  assert.doesNotMatch(serialized, /SECRET/);
  assert.doesNotMatch(serialized, /postgresql/);
});

// --- the silent-skip path now speaks ----------------------------------------

function entry(overrides: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(),
    turn_index: 1,
    turn_type: "question",
    racer_output_raw: "",
    question_text: "Fizikai tárgy?",
    guess_text: null,
    composer_response: "YES",
    ambiguous_explanation: null,
    guess_detector_flagged: false,
    guess_detector_method: null,
    guess_intent_outcome: null,
    clue_text: null,
    original_question_text: null,
    edit_status: null,
    edit_reason: null,
    ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(),
    quality_score: null,
    information_gain: null,
    strategy_classification: null,
    integrity_flag: null,
    confidence: null,
    latency_ms: null,
    ...overrides,
  };
}

function game(qa: QuestionLogEntry[]): GameRecord {
  return {
    game_id: randomUUID(),
    player_id: null,
    phase: "questioning",
    created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(),
    max_questions: 20,
    game_language: "hu",
    private_target: false,
    composer_kind: "ai",
    racer_kind: "human",
    difficulty: "easy",
    clue_mode: "none",
    question_count: qa.length,
    ambiguous_count: 0,
    qa_log: qa,
    final_action: null,
    final_guess_text: null,
    result: null,
    integrity_notes: null,
    integrity_flagged_turns: null,
    adjudication_notes: null,
    adjudicator_verdict: null,
    integrity_verdict: null,
    adjudication_confidence: null,
    revealed_target: null,
    revealed_definition: null,
    revealed_granularity: null,
    revealed_modifiers: null,
    revealed_locked_at: null,
    corrections: [],
    abandoned_branches: [],
    clarification_prompt: null,
  };
}

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  return { lines, restore: () => void (console.warn = original) };
}

test("a QUALIFYING game skipped by the gate now logs why", async () => {
  process.env.DATABASE_URL = VALID_URL;
  process.env.CORPUS_ENABLED = "ture"; // the exact class of typo that hid the bug

  const nineQuestions = [...Array(9)].map((_, i) => entry({ turn_index: i + 1 }));
  const g = game(nineQuestions);
  assert.equal(hasPreservableEvidence(g), true, "9 answered questions must qualify");

  const cap = captureWarnings();
  const outcome = await recordGameState(g);
  cap.restore();

  assert.equal(outcome, "disabled");
  assert.equal(cap.lines.length, 1, "exactly one warning");
  assert.match(cap.lines[0]!, /CORPUS DISABLED/);
  assert.match(cap.lines[0]!, /reason=flag_not_enabled/);
  assert.match(cap.lines[0]!, /NOT recorded/);
});

test("the warning fires once per runtime, not once per turn", async () => {
  process.env.DATABASE_URL = VALID_URL;
  process.env.CORPUS_ENABLED = "false";

  const cap = captureWarnings();
  for (let i = 0; i < 5; i += 1) await recordGameState(game([entry()]));
  cap.restore();

  assert.equal(cap.lines.length, 1, "a 20-question game must not print this 20 times");
});

test("a NON-qualifying game stays silent — nothing was lost", async () => {
  process.env.DATABASE_URL = VALID_URL;
  process.env.CORPUS_ENABLED = "false";

  const cap = captureWarnings();
  const outcome = await recordGameState(game([entry({ composer_response: null })]));
  cap.restore();

  assert.equal(outcome, "disabled");
  assert.equal(cap.lines.length, 0, "no evidence existed, so there is nothing to warn about");
});

test("the intended default — flag unset — still warns when evidence is dropped", async () => {
  process.env.DATABASE_URL = VALID_URL;

  const cap = captureWarnings();
  await recordGameState(game([entry()]));
  cap.restore();

  assert.equal(cap.lines.length, 1);
  assert.match(cap.lines[0]!, /reason=flag_unset/);
  assert.match(cap.lines[0]!, /set it to 'true'/);
});
