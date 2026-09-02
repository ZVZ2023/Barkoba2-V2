-- ---------------------------------------------------------------------------
-- Barkóba V2.8.3 — migration 0012: turn-operation telemetry (S2 / RB-2)
--
-- Durable, pre-fetch attempt telemetry for the bounded turn-execution budget.
-- lib/corpus/turnTelemetry.ts is the only module permitted to write here.
--
-- game_id is a REFERENCE, not a foreign key — matching corpus.games'
-- player_id column and its own comment for why: an operation can be
-- (and usually is) recorded for a game that has never been PRESERVED into
-- corpus.games at all (that table only gains a row "once it contains at
-- least one completed question/answer interaction" — migration 0001's own
-- comment). Q1's very first provider attempt happens before any answer
-- exists, so a foreign key here would reject the exact row this telemetry
-- exists to capture.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT CONTAIN: secret targets, player
-- answers or explanations, prompts, model output, tool-call arguments,
-- credentials, or headers. Only operational facts about an attempt.
--
-- `presumed_killed` classification is a READ, not a WRITE this schema
-- requires: a row still `status = 'started'` older than an approved
-- threshold is presumed-killed by a simple age query against
-- turn_operations_stale_started_idx, with no dependency on any later
-- request ever running. See lib/corpus/turnTelemetry.ts's
-- findPresumedKilledOperations.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.turn_operations (
  operation_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The Redis game_id (GameRecord.game_id). See header note: intentionally
  -- not a foreign key to corpus.games.
  game_id          text NOT NULL,

  -- The turn this operation is producing (provider_attempt) or persisting
  -- (corpus_write). Nullable: a provider_attempt is recorded before the
  -- eventual qa_log entry's own turn_index is finally assigned in some
  -- call shapes, and a corpus_write may cover a save with no new turn at all.
  turn_index       integer,

  operation_kind   text NOT NULL,

  -- 1-based position within the duplicate-guard's up-to-3-attempt loop.
  -- NULL for operation_kind = 'corpus_write'.
  attempt_number   integer,

  -- 'anthropic' | 'xai'. NULL for operation_kind = 'corpus_write'.
  provider         text,

  -- Requested model id. NULL for operation_kind = 'corpus_write', or when
  -- not yet resolved at insert time.
  model_id         text,

  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,

  status           text NOT NULL DEFAULT 'started',

  latency_ms       integer,

  -- A short classification only (e.g. 'self_timeout', 'provider_http_error')
  -- — never a raw error message, stack trace, or response body.
  error_class      text,

  CONSTRAINT turn_operations_kind_known CHECK (
    operation_kind IN ('provider_attempt', 'corpus_write')
  ),
  CONSTRAINT turn_operations_status_known CHECK (
    status IN (
      'started', 'accepted', 'duplicate_rejected', 'provider_error',
      'self_timeout', 'presumed_killed', 'completed', 'error'
    )
  ),
  CONSTRAINT turn_operations_attempt_number_range CHECK (
    attempt_number IS NULL OR attempt_number BETWEEN 1 AND 3
  ),
  CONSTRAINT turn_operations_provider_attempt_shape CHECK (
    operation_kind <> 'provider_attempt' OR attempt_number IS NOT NULL
  )
);

-- Game/turn lookup.
CREATE INDEX IF NOT EXISTS turn_operations_game_turn_idx
  ON corpus.turn_operations (game_id, turn_index);

-- Finding stale `started` operations — the presumed_killed classification's
-- only access path. Partial: the overwhelming majority of rows settle to a
-- terminal status quickly, so indexing only the ones still open keeps this
-- small regardless of table size.
CREATE INDEX IF NOT EXISTS turn_operations_stale_started_idx
  ON corpus.turn_operations (started_at)
  WHERE status = 'started';
