import { getSql, isCorpusConfigured, type SqlClient } from "./db";

// ---------------------------------------------------------------------------
// V2.6 — THE CONTEST WRITE AND READ SEAM.
//
// The only module permitted to create or read a Contest Verdict record, exactly
// as gameCorpus.ts is the only module permitted to write durable game history.
//
// THIS MODULE MUST NEVER IMPORT secretStore, gameStore, OR ANY GAME LOGIC.
// It is listed in QUARANTINED in scripts/check-isolation.mjs, so that is
// mechanically enforced rather than promised here. It reads the durable corpus
// and nothing else.
//
// THREE PROPERTIES THAT DEFINE THIS MODULE:
//
//   1. A contest is a DERIVED RECORD. Creating one issues exactly one INSERT
//      into corpus.game_contests and touches no other table. The original game,
//      its turns, corrections, resolution and target are read-only here — there
//      is no UPDATE, no DELETE and no upsert anywhere in this file.
//
//   2. THE SNAPSHOT IS THE POINT. A contest is deliberately NOT
//      `contest -> game_id -> reconstruct everything live later`. game_id is
//      retained for provenance, but the evidence a reviewer will read is copied
//      at creation and stored as jsonb, so it survives later schema and
//      application evolution.
//
//   3. IT CARRIES NO PLAYER IDENTIFIERS INTO THE SNAPSHOT. Seats appear as
//      roles and occupancy booleans only. Embedding ids would leave one
//      player's identifier inside another player's snapshot, out of reach of
//      the erasure sweep, and the V2.6 unlink guarantee would be quietly false.
// ---------------------------------------------------------------------------

/**
 * The shape of `evidence`, written into every row.
 *
 * A version string, not a migration framework — deliberately. When the shape
 * changes, new rows carry a new version and old rows keep meaning exactly what
 * they meant when they were written. Nothing rewrites a stored snapshot, ever.
 */
export const CONTEST_EVIDENCE_SCHEMA_VERSION = "contest-evidence/1";

/** V2.6 supports exactly one state. There is no transition and no second value. */
export const CONTEST_STATUS_OPEN = "open";

/** Long enough for a real argument, bounded so one row cannot be unbounded text. */
export const MAX_PLAYER_ARGUMENT_LENGTH = 4000;

export type ContestSeat = "composer" | "racer";

// ---------------------------------------------------------------------------
// Eligibility — pure, so the rules are unit-testable and cannot drift into
// slightly different inline checks in two routes.
// ---------------------------------------------------------------------------

/**
 * The durable half of a corpus.games row that contest eligibility depends on.
 * Deliberately narrow: this is everything the decision needs and nothing else.
 */
export interface ContestSubject {
  corpus_game_id: string;
  operational_game_id: string;
  lifecycle_state: string;
  outcome: string | null;
  composer_player_id: string | null;
  racer_player_id: string | null;
}

export type ContestEligibilityError =
  /** No such game in the durable corpus. */
  | "game_not_found"
  /** The game has no verdict: in progress, abandoned, stalled or expired. */
  | "game_not_completed"
  /** No durable seat on this game matches the requesting player. */
  | "not_a_participant";

export interface ContestSeatCheck {
  ok: boolean;
  seat: ContestSeat | null;
  error: ContestEligibilityError | null;
}

/**
 * A game has a VERDICT — not merely a record.
 *
 * `lifecycle_state` and `outcome` are orthogonal in this schema by design
 * (migration 0001), so both are checked. 'completed' alone is not sufficient:
 * the completeness invariant in gameCorpus.ts documents a real production case
 * of a row marked completed whose resolution never landed. A contest is against
 * a Barkóba verdict, so the verdict has to actually be there.
 *
 * Every other lifecycle state is deliberately NOT contestable:
 * 'in_progress' has no verdict yet, and 'abandoned_inferred',
 * 'stalled_resolving' and 'expired_unresolved' each mean the game stopped
 * without producing one. Contesting them would be contesting an absence.
 */
export function hasContestableVerdict(subject: ContestSubject): boolean {
  return subject.lifecycle_state === "completed" && subject.outcome !== null;
}

/**
 * Which seat this player durably occupies on this historical game.
 *
 * DELIBERATELY NOT lib/seats.ts resolveSeat(). That function falls back for
 * single-human modes — an unassigned Composer seat belongs to whoever is asking
 * — which is correct and safe for a LIVE game that has exactly one human by
 * construction, and unsafe for a HISTORICAL one, where it would hand any
 * authenticated visitor a seat on any game whose column was never populated.
 *
 * V2.6 RATIFIED THE STRICT RULE: a non-null durable seat id must equal the
 * requesting player. Games recorded before durable seats existed are therefore
 * not contestable, and are not backfilled or inferred. That is an accepted
 * compatibility boundary, not an oversight.
 *
 * Only the REQUESTING participant's own seat must prove durable ownership. The
 * other seat may be null — an AI, an erased player, or a pre-V2.3 record — and
 * that has no bearing on whether this player may contest.
 */
export function resolveContestSeat(
  subject: ContestSubject,
  playerId: string | null
): ContestSeat | null {
  if (!playerId) return null;
  if (subject.composer_player_id && subject.composer_player_id === playerId) {
    return "composer";
  }
  if (subject.racer_player_id && subject.racer_player_id === playerId) {
    return "racer";
  }
  return null;
}

/** The full eligibility decision, in the order the failures should be reported. */
export function checkContestEligibility(
  subject: ContestSubject,
  playerId: string | null
): ContestSeatCheck {
  if (!hasContestableVerdict(subject)) {
    return { ok: false, seat: null, error: "game_not_completed" };
  }
  const seat = resolveContestSeat(subject, playerId);
  if (!seat) return { ok: false, seat: null, error: "not_a_participant" };
  return { ok: true, seat, error: null };
}

/**
 * Normalize a submitted argument.
 *
 * Trimmed and length-capped, and otherwise preserved verbatim — this is the
 * participant's own words and the record's whole reason for existing. Returns
 * null when there is nothing left, which the caller reports as a rejection
 * rather than storing an empty contest.
 */
export function normalizePlayerArgument(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_PLAYER_ARGUMENT_LENGTH);
}

// ---------------------------------------------------------------------------
// The evidence snapshot.
// ---------------------------------------------------------------------------

export interface ContestEvidenceTurn {
  turn_index: number;
  branch: string;
  branch_seq: number | null;
  turn_type: string;
  actor: string;
  question_text: string | null;
  guess_text: string | null;
  clue_text: string | null;
  composer_response: string | null;
  ambiguous_explanation: string | null;
  guess_detector_flagged: boolean;
  guess_detector_method: string | null;
  guess_intent_outcome: string | null;
  original_question_text: string | null;
  pre_revision_question_text: string | null;
  edit_status: string | null;
  edit_reason: string | null;
  model_id: string | null;
  model_provider: string | null;
  prompt_version: string | null;
  occurred_at: string | null;
  answered_at: string | null;
}

export interface ContestEvidence {
  schema_version: string;
  captured_at: string;

  /** Source game identity. Provenance, not a live pointer. */
  game: {
    corpus_game_id: string;
    operational_game_id: string;
    app_version: string | null;
    commit_sha: string | null;
    game_language: string | null;
    max_questions: number | null;
    question_count: number | null;
    ambiguous_count: number | null;
    lifecycle_state: string | null;
    outcome: string | null;
    termination_reason: string | null;
    last_phase: string | null;
    created_at: string | null;
    finalized_at: string | null;
  };

  /**
   * Roles and occupancy — never identifiers.
   *
   * `*_seat_recorded` says whether a durable identity existed at capture time,
   * which is the fact a reviewer needs (it is what makes the contest
   * authorizable at all). WHO it was is deliberately absent, so that erasing a
   * player cannot leave their id stranded inside someone else's snapshot.
   */
  participants: {
    composer_kind: string | null;
    racer_kind: string | null;
    composer_seat_recorded: boolean;
    racer_seat_recorded: boolean;
    contestant_seat: ContestSeat;
  };

  /** Chronological. Main branch and abandoned branches alike, both preserved. */
  turns: ContestEvidenceTurn[];

  corrections: Array<{
    turn_index: number;
    from_answer: string | null;
    to_answer: string | null;
    discarded_turns: number | null;
    occurred_at: string | null;
  }>;

  resolution: {
    final_action: string | null;
    final_guess_text: string | null;
    adjudicator_verdict: string | null;
    adjudicator_confidence: number | null;
    adjudication_notes: string | null;
    integrity_verdict: string | null;
    integrity_notes: string | null;
    integrity_flagged_turns: number[] | null;
    resolved_at: string | null;
  } | null;

  /**
   * The target as text, and nothing else about it.
   *
   * V2.6 ratified this precisely: `revealed_target` may be included because the
   * completed game already exposes it symmetrically to both participants
   * (GameView.revealed_target, written at the single declassification point).
   * The REST of corpus.game_targets — definition, granularity, modifiers,
   * locked_at — stays out. That table is a separate grant surface and
   * intersects the parked target-validator authority question.
   *
   * So the rule implemented here is: include exactly what a participant can
   * already see on the result screen. Nothing is declassified by filing a
   * contest.
   */
  revealed_target: string | null;
}

/** Narrow a driver row to a string, treating absent/null uniformly. */
function s(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function n(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

function b(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1;
}

/**
 * Assemble the snapshot from already-fetched rows.
 *
 * PURE, and separated from the SQL on purpose: the contents of the snapshot are
 * the part of this feature most worth pinning in a test, and a function that
 * needs a database to exercise does not get pinned.
 */
export function buildContestEvidence(input: {
  gameRow: Record<string, unknown>;
  turnRows: Record<string, unknown>[];
  correctionRows: Record<string, unknown>[];
  resolutionRow: Record<string, unknown> | null;
  targetText: string | null;
  contestantSeat: ContestSeat;
  capturedAt: string;
}): ContestEvidence {
  const g = input.gameRow;

  return {
    schema_version: CONTEST_EVIDENCE_SCHEMA_VERSION,
    captured_at: input.capturedAt,
    game: {
      corpus_game_id: String(g.corpus_game_id),
      operational_game_id: String(g.operational_game_id),
      app_version: s(g.app_version),
      commit_sha: s(g.commit_sha),
      game_language: s(g.game_language),
      max_questions: n(g.max_questions),
      question_count: n(g.question_count),
      ambiguous_count: n(g.ambiguous_count),
      lifecycle_state: s(g.lifecycle_state),
      outcome: s(g.outcome),
      termination_reason: s(g.termination_reason),
      last_phase: s(g.last_phase),
      created_at: s(g.created_at),
      finalized_at: s(g.finalized_at),
    },
    participants: {
      composer_kind: s(g.composer_kind),
      racer_kind: s(g.racer_kind),
      composer_seat_recorded: Boolean(g.composer_player_id),
      racer_seat_recorded: Boolean(g.racer_player_id),
      contestant_seat: input.contestantSeat,
    },
    turns: input.turnRows.map((t) => ({
      turn_index: n(t.turn_index) ?? 0,
      branch: s(t.branch) ?? "main",
      branch_seq: n(t.branch_seq),
      turn_type: s(t.turn_type) ?? "question",
      actor: s(t.actor) ?? "",
      question_text: s(t.question_text),
      guess_text: s(t.guess_text),
      clue_text: s(t.clue_text),
      composer_response: s(t.composer_response),
      ambiguous_explanation: s(t.ambiguous_explanation),
      guess_detector_flagged: b(t.guess_detector_flagged),
      guess_detector_method: s(t.guess_detector_method),
      guess_intent_outcome: s(t.guess_intent_outcome),
      original_question_text: s(t.original_question_text),
      pre_revision_question_text: s(t.pre_revision_question_text),
      edit_status: s(t.edit_status),
      edit_reason: s(t.edit_reason),
      model_id: s(t.model_id),
      model_provider: s(t.model_provider),
      prompt_version: s(t.prompt_version),
      occurred_at: s(t.occurred_at),
      answered_at: s(t.answered_at),
    })),
    corrections: input.correctionRows.map((c) => ({
      turn_index: n(c.turn_index) ?? 0,
      from_answer: s(c.from_answer),
      to_answer: s(c.to_answer),
      discarded_turns: n(c.discarded_turns),
      occurred_at: s(c.occurred_at),
    })),
    resolution: input.resolutionRow
      ? {
          final_action: s(input.resolutionRow.final_action),
          final_guess_text: s(input.resolutionRow.final_guess_text),
          adjudicator_verdict: s(input.resolutionRow.adjudicator_verdict),
          adjudicator_confidence: n(input.resolutionRow.adjudicator_confidence),
          adjudication_notes: s(input.resolutionRow.adjudication_notes),
          integrity_verdict: s(input.resolutionRow.integrity_verdict),
          integrity_notes: s(input.resolutionRow.integrity_notes),
          integrity_flagged_turns: Array.isArray(input.resolutionRow.integrity_flagged_turns)
            ? (input.resolutionRow.integrity_flagged_turns as unknown[]).map(
                (v) => n(v) ?? 0
              )
            : null,
          resolved_at: s(input.resolutionRow.resolved_at),
        }
      : null,
    revealed_target: input.targetText,
  };
}

// ---------------------------------------------------------------------------
// NOTE ON WHAT THE SNAPSHOT OMITS, AND WHY.
//
// raw_output is NOT copied. It is the participant's own structured tool output
// and includes the Racer's private `rationale` — reasoning that the live game
// never shows the Composer (GameView carries no rationale field, and
// RacerPublicState carries no Composer reasoning). Filing a contest must not
// become the route by which one seat reads the other's thinking. §8's rule is
// not to weaken existing isolation, so the snapshot stops exactly where the
// result screen stops.
//
// corpus.game_targets' definition, granularity and modifiers are NOT copied,
// per the same rule and the explicit V2.6 decision.
//
// Both omissions are recoverable by an authorized reviewer through the corpus
// itself, using corpus_game_id, under whatever grant that review runs with.
// They are absent from the SNAPSHOT, which is a participant-readable artefact,
// not absent from the evidence base.
// ---------------------------------------------------------------------------

export interface ContestRecord {
  contest_id: string;
  corpus_game_id: string;
  operational_game_id: string;
  player_id: string | null;
  contestant_seat: ContestSeat;
  contested_outcome: string;
  player_argument: string;
  status: string;
  evidence_schema_version: string;
  evidence: ContestEvidence;
  created_at: string;
}

function toContestRecord(row: Record<string, unknown>): ContestRecord {
  const evidence =
    typeof row.evidence === "string"
      ? (JSON.parse(row.evidence) as ContestEvidence)
      : (row.evidence as ContestEvidence);

  return {
    contest_id: String(row.contest_id),
    corpus_game_id: String(row.corpus_game_id),
    operational_game_id: String(row.operational_game_id),
    player_id: s(row.player_id),
    contestant_seat: s(row.contestant_seat) as ContestSeat,
    contested_outcome: s(row.contested_outcome) ?? "",
    player_argument: s(row.player_argument) ?? "",
    status: s(row.status) ?? CONTEST_STATUS_OPEN,
    evidence_schema_version: s(row.evidence_schema_version) ?? "",
    evidence,
    created_at: s(row.created_at) ?? "",
  };
}

export type CreateContestResult =
  | { ok: true; contest: ContestRecord }
  | {
      ok: false;
      error:
        | ContestEligibilityError
        | "corpus_unavailable"
        | "invalid_argument"
        | "duplicate_contest"
        | "write_failed";
    };

/** Fetch the eligibility-relevant columns for one operational game id. */
async function loadSubject(
  sql: SqlClient,
  operationalGameId: string
): Promise<{ subject: ContestSubject; row: Record<string, unknown> } | null> {
  const rows = await sql`
    SELECT corpus_game_id, operational_game_id, app_version, commit_sha,
           composer_kind, racer_kind, game_language, max_questions,
           question_count, ambiguous_count,
           lifecycle_state, outcome, termination_reason, last_phase,
           composer_player_id, racer_player_id,
           created_at, finalized_at
      FROM corpus.games
     WHERE operational_game_id = ${operationalGameId}::uuid
  `;
  const row = rows[0];
  if (!row) return null;

  return {
    row,
    subject: {
      corpus_game_id: String(row.corpus_game_id),
      operational_game_id: String(row.operational_game_id),
      lifecycle_state: s(row.lifecycle_state) ?? "",
      outcome: s(row.outcome),
      composer_player_id: s(row.composer_player_id),
      racer_player_id: s(row.racer_player_id),
    },
  };
}

/**
 * Create one contest against a completed game.
 *
 * AUTHORITATIVE FIELDS ARE SERVER-DERIVED, EVERY ONE. The caller supplies only
 * the game id and the argument text. Identity comes from the request's verified
 * player header; seat, verdict, status, evidence and schema version are all
 * read or computed here. There is no code path by which a client can assert any
 * of them.
 *
 * Issues exactly one INSERT. The original game and every other corpus table are
 * read-only in this function — a contest cannot mutate the record it is about.
 */
export async function createContest(input: {
  operationalGameId: string;
  playerId: string | null;
  playerArgument: unknown;
}): Promise<CreateContestResult> {
  if (!isCorpusConfigured()) return { ok: false, error: "corpus_unavailable" };

  const argument = normalizePlayerArgument(input.playerArgument);
  if (!argument) return { ok: false, error: "invalid_argument" };

  let sql: SqlClient | null;
  try {
    sql = getSql();
  } catch {
    return { ok: false, error: "corpus_unavailable" };
  }
  if (!sql) return { ok: false, error: "corpus_unavailable" };

  try {
    const loaded = await loadSubject(sql, input.operationalGameId);
    if (!loaded) return { ok: false, error: "game_not_found" };

    const check = checkContestEligibility(loaded.subject, input.playerId);
    if (!check.ok || !check.seat) {
      return { ok: false, error: check.error ?? "not_a_participant" };
    }

    const corpusGameId = loaded.subject.corpus_game_id;

    // Chronological, and abandoned branches alongside the played sequence —
    // both are evidence about how the verdict was reached. Ordering is explicit
    // so the snapshot does not depend on the planner.
    const [turnRows, correctionRows, resolutionRows, targetRows] = await Promise.all([
      sql`
        SELECT turn_index, branch, branch_seq, turn_type, actor,
               question_text, guess_text, clue_text, composer_response,
               ambiguous_explanation, guess_detector_flagged, guess_detector_method,
               guess_intent_outcome, original_question_text, pre_revision_question_text,
               edit_status, edit_reason,
               model_id, model_provider, prompt_version,
               occurred_at, answered_at
          FROM corpus.game_turns
         WHERE corpus_game_id = ${corpusGameId}::uuid
         ORDER BY branch DESC, branch_seq NULLS FIRST, turn_index ASC, occurred_at ASC
      `,
      sql`
        SELECT turn_index, from_answer, to_answer, discarded_turns, occurred_at
          FROM corpus.game_corrections
         WHERE corpus_game_id = ${corpusGameId}::uuid
         ORDER BY occurred_at ASC, turn_index ASC
      `,
      sql`
        SELECT final_action, final_guess_text, adjudicator_verdict,
               adjudicator_confidence, adjudication_notes,
               integrity_verdict, integrity_notes, integrity_flagged_turns, resolved_at
          FROM corpus.game_resolutions
         WHERE corpus_game_id = ${corpusGameId}::uuid
      `,
      // `target` ONLY. The remaining columns of this table stay behind their own
      // grant surface — see the note on ContestEvidence.revealed_target.
      sql`
        SELECT target
          FROM corpus.game_targets
         WHERE corpus_game_id = ${corpusGameId}::uuid
      `,
    ]);

    const evidence = buildContestEvidence({
      gameRow: loaded.row,
      turnRows,
      correctionRows,
      resolutionRow: resolutionRows[0] ?? null,
      targetText: targetRows[0] ? s(targetRows[0].target) : null,
      contestantSeat: check.seat,
      capturedAt: new Date().toISOString(),
    });

    // ON CONFLICT DO NOTHING against game_contests_one_per_seat is what makes
    // the uniqueness rule race-free. Two simultaneous submissions from the same
    // seat cannot both land, and the loser is reported as a duplicate rather
    // than as an error — which is what it is.
    const inserted = await sql`
      INSERT INTO corpus.game_contests (
        corpus_game_id, operational_game_id, player_id, contestant_seat,
        contested_outcome, player_argument, status,
        evidence_schema_version, evidence
      ) VALUES (
        ${corpusGameId}::uuid, ${loaded.subject.operational_game_id}::uuid,
        ${input.playerId}, ${check.seat},
        ${loaded.subject.outcome}, ${argument}, ${CONTEST_STATUS_OPEN},
        ${CONTEST_EVIDENCE_SCHEMA_VERSION}, ${JSON.stringify(evidence)}::jsonb
      )
      ON CONFLICT (corpus_game_id, contestant_seat) DO NOTHING
      RETURNING contest_id, corpus_game_id, operational_game_id, player_id,
                contestant_seat, contested_outcome, player_argument, status,
                evidence_schema_version, evidence, created_at
    `;

    const row = inserted[0];
    if (!row) return { ok: false, error: "duplicate_contest" };

    return { ok: true, contest: toContestRecord(row) };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[barkoba] contest creation failed for game ${input.operationalGameId}:`,
      err
    );
    return { ok: false, error: "write_failed" };
  }
}

// ---------------------------------------------------------------------------
// RETRIEVAL IS CONTESTANT-OWNED, NOT PARTICIPANT-SHARED.
//
// The frozen V2.6 product decision. A contest is retrievable by the player who
// FILED it, and by nobody else — not by the opponent, not by anyone who merely
// occupies the other seat in the source game.
//
// This is deliberately NARROWER than creation authorization, and the asymmetry
// is the point. Creation asks "may you contest this verdict?", which is a
// question about the game. Retrieval asks "is this yours?", which is a question
// about the contest. They are different questions and V2.6 answers them
// differently.
//
// THE OWNERSHIP TEST LIVES IN THE SQL, not in the route. A route can forget a
// guard; a query that cannot return another player's row has no guard to
// forget. This is the same reasoning that put the identity check inside
// getSecretForComposer() rather than in the route that calls it.
//
// CONSEQUENCE, ACCEPTED AND STATED: player_id is nulled by privacy unlink, and
// a NULL never equals a requester. An erased contest therefore remains durable
// historical evidence with no end-user retrieval path. That is intended, not a
// gap to be patched with a fallback — reviewer and community authorization are
// separate scope, and V2.6 adds no admin door.
// ---------------------------------------------------------------------------

/**
 * One contest by id, only if it belongs to the requesting player.
 *
 * Returns null for "no such contest", "not yours" and "erased" alike. The route
 * cannot distinguish them and neither can a caller — which is what stops a
 * contest id from being an enumeration oracle over a table of transcripts.
 */
export async function getContestById(
  contestId: string,
  playerId: string | null
): Promise<ContestRecord | null> {
  // An unauthenticated caller can own nothing. Checked before any query so the
  // ownership predicate is never handed a null to compare against.
  if (!playerId) return null;
  if (!isCorpusConfigured()) return null;
  let sql: SqlClient | null;
  try {
    sql = getSql();
  } catch {
    return null;
  }
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT contest_id, corpus_game_id, operational_game_id, player_id,
             contestant_seat, contested_outcome, player_argument, status,
             evidence_schema_version, evidence, created_at
        FROM corpus.game_contests
       WHERE contest_id = ${contestId}::uuid
         AND player_id IS NOT NULL
         AND player_id = ${playerId}
    `;
    const row = rows[0];
    if (!row) return null;
    return toContestRecord(row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] contest read failed for ${contestId}:`, err);
    return null;
  }
}

/**
 * The requesting player's OWN contests against one game.
 *
 * At most one row today — uniqueness is per seat and a player holds one seat —
 * but the shape stays a list so the endpoint does not have to change meaning if
 * that ever stops being true.
 *
 * The seat check is still performed and still gates the response. It is NOT
 * what authorizes the payload — the `player_id` predicate below does that — but
 * it is what lets the route distinguish "you are not in this game" from "you
 * have not contested it", which are different answers and deserve to be.
 */
export async function listOwnContestsForGame(
  operationalGameId: string,
  playerId: string | null
): Promise<{ subject: ContestSubject; contests: ContestRecord[] } | null> {
  if (!playerId) return null;
  if (!isCorpusConfigured()) return null;
  let sql: SqlClient | null;
  try {
    sql = getSql();
  } catch {
    return null;
  }
  if (!sql) return null;

  try {
    const loaded = await loadSubject(sql, operationalGameId);
    if (!loaded) return null;

    const rows = await sql`
      SELECT contest_id, corpus_game_id, operational_game_id, player_id,
             contestant_seat, contested_outcome, player_argument, status,
             evidence_schema_version, evidence, created_at
        FROM corpus.game_contests
       WHERE corpus_game_id = ${loaded.subject.corpus_game_id}::uuid
         AND player_id IS NOT NULL
         AND player_id = ${playerId}
       ORDER BY created_at ASC
    `;
    return { subject: loaded.subject, contests: rows.map(toContestRecord) };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[barkoba] contest list failed for game ${operationalGameId}:`, err);
    return null;
  }
}

/**
 * PRIVACY UNLINK — the one permitted post-creation mutation.
 *
 * Ratified in V2.6: contest linkage follows the corpus unlink model exactly.
 * The identifier is cleared; the contest, the argument, the snapshot, the seat,
 * the captured verdict and the timestamps all remain, and the original game is
 * untouched.
 *
 * Called from gameCorpus.unlinkPlayer so that a deletion is ONE decision with
 * one call site, rather than two erasure paths that can drift — which is the
 * failure migration 0003 was written to prevent for the seat columns.
 *
 * NEVER THROWS. Identity deletion must succeed even when this fails.
 */
export async function unlinkPlayerContests(
  sql: SqlClient,
  playerId: string
): Promise<number> {
  const rows = await sql`
    UPDATE corpus.game_contests
       SET player_id = NULL
     WHERE player_id = ${playerId}
     RETURNING contest_id
  `;
  return rows.length;
}
