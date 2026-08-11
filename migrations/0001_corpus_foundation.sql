-- ---------------------------------------------------------------------------
-- Barkóba V2.2 — migration 0001: corpus foundation
--
-- Establishes durable historical evidence in PostgreSQL (Neon). Redis remains
-- the authoritative live game state; nothing here migrates an existing Redis
-- responsibility.
--
-- TWO SCHEMAS, NOT TWO TABLE GROUPS.
--
--   corpus.*   raw observable evidence. Append-only. Immutable once finalized.
--   derived.*  every later interpretation: scores, annotations, benchmarks.
--
-- The separation is enforced by a trigger and by grantable schema boundaries,
-- not by naming discipline. Raw evidence must never be overwritten by a later
-- reading of it — that is the whole point of the milestone.
--
-- Forward-only. Applied by scripts/migrate.mjs and recorded in
-- public.schema_migrations.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS corpus;
CREATE SCHEMA IF NOT EXISTS derived;

-- ---------------------------------------------------------------------------
-- games — one row per PRESERVED game.
--
-- Not one row per created game: a game enters the corpus only once it contains
-- at least one completed question/answer interaction (the approved threshold).
-- A game with no answered turn carries no reasoning path and nothing the
-- research principle can reconstruct.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corpus.games (
  corpus_game_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The Redis game_id. UNIQUE because it is the idempotency key for every
  -- write: a retried turn resolves to the same corpus row. Kept DISTINCT from
  -- corpus_game_id on purpose — the operational id is TTL-scoped and appears in
  -- shareable URLs, the corpus id is permanent and internal.
  operational_game_id  uuid NOT NULL UNIQUE,

  -- A REFERENCE, not a foreign key. There is no players table: the anonymous
  -- majority has no durable player record at all, so a FK would be
  -- unsatisfiable for most rows. This mirrors GameRecord.player_id exactly.
  -- Nullable also because player deletion UNLINKS by setting this to NULL.
  player_id            text,

  -- Build identity. GameRecord carries no version field, so this is captured at
  -- write time and cannot be backfilled for a game already in flight.
  app_version          text,
  commit_sha           text,

  composer_kind        text NOT NULL,
  racer_kind           text NOT NULL,
  difficulty           text,
  clue_mode            text,
  game_language        text NOT NULL,
  max_questions        integer NOT NULL,
  private_target       boolean NOT NULL DEFAULT false,

  -- Lifecycle and outcome are deliberately ORTHOGONAL. An abandoned game must
  -- not have to fake an outcome, and a completed game must not have to encode
  -- its outcome inside a lifecycle enum.
  lifecycle_state      text NOT NULL,
  outcome              text,
  termination_reason   text,

  -- The engine phase at the last successful sync. Recorded so that a game which
  -- simply stops can later be reclassified honestly WITHOUT re-reading Redis:
  -- a game last seen in 'resolving' stalled during adjudication, one last seen
  -- in 'questioning' was abandoned mid-play. Those are different findings and
  -- inferring one from the other would be guesswork.
  last_phase           text,

  question_count       integer NOT NULL DEFAULT 0,
  ambiguous_count      integer NOT NULL DEFAULT 0,

  created_at           timestamptz NOT NULL,
  first_persisted_at   timestamptz NOT NULL DEFAULT now(),
  last_activity_at     timestamptz NOT NULL,
  finalized_at         timestamptz,

  -- Provenance, not consent. Distinguishes the pre-public research corpus from
  -- anything later gathered under a public disclosure regime.
  collection_context   text NOT NULL DEFAULT 'pre_public_research',

  CONSTRAINT games_lifecycle_known CHECK (lifecycle_state IN (
    'in_progress',
    'completed',
    'abandoned_inferred',
    'stalled_resolving',
    'expired_unresolved'
  )),
  CONSTRAINT games_outcome_known CHECK (outcome IS NULL OR outcome IN (
    'racer_correct',
    'racer_incorrect',
    'composer_win_integrity_upheld',
    'racer_win_integrity_violation'
  ))
);

-- ---------------------------------------------------------------------------
-- game_turns — the chronological evidence. One row per QuestionLogEntry.
--
-- turn_id reuses QuestionLogEntry.id, which is already a per-entry UUID minted
-- by the engine. That gives idempotency a natural key: a replayed turn collides
-- with itself rather than duplicating.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corpus.game_turns (
  turn_id                 uuid PRIMARY KEY,
  corpus_game_id          uuid NOT NULL
                            REFERENCES corpus.games(corpus_game_id) ON DELETE CASCADE,

  turn_index              integer NOT NULL,

  -- 'main' is the played sequence. 'abandoned' holds turns discarded by an
  -- answer correction/rewind. Both are real evidence — a rewound branch shows
  -- what the Racer inferred from an answer later found wrong — but only 'main'
  -- is the game as played, so they must never interleave.
  branch                  text NOT NULL DEFAULT 'main',

  turn_type               text NOT NULL,
  actor                   text NOT NULL,

  question_text           text,
  guess_text              text,
  clue_text               text,
  composer_response       text,

  -- The closest thing the engine produces to an explicit IS-IS marker.
  ambiguous_explanation   text,

  guess_detector_flagged  boolean NOT NULL DEFAULT false,
  guess_detector_method   text,
  guess_intent_outcome    text,

  original_question_text  text,
  edit_status             text,
  edit_reason             text,

  -- The participant's raw structured output, unmodified.
  raw_output              jsonb,

  occurred_at             timestamptz NOT NULL,

  CONSTRAINT turns_branch_known CHECK (branch IN ('main', 'abandoned')),
  CONSTRAINT turns_type_known CHECK (turn_type IN ('question', 'guess', 'concede', 'clue'))
);

-- Chronology guarantee: the played sequence cannot contain two turns claiming
-- the same position. Deliberately PARTIAL — abandoned branches legitimately
-- reuse turn_index values, and across several rewinds may reuse them more than
-- once, so they are keyed only by their own UUID.
CREATE UNIQUE INDEX IF NOT EXISTS game_turns_main_sequence
  ON corpus.game_turns (corpus_game_id, turn_index)
  WHERE branch = 'main';

-- ---------------------------------------------------------------------------
-- game_targets — declassified target metadata. 1:1 with games.
--
-- SEPARATE TABLE ON PURPOSE. This holds material that was secret during play.
-- A separate table is a separate grant surface: a future read-only research
-- role can be given the games and turns without ever being given the targets.
-- Folding these columns into corpus.games would make that impossible without a
-- later migration.
--
-- Populated ONLY from GameRecord fields written at the single declassification
-- point in /api/game/[id]/resolve. A game that never resolved has no row here,
-- and that is the accepted cost of preserving the isolation invariant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corpus.game_targets (
  corpus_game_id  uuid PRIMARY KEY
                    REFERENCES corpus.games(corpus_game_id) ON DELETE CASCADE,
  target          text NOT NULL,
  definition      text,
  granularity     text,
  modifiers       text,
  locked_at       timestamptz,
  revealed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT targets_granularity_known CHECK (
    granularity IS NULL OR granularity IN ('generic_type', 'specific_instance')
  )
);

-- ---------------------------------------------------------------------------
-- game_resolutions — how the game ended. 1:1, absent for unresolved games.
--
-- Separate from games because resolution arrives at a different time, is
-- entirely absent for abandoned games, and is the structure most likely to gain
-- fields as adjudication evolves.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corpus.game_resolutions (
  corpus_game_id          uuid PRIMARY KEY
                            REFERENCES corpus.games(corpus_game_id) ON DELETE CASCADE,
  final_action            text,
  final_guess_text        text,
  adjudicator_verdict     text,

  -- Raw observable output of the Adjudicator, generated on every adjudication
  -- and previously discarded by the resolve route. Stored as produced: not
  -- interpreted, not normalised, not turned into a quality metric. Any such
  -- reading belongs in derived.*.
  adjudicator_confidence  double precision,

  adjudication_notes      text,
  integrity_verdict       text,
  integrity_notes         text,
  integrity_flagged_turns integer[],
  resolved_at             timestamptz
);

-- ---------------------------------------------------------------------------
-- game_corrections — answer corrections and their blast radius.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corpus.game_corrections (
  correction_id    bigserial PRIMARY KEY,
  corpus_game_id   uuid NOT NULL
                     REFERENCES corpus.games(corpus_game_id) ON DELETE CASCADE,
  turn_index       integer NOT NULL,
  from_answer      text NOT NULL,
  to_answer        text NOT NULL,
  discarded_turns  integer NOT NULL DEFAULT 0,
  occurred_at      timestamptz NOT NULL,

  -- The correction log is append-only per game; a replayed sync must not
  -- duplicate it. (game, turn, time) is the natural identity of one correction.
  CONSTRAINT game_corrections_identity UNIQUE (corpus_game_id, turn_index, occurred_at)
);

-- ---------------------------------------------------------------------------
-- Indexes.
--
-- The first serves player history — the only query with a latency requirement.
-- The partial indexes serve the recorded Game Intelligence questions directly
-- and cost almost nothing, because their predicates are highly selective.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS games_player_history
  ON corpus.games (player_id, created_at DESC) WHERE player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS games_lifecycle
  ON corpus.games (lifecycle_state);
CREATE INDEX IF NOT EXISTS games_outcome
  ON corpus.games (outcome) WHERE outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS games_app_version
  ON corpus.games (app_version);
CREATE INDEX IF NOT EXISTS games_open_activity
  ON corpus.games (last_activity_at) WHERE lifecycle_state = 'in_progress';

CREATE INDEX IF NOT EXISTS game_turns_chronology
  ON corpus.game_turns (corpus_game_id, turn_index);
CREATE INDEX IF NOT EXISTS game_turns_type
  ON corpus.game_turns (turn_type);
CREATE INDEX IF NOT EXISTS game_turns_flagged
  ON corpus.game_turns (guess_detector_flagged) WHERE guess_detector_flagged;
CREATE INDEX IF NOT EXISTS game_turns_ambiguous
  ON corpus.game_turns (composer_response) WHERE composer_response = 'AMBIGUOUS';

-- ---------------------------------------------------------------------------
-- IMMUTABILITY OF FINALIZED EVIDENCE.
--
-- Once a game is finalized, its raw record stops being writable. A later
-- analysis, a retried request, or a well-meaning fix cannot silently rewrite
-- what happened.
--
-- Two deliberate exemptions, and only two:
--   player_id  — set to NULL by player deletion (unlink). Erasure must remain
--                possible on a finalized record or deletion becomes a lie.
--   collection_context — provenance may need correcting without touching evidence.
--
-- A comment cannot enforce this. A trigger can.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION corpus.reject_finalized_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.finalized_at IS NOT NULL THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      IF (to_jsonb(NEW) - 'player_id' - 'collection_context')
         IS DISTINCT FROM
         (to_jsonb(OLD) - 'player_id' - 'collection_context') THEN
        RAISE EXCEPTION
          'corpus.games %: finalized evidence is immutable (only player_id unlink and collection_context may change)',
          OLD.corpus_game_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS games_immutable_once_finalized ON corpus.games;
CREATE TRIGGER games_immutable_once_finalized
  BEFORE UPDATE ON corpus.games
  FOR EACH ROW EXECUTE FUNCTION corpus.reject_finalized_mutation();

CREATE OR REPLACE FUNCTION corpus.reject_finalized_turn_mutation()
RETURNS trigger AS $$
DECLARE
  parent_finalized timestamptz;
BEGIN
  SELECT finalized_at INTO parent_finalized
    FROM corpus.games WHERE corpus_game_id = OLD.corpus_game_id;
  IF parent_finalized IS NOT NULL THEN
    RAISE EXCEPTION
      'corpus.game_turns %: turns of a finalized game are immutable', OLD.turn_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS turns_immutable_once_finalized ON corpus.game_turns;
CREATE TRIGGER turns_immutable_once_finalized
  BEFORE UPDATE ON corpus.game_turns
  FOR EACH ROW EXECUTE FUNCTION corpus.reject_finalized_turn_mutation();

-- ---------------------------------------------------------------------------
-- derived.* — the interpretation layer. Created empty, deliberately unused in
-- 2.2.0.0. It exists now so that the boundary is structural from the first
-- migration rather than retrofitted once analyses already live in the wrong
-- place.
--
-- analysis_runs is what makes disagreement expressible: two readings of the
-- same turn can coexist and contradict each other, each attributable to the
-- model, prompt version or human that produced it. That is impossible if a
-- score is a column on the raw turn.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS derived.analysis_runs (
  analysis_run_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL,
  analyst          text,
  model_id         text,
  prompt_version   text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS derived.turn_annotations (
  annotation_id    bigserial PRIMARY KEY,
  analysis_run_id  uuid NOT NULL
                     REFERENCES derived.analysis_runs(analysis_run_id) ON DELETE CASCADE,
  turn_id          uuid NOT NULL
                     REFERENCES corpus.game_turns(turn_id) ON DELETE CASCADE,
  label            text,
  score            double precision,
  rationale        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT turn_annotation_unique_per_run UNIQUE (analysis_run_id, turn_id, label)
);

CREATE INDEX IF NOT EXISTS turn_annotations_turn ON derived.turn_annotations (turn_id);
