import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CONTEST_EVIDENCE_SCHEMA_VERSION,
  CONTEST_STATUS_OPEN,
  buildContestEvidence,
  checkContestEligibility,
  createContest,
  getContestById,
  hasContestableVerdict,
  listOwnContestsForGame,
  normalizePlayerArgument,
  resolveContestSeat,
  type ContestSubject,
} from "../lib/corpus/gameContests";
import { unlinkPlayer } from "../lib/corpus/gameCorpus";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";

// ---------------------------------------------------------------------------
// V2.6 TASK 2 — Contest Verdict foundation.
//
// SCOPE, STATED HONESTLY, exactly as test/corpusPersistence.test.ts states it:
// there is no PostgreSQL in this test environment. These tests verify what the
// application DOES — which statements it issues, what it derives server-side,
// what it refuses — plus static guards that the MIGRATION still carries the
// constraints those behaviours depend on.
//
// They do NOT prove the trigger fires or the unique index holds inside
// PostgreSQL. That needs a live Neon run and is listed as such in the
// completion report. Asserting it here would be claiming evidence this
// environment cannot produce.
// ---------------------------------------------------------------------------

const COMPOSER = "a".repeat(32);
const RACER = "b".repeat(32);
const STRANGER = "c".repeat(32);

const CORPUS_GAME_ID = "11111111-1111-4111-8111-111111111111";
const OPERATIONAL_GAME_ID = "22222222-2222-4222-8222-222222222222";

interface Recorded {
  sql: string;
  values: SqlValue[];
}

let calls: Recorded[] = [];
/** Rows the fake returns, in the order the module asks for them. */
let responses: Record<string, unknown>[][] = [];
let failNext = false;

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const text = strings.join("?");
  calls.push({ sql: text, values });
  if (failNext) return Promise.reject(new Error("neon unavailable"));
  return Promise.resolve(responses.shift() ?? []);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

function gameRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    corpus_game_id: CORPUS_GAME_ID,
    operational_game_id: OPERATIONAL_GAME_ID,
    app_version: "2.5.0.5",
    commit_sha: "637833e",
    composer_kind: "human",
    racer_kind: "ai",
    game_language: "hu",
    max_questions: 20,
    question_count: 18,
    ambiguous_count: 2,
    lifecycle_state: "completed",
    outcome: "racer_incorrect",
    termination_reason: "final_action_guess",
    last_phase: "complete",
    composer_player_id: COMPOSER,
    racer_player_id: null,
    created_at: "2026-08-01T10:00:00.000Z",
    finalized_at: "2026-08-01T10:40:00.000Z",
    ...o,
  };
}

function subject(o: Partial<ContestSubject> = {}): ContestSubject {
  return {
    corpus_game_id: CORPUS_GAME_ID,
    operational_game_id: OPERATIONAL_GAME_ID,
    lifecycle_state: "completed",
    outcome: "racer_incorrect",
    composer_player_id: COMPOSER,
    racer_player_id: RACER,
    ...o,
  };
}

/** The row the INSERT ... RETURNING gives back on a successful create. */
function insertedRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contest_id: randomUUID(),
    corpus_game_id: CORPUS_GAME_ID,
    operational_game_id: OPERATIONAL_GAME_ID,
    player_id: COMPOSER,
    contestant_seat: "composer",
    contested_outcome: "racer_incorrect",
    player_argument: "A döntés téves volt.",
    status: CONTEST_STATUS_OPEN,
    evidence_schema_version: CONTEST_EVIDENCE_SCHEMA_VERSION,
    evidence: { schema_version: CONTEST_EVIDENCE_SCHEMA_VERSION },
    created_at: "2026-08-16T12:00:00.000Z",
    ...o,
  };
}

/**
 * Queue the four evidence reads plus the insert. createContest issues them in a
 * fixed order: subject, then [turns, corrections, resolution, target], then the
 * INSERT.
 */
function queueCreateSequence(o: {
  game?: Record<string, unknown>;
  turns?: Record<string, unknown>[];
  corrections?: Record<string, unknown>[];
  resolution?: Record<string, unknown>[];
  target?: Record<string, unknown>[];
  inserted?: Record<string, unknown>[];
} = {}) {
  responses = [
    [o.game ?? gameRow()],
    o.turns ?? [],
    o.corrections ?? [],
    o.resolution ?? [],
    o.target ?? [],
    o.inserted ?? [insertedRow()],
  ];
}

beforeEach(() => {
  calls = [];
  responses = [];
  failNext = false;
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
});

// ---------------------------------------------------------------------------
// Eligibility — the completed-game rule.
// ---------------------------------------------------------------------------

test("only a completed game carrying a verdict is contestable", () => {
  assert.equal(hasContestableVerdict(subject()), true);

  // Every non-completed lifecycle state. Each means the game stopped WITHOUT
  // producing a verdict, and contesting one would be contesting an absence.
  for (const state of [
    "in_progress",
    "abandoned_inferred",
    "stalled_resolving",
    "expired_unresolved",
  ]) {
    assert.equal(
      hasContestableVerdict(subject({ lifecycle_state: state })),
      false,
      `${state} must not be contestable`
    );
  }
});

test("'completed' without an outcome is not a verdict", () => {
  // Not hypothetical: gameCorpus's completeness invariant documents a real
  // production row marked completed whose resolution never landed. Lifecycle
  // and outcome are orthogonal by schema design, so both are checked.
  assert.equal(hasContestableVerdict(subject({ outcome: null })), false);
});

// ---------------------------------------------------------------------------
// Authorization — the strict durable-seat rule.
// ---------------------------------------------------------------------------

test("a durable seat id matching the caller resolves that seat", () => {
  assert.equal(resolveContestSeat(subject(), COMPOSER), "composer");
  assert.equal(resolveContestSeat(subject(), RACER), "racer");
});

test("an outsider has no seat", () => {
  assert.equal(resolveContestSeat(subject(), STRANGER), null);
});

test("an unauthenticated caller has no seat", () => {
  assert.equal(resolveContestSeat(subject(), null), null);
});

test("V2.6 BOUNDARY: a null seat column is never inferred, however plausible", () => {
  // This is the ratified compatibility boundary and the single most important
  // authorization test in this file. lib/seats.ts resolveSeat() DELIBERATELY
  // falls back here — a human Composer seat with no recorded id belongs to
  // whoever is asking — which is correct for a live single-human game and
  // unsafe for a historical one, where it would hand any authenticated visitor
  // a seat on every game recorded before durable seats existed.
  const preV23 = subject({ composer_player_id: null, racer_player_id: null });
  assert.equal(resolveContestSeat(preV23, COMPOSER), null);
  assert.equal(resolveContestSeat(preV23, STRANGER), null);
  assert.equal(checkContestEligibility(preV23, COMPOSER).error, "not_a_participant");
});

test("only the requesting participant's own seat must be durable", () => {
  // An AI-Racer game has no racer_player_id and never will. That must not stop
  // the human Composer contesting: the rule is about the CALLER's seat, not
  // about reconstructing the whole game's history of identity.
  const aiRacer = subject({ racer_player_id: null });
  assert.equal(resolveContestSeat(aiRacer, COMPOSER), "composer");
  assert.equal(checkContestEligibility(aiRacer, COMPOSER).ok, true);
});

test("eligibility reports the unfinished game before the seat", () => {
  // Order matters for the API: a participant asking about a running game should
  // be told the game is not contestable, not that they are not a participant.
  const running = subject({ lifecycle_state: "in_progress", outcome: null });
  assert.equal(checkContestEligibility(running, COMPOSER).error, "game_not_completed");
});

// ---------------------------------------------------------------------------
// Argument handling.
// ---------------------------------------------------------------------------

test("an empty or non-string argument is refused, not stored", () => {
  for (const bad of ["", "   ", "\n\t", null, undefined, 42, {}, []]) {
    assert.equal(normalizePlayerArgument(bad), null, `should refuse: ${JSON.stringify(bad)}`);
  }
});

test("an argument is preserved verbatim apart from trimming and the cap", () => {
  assert.equal(normalizePlayerArgument("  A cél a fül volt.  "), "A cél a fül volt.");
  const long = "x".repeat(9000);
  assert.equal(normalizePlayerArgument(long)?.length, 4000);
});

// ---------------------------------------------------------------------------
// Creation.
// ---------------------------------------------------------------------------

test("a valid participant creates a contest against an eligible game", async () => {
  queueCreateSequence();
  const r = await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: COMPOSER,
    playerArgument: "A döntés téves volt.",
  });
  assert.equal(r.ok, true);
});

test("the server derives status, schema version, seat and verdict — never the client", async () => {
  queueCreateSequence();
  await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: COMPOSER,
    // A client attempting to assert authoritative fields. They are not read:
    // createContest's signature has nowhere to put them.
    playerArgument: "Vitatom.",
  });

  const insert = calls.find((c) => c.sql.includes("INSERT INTO corpus.game_contests"));
  assert.ok(insert, "an INSERT must have been issued");
  // The bound values, in the order the statement lists them.
  assert.ok(insert.values.includes(CONTEST_STATUS_OPEN), "status is server-set to open");
  assert.ok(
    insert.values.includes(CONTEST_EVIDENCE_SCHEMA_VERSION),
    "evidence_schema_version is server-set"
  );
  assert.ok(insert.values.includes("composer"), "seat is derived from the corpus row");
  assert.ok(insert.values.includes("racer_incorrect"), "the verdict is read from the corpus row");
  assert.ok(insert.values.includes("Vitatom."), "the argument is stored");
});

test("an outsider cannot create a contest", async () => {
  responses = [[gameRow()]];
  const r = await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: STRANGER,
    playerArgument: "Engedj be.",
  });
  assert.deepEqual(r, { ok: false, error: "not_a_participant" });
  assert.equal(
    calls.some((c) => c.sql.includes("INSERT")),
    false,
    "a rejected caller must not reach the write"
  );
});

test("an unauthenticated caller cannot create a contest", async () => {
  responses = [[gameRow()]];
  const r = await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: null,
    playerArgument: "Vitatom.",
  });
  assert.deepEqual(r, { ok: false, error: "not_a_participant" });
});

test("a participant cannot contest an unfinished game", async () => {
  responses = [[gameRow({ lifecycle_state: "in_progress", outcome: null })]];
  const r = await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: COMPOSER,
    playerArgument: "Túl korai.",
  });
  assert.deepEqual(r, { ok: false, error: "game_not_completed" });
  assert.equal(calls.some((c) => c.sql.includes("INSERT")), false);
});

test("an empty argument is refused before any database work", async () => {
  const r = await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: COMPOSER,
    playerArgument: "   ",
  });
  assert.deepEqual(r, { ok: false, error: "invalid_argument" });
  assert.equal(calls.length, 0, "nothing should have been queried");
});

test("a game absent from the corpus is not contestable", async () => {
  responses = [[]];
  const r = await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: COMPOSER,
    playerArgument: "Vitatom.",
  });
  assert.deepEqual(r, { ok: false, error: "game_not_found" });
});

// ---------------------------------------------------------------------------
// Uniqueness.
// ---------------------------------------------------------------------------

test("a second contest from the same seat is reported as a duplicate", async () => {
  // ON CONFLICT DO NOTHING returns no row. That is the duplicate signal, and it
  // is race-free because the unique index decides, not a prior SELECT.
  queueCreateSequence({ inserted: [] });
  const r = await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: COMPOSER,
    playerArgument: "Megint vitatom.",
  });
  assert.deepEqual(r, { ok: false, error: "duplicate_contest" });
});

test("uniqueness is keyed on the SEAT, so the other participant is unaffected", async () => {
  queueCreateSequence({
    game: gameRow({ racer_kind: "human", racer_player_id: RACER }),
    inserted: [insertedRow({ player_id: RACER, contestant_seat: "racer" })],
  });
  const r = await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: RACER,
    playerArgument: "Én is vitatom.",
  });
  assert.equal(r.ok, true);
  const insert = calls.find((c) => c.sql.includes("INSERT INTO corpus.game_contests"));
  assert.ok(insert?.values.includes("racer"));
});

// ---------------------------------------------------------------------------
// Immutability of the original game.
// ---------------------------------------------------------------------------

test("creating a contest issues no write against the original game", async () => {
  queueCreateSequence();
  await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: COMPOSER,
    playerArgument: "Vitatom.",
  });

  // THE CORE INVARIANT, asserted mechanically rather than trusted. A contest is
  // a derived record: the only write it may issue is its own INSERT.
  const writes = calls.filter((c) => /\b(INSERT|UPDATE|DELETE)\b/i.test(c.sql));
  assert.equal(writes.length, 1, `expected exactly one write, got ${writes.length}`);
  assert.ok(writes[0]?.sql.includes("INSERT INTO corpus.game_contests"));

  for (const forbidden of [
    "corpus.games",
    "corpus.game_turns",
    "corpus.game_targets",
    "corpus.game_resolutions",
    "corpus.game_corrections",
  ]) {
    assert.equal(
      calls.some((c) => new RegExp(`(UPDATE|DELETE FROM|INSERT INTO)\\s+${forbidden}`, "i").test(c.sql)),
      false,
      `${forbidden} must never be written by contest creation`
    );
  }
});

test("no player-argument update mechanism exists", () => {
  const module = readFileSync("lib/corpus/gameContests.ts", "utf8");
  // The ONLY UPDATE this module may contain is the privacy unlink, and it may
  // only ever set player_id. If a second UPDATE appears here, contests have
  // stopped being immutable and this test is the place that says so.
  const updates = module.match(/UPDATE\s+corpus\.\w+/gi) ?? [];
  assert.deepEqual(updates.map((u) => u.toLowerCase().replace(/\s+/g, " ")), [
    "update corpus.game_contests",
  ]);
  assert.equal(
    /SET\s+player_argument/i.test(module),
    false,
    "the argument must have no write path after creation"
  );
});

// ---------------------------------------------------------------------------
// The evidence snapshot.
// ---------------------------------------------------------------------------

test("the snapshot captures the authoritative verdict and game identity", () => {
  const e = buildContestEvidence({
    gameRow: gameRow(),
    turnRows: [
      {
        turn_index: 1,
        branch: "main",
        turn_type: "question",
        actor: "ai_racer",
        question_text: "Fizikai tárgy?",
        composer_response: "YES",
        guess_detector_flagged: true,
        guess_intent_outcome: "continue_questioning",
        pre_revision_question_text: "A cél fizikai tárgy?",
        model_id: "grok-4.20-0309-non-reasoning",
        model_provider: "xai",
        prompt_version: "racer/2.5.0",
        occurred_at: "2026-08-01T10:05:00.000Z",
        answered_at: "2026-08-01T10:05:20.000Z",
      },
    ],
    correctionRows: [
      { turn_index: 3, from_answer: "YES", to_answer: "NO", discarded_turns: 2, occurred_at: "x" },
    ],
    resolutionRow: { final_action: "guess", adjudicator_verdict: "incorrect" },
    targetText: "a bal fülem",
    contestantSeat: "composer",
    capturedAt: "2026-08-16T12:00:00.000Z",
  });

  assert.equal(e.schema_version, CONTEST_EVIDENCE_SCHEMA_VERSION);
  assert.equal(e.game.outcome, "racer_incorrect");
  assert.equal(e.game.app_version, "2.5.0.5");
  assert.equal(e.game.operational_game_id, OPERATIONAL_GAME_ID);
  assert.equal(e.turns.length, 1);
  assert.equal(e.turns[0]?.model_provider, "xai");
  assert.equal(e.turns[0]?.guess_intent_outcome, "continue_questioning");
  assert.equal(e.turns[0]?.pre_revision_question_text, "A cél fizikai tárgy?");
  assert.equal(e.corrections.length, 1);
  assert.equal(e.resolution?.adjudicator_verdict, "incorrect");
  assert.equal(e.revealed_target, "a bal fülem");
  assert.equal(e.participants.contestant_seat, "composer");
});

test("the snapshot contains NO player identifiers, only roles and occupancy", () => {
  // The erasure hole this design exists to avoid: if ids were embedded here,
  // unlinking player B would leave B's identifier inside player A's snapshot,
  // out of reach of the sweep, and the V2.6 guarantee would be quietly false.
  const e = buildContestEvidence({
    gameRow: gameRow({ racer_player_id: RACER, player_id: COMPOSER }),
    turnRows: [],
    correctionRows: [],
    resolutionRow: null,
    targetText: null,
    contestantSeat: "composer",
    capturedAt: "2026-08-16T12:00:00.000Z",
  });

  const serialized = JSON.stringify(e);
  for (const id of [COMPOSER, RACER]) {
    assert.equal(serialized.includes(id), false, "a player id leaked into the snapshot");
  }
  assert.equal(e.participants.composer_seat_recorded, true);
  assert.equal(e.participants.racer_seat_recorded, true);
});

test("the snapshot omits raw_output and the privileged target columns", async () => {
  queueCreateSequence({ target: [{ target: "a bal fülem" }] });
  await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: COMPOSER,
    playerArgument: "Vitatom.",
  });

  const turnSelect = calls.find((c) => c.sql.includes("FROM corpus.game_turns"));
  assert.ok(turnSelect);
  assert.equal(
    /\braw_output\b/.test(turnSelect.sql),
    false,
    "raw_output carries the Racer's private rationale and must not be copied"
  );

  const targetSelect = calls.find((c) => c.sql.includes("FROM corpus.game_targets"));
  assert.ok(targetSelect);
  for (const column of ["definition", "granularity", "modifiers", "locked_at"]) {
    assert.equal(
      new RegExp(`\\b${column}\\b`).test(targetSelect.sql),
      false,
      `${column} stays behind its own grant surface in V2.6`
    );
  }
});

test("the snapshot is a copy, not a pointer — it survives without a live re-read", async () => {
  queueCreateSequence();
  await createContest({
    operationalGameId: OPERATIONAL_GAME_ID,
    playerId: COMPOSER,
    playerArgument: "Vitatom.",
  });
  const insert = calls.find((c) => c.sql.includes("INSERT INTO corpus.game_contests"));
  const evidenceValue = insert?.values.find(
    (v) => typeof v === "string" && v.startsWith("{") && v.includes("schema_version")
  );
  assert.ok(evidenceValue, "the evidence must be bound as serialized jsonb, not derived later");
  const parsed = JSON.parse(String(evidenceValue));
  assert.equal(parsed.schema_version, CONTEST_EVIDENCE_SCHEMA_VERSION);
  assert.ok(parsed.captured_at, "a snapshot records when it was taken");
});

// ---------------------------------------------------------------------------
// Retrieval.
// ---------------------------------------------------------------------------

test("the contestant can retrieve their own contest", async () => {
  responses = [[insertedRow()]];
  const contest = await getContestById(randomUUID(), COMPOSER);
  assert.ok(contest);
  assert.equal(contest.contestant_seat, "composer");
  assert.equal(contest.evidence_schema_version, CONTEST_EVIDENCE_SCHEMA_VERSION);
});

test("V2.6: retrieval is CONTESTANT-OWNED — ownership is tested in the SQL", async () => {
  // The route cannot forget a guard that lives in the query. This asserts the
  // predicate is actually there and actually bound to the requester, because
  // the fake driver would happily return a row regardless.
  responses = [[insertedRow()]];
  await getContestById("33333333-3333-4333-8333-333333333333", COMPOSER);

  const read = calls.find((c) => c.sql.includes("FROM corpus.game_contests"));
  assert.ok(read);
  assert.match(read.sql, /player_id\s+IS NOT NULL/i);
  assert.match(read.sql, /AND\s+player_id\s*=\s*\?/i);
  assert.ok(read.values.includes(COMPOSER), "the requester must be bound into the predicate");
});

test("V2.6: the OTHER seat cannot retrieve a contest it did not file", async () => {
  // The correction that separates V2.6 from participant-shared access.
  // Occupying the other seat in the source game grants nothing here.
  responses = [[]]; // the ownership predicate matches no row
  const contest = await getContestById(randomUUID(), RACER);
  assert.equal(contest, null);
});

test("an outsider and an unauthenticated caller retrieve nothing", async () => {
  responses = [[]];
  assert.equal(await getContestById(randomUUID(), STRANGER), null);

  // Null identity is refused before any query: an unauthenticated caller can
  // own nothing, and the predicate is never handed a null to compare against.
  calls = [];
  assert.equal(await getContestById(randomUUID(), null), null);
  assert.equal(calls.length, 0, "an unauthenticated read must not reach the database");
});

test("a privacy-erased contest has no end-user retrieval path, by design", async () => {
  // ACCEPTED CONSEQUENCE, ratified: unlink sets player_id to NULL, and a NULL
  // matches no requester. The record survives as durable historical evidence
  // with nobody able to fetch it through the participant API. `IS NOT NULL` is
  // explicit rather than relying on SQL's NULL comparison semantics, so the
  // intent is readable and cannot be lost to a later rewrite.
  responses = [[]];
  assert.equal(await getContestById(randomUUID(), COMPOSER), null);

  const read = calls.find((c) => c.sql.includes("FROM corpus.game_contests"));
  assert.match(read!.sql, /player_id\s+IS NOT NULL/i);
});

test("V2.6 adds no reviewer, admin or community access path", () => {
  // The erased-contest gap above is only acceptable while nothing quietly
  // fills it. If a bypass appears in either the module or a route, this fails.
  const sources = [
    "lib/corpus/gameContests.ts",
    "app/api/contest/[id]/route.ts",
    "app/api/game/[id]/contest/route.ts",
  ].map((f) => readFileSync(f, "utf8"));

  for (const src of sources) {
    for (const bypass of ["admin", "reviewer", "moderator", "is_staff", "bypass"]) {
      assert.equal(
        new RegExp(`\\b${bypass}\\b`, "i").test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")),
        false,
        `V2.6 must not introduce a '${bypass}' access path`
      );
    }
  }
});

test("listing returns only the requester's own contest, and gates on the seat too", async () => {
  responses = [[gameRow({ racer_player_id: RACER })], [insertedRow()]];
  const loaded = await listOwnContestsForGame(OPERATIONAL_GAME_ID, COMPOSER);
  assert.ok(loaded);
  assert.equal(loaded.contests.length, 1);

  const list = calls.find(
    (c) => c.sql.includes("FROM corpus.game_contests") && c.sql.includes("corpus_game_id")
  );
  assert.ok(list);
  assert.match(list.sql, /player_id\s+IS NOT NULL/i);
  assert.ok(list.values.includes(COMPOSER));

  // The seat check does not authorize the payload — the predicate above does —
  // but it is what keeps "not in this game" distinguishable from "has not
  // contested it".
  assert.equal(resolveContestSeat(loaded.subject, STRANGER), null);
});

test("a participant who has not contested gets an empty list, not an error", async () => {
  responses = [[gameRow({ racer_player_id: RACER })], []];
  const loaded = await listOwnContestsForGame(OPERATIONAL_GAME_ID, RACER);
  assert.ok(loaded);
  assert.deepEqual(loaded.contests, []);
  assert.equal(resolveContestSeat(loaded.subject, RACER), "racer");
});

test("a missing game and an unauthorized reader are indistinguishable from outside", async () => {
  responses = [[]];
  assert.equal(await listOwnContestsForGame(OPERATIONAL_GAME_ID, COMPOSER), null);
  // The route maps both null and a null seat to the same 403 body — asserted
  // here as the contract the route depends on.

  calls = [];
  assert.equal(await listOwnContestsForGame(OPERATIONAL_GAME_ID, null), null);
  assert.equal(calls.length, 0, "an unauthenticated list must not reach the database");
});

// ---------------------------------------------------------------------------
// Privacy unlink.
// ---------------------------------------------------------------------------

test("unlinking a player clears contest linkage in the same call", async () => {
  responses = [[{ corpus_game_id: CORPUS_GAME_ID }], [{ contest_id: randomUUID() }]];
  await unlinkPlayer(COMPOSER);

  const contestUnlink = calls.find((c) => c.sql.includes("UPDATE corpus.game_contests"));
  assert.ok(contestUnlink, "erasure must reach contests, not only games");
  assert.match(contestUnlink.sql, /SET\s+player_id\s*=\s*NULL/i);
  assert.ok(contestUnlink.values.includes(COMPOSER));
});

test("the contest unlink clears ONLY the identifier", async () => {
  responses = [[{ corpus_game_id: CORPUS_GAME_ID }], [{ contest_id: randomUUID() }]];
  await unlinkPlayer(COMPOSER);

  const contestUnlink = calls.find((c) => c.sql.includes("UPDATE corpus.game_contests"));
  assert.ok(contestUnlink);
  for (const preserved of [
    "player_argument",
    "evidence",
    "contestant_seat",
    "contested_outcome",
    "status",
    "created_at",
  ]) {
    assert.equal(
      new RegExp(`SET[\\s\\S]*\\b${preserved}\\b\\s*=`, "i").test(contestUnlink.sql),
      false,
      `${preserved} must survive erasure untouched`
    );
  }
});

test("a failed contest unlink does not roll back a successful game unlink", async () => {
  // Partial erasure is strictly better than none. The failure is logged loudly
  // and the games that were unlinked stay unlinked.
  responses = [[{ corpus_game_id: CORPUS_GAME_ID }]];
  let calledOnce = false;
  __setSqlClientForTests(
    Object.assign(
      (strings: TemplateStringsArray, ...values: SqlValue[]) => {
        const text = strings.join("?");
        calls.push({ sql: text, values });
        if (text.includes("UPDATE corpus.game_contests")) {
          calledOnce = true;
          return Promise.reject(new Error("contest table unavailable"));
        }
        return Promise.resolve(responses.shift() ?? []);
      },
      { transaction: (q: Promise<Record<string, unknown>[]>[]) => Promise.all(q) }
    )
  );

  const result = await unlinkPlayer(COMPOSER);
  assert.equal(calledOnce, true);
  assert.equal(result, 1, "the games unlink must still report its own success");
});

// ---------------------------------------------------------------------------
// Static guards on migration 0006.
//
// The behaviours above depend on constraints that live in SQL, which no test in
// this environment can execute. These assert the SQL still SAYS what the
// application assumes — the same technique test/corpusPersistence.test.ts uses.
// ---------------------------------------------------------------------------

const MIGRATION = readFileSync("migrations/0006_contest_verdict.sql", "utf8");

/**
 * Executable SQL only, with `--` commentary removed.
 *
 * The forbidden-state scan below must read what the database will DO, not what
 * the file says about it. The migration's own comment names the states it
 * refuses to create, and a check against the raw text would fail on the
 * documentation of the rule it is enforcing.
 */
const MIGRATION_SQL = MIGRATION.replace(/--[^\n]*/g, "");

test("0006: V2.6 supports exactly one contest status, enforced by CHECK", () => {
  assert.match(MIGRATION_SQL, /CHECK\s*\(\s*status\s*=\s*'open'\s*\)/i);
  // The states the task explicitly forbids. Any of these reaching executable
  // SQL means the single-state rule was widened without a decision.
  for (const forbidden of [
    "reviewed", "resolved", "accepted", "rejected",
    "overturned", "closed", "appealed",
  ]) {
    assert.equal(
      new RegExp(`'${forbidden}'`, "i").test(MIGRATION_SQL),
      false,
      `V2.6 must not introduce the '${forbidden}' state`
    );
  }
});

test("0006: uniqueness is keyed on the seat, so erasure cannot disable it", () => {
  assert.match(
    MIGRATION,
    /CREATE UNIQUE INDEX[\s\S]*game_contests_one_per_seat[\s\S]*\(\s*corpus_game_id\s*,\s*contestant_seat\s*\)/i
  );
});

test("0006: contests are immutable except for the privacy unlink", () => {
  assert.match(MIGRATION, /CREATE TRIGGER contests_immutable/i);
  assert.match(MIGRATION, /to_jsonb\(NEW\)\s*-\s*'player_id'/i);
  // player_id may only ever travel toward NULL. Permitting a change outright
  // would allow a contest to be reassigned to a different player, which is
  // worse than the edit the trigger exists to prevent.
  assert.match(MIGRATION, /player_id may only be cleared, never reassigned/i);
});

test("0006: the migration is additive — it alters nothing that already exists", () => {
  assert.equal(/\bALTER TABLE\b/i.test(MIGRATION), false);
  assert.equal(/\bDROP TABLE\b/i.test(MIGRATION), false);
  // The two DROP TRIGGER / CREATE OR REPLACE FUNCTION statements it does carry
  // name only its own objects.
  const replaced = MIGRATION.match(/CREATE OR REPLACE FUNCTION\s+([\w.]+)/gi) ?? [];
  assert.deepEqual(replaced, ["CREATE OR REPLACE FUNCTION corpus.reject_contest_mutation"]);
});

test("0006: the parent link cascades, matching every other corpus child table", () => {
  assert.match(MIGRATION, /REFERENCES corpus\.games\(corpus_game_id\) ON DELETE CASCADE/i);
});
