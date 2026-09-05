-- ---------------------------------------------------------------------------
-- Barkóba V2.8.7 — migration 0013: per-call AI usage on turn_operations
--
-- Extends corpus.turn_operations (migration 0012) so ONE table records every
-- billable model call a game makes, with the token usage the provider
-- reported, and can be priced per seat afterwards (lib/aiCost.ts,
-- scripts/reportAiCost.ts). lib/corpus/turnTelemetry.ts remains the only
-- writer.
--
-- WHY THE SAME TABLE: the Racer's provider attempts were already recorded
-- here per attempt (accepted, duplicate-rejected, failed, timed out). Cost
-- accounting needs exactly that per-attempt granularity — a rejected
-- duplicate and a timed-out call are still billed — so the additive columns
-- go on the rows that already exist rather than into a parallel ledger that
-- could drift from them. New operation kinds cover the other seats.
--
-- NULL MEANS UNKNOWN, NEVER ZERO. A usage column is NULL whenever the
-- provider did not report that figure (or the call never reached a
-- provider). The cost report counts such rows as unpriced, not as free.
--
-- WHAT THIS STILL DOES NOT CONTAIN: no model output, no arguments, no
-- credentials, no headers, nothing a player wrote. Only operational facts
-- about an attempt, now including how many tokens it consumed.
-- ---------------------------------------------------------------------------

ALTER TABLE corpus.turn_operations
  -- The model id REQUESTED at call time, kept even after model_id is
  -- overwritten with the RESOLVED id on success (0012 kept only one column
  -- and let the resolved id replace the requested one).
  ADD COLUMN IF NOT EXISTS requested_model_id text,
  -- The reasoning effort actually sent ("low" for the V2.8.7 Racer and
  -- adjudication defaults); NULL where the provider has no such control or
  -- the call sent none.
  ADD COLUMN IF NOT EXISTS reasoning_effort text,
  -- 'forced_tool' | 'auto_strict_tool' — how the structured output was
  -- obtained (lib/providers/anthropic.ts). NULL for corpus_write rows.
  ADD COLUMN IF NOT EXISTS request_mode text,
  -- Uncached input tokens at the full input rate.
  ADD COLUMN IF NOT EXISTS input_tokens integer,
  -- Input tokens served from the provider's cache.
  ADD COLUMN IF NOT EXISTS cached_input_tokens integer,
  -- Input tokens written to the provider's cache (Anthropic only).
  ADD COLUMN IF NOT EXISTS cache_write_input_tokens integer,
  -- Output tokens INCLUDING reasoning, where the provider bills reasoning
  -- as output.
  ADD COLUMN IF NOT EXISTS output_tokens integer,
  -- The reasoning share of output_tokens. Informational; never billed twice.
  ADD COLUMN IF NOT EXISTS reasoning_tokens integer;

-- Every seat's billable call is now an operation kind. 'provider_attempt'
-- keeps its meaning (a Racer turn attempt inside the duplicate-guard loop);
-- 'racer_guess_intent' is the Racer's own follow-up call when the Guess
-- Detector fires. 'adjudicator' and 'integrity_review' are the adjudication
-- seat; the rest are the other AI seats. lib/aiCost.ts maps kinds to the
-- three reported cost buckets (racer / adjudication / other).
ALTER TABLE corpus.turn_operations
  DROP CONSTRAINT IF EXISTS turn_operations_kind_known;
ALTER TABLE corpus.turn_operations
  ADD CONSTRAINT turn_operations_kind_known CHECK (
    operation_kind IN (
      'provider_attempt', 'corpus_write',
      'racer_guess_intent',
      'adjudicator', 'integrity_review',
      'validator', 'composer_choice', 'composer_answer', 'composer_clue',
      'question_edit'
    )
  );

-- 'refusal': the provider returned a successful response that declined the
-- call (Claude Fable 5.1's stop_reason "refusal"). Recorded distinctly from
-- 'provider_error' because it can be billed and because it is never retried
-- automatically — see app/api/game/[id]/resolve/route.ts.
ALTER TABLE corpus.turn_operations
  DROP CONSTRAINT IF EXISTS turn_operations_status_known;
ALTER TABLE corpus.turn_operations
  ADD CONSTRAINT turn_operations_status_known CHECK (
    status IN (
      'started', 'accepted', 'duplicate_rejected', 'provider_error',
      'self_timeout', 'shared_budget_exhausted', 'presumed_killed',
      'refusal',
      'written', 'deferred', 'disabled', 'below_threshold', 'error'
    )
  );

-- Per-game, per-seat aggregation — the cost report's only access path.
CREATE INDEX IF NOT EXISTS turn_operations_game_kind_idx
  ON corpus.turn_operations (game_id, operation_kind);
