-- ---------------------------------------------------------------------------
-- Barkóba V2.8.8 — migration 0014: experience_mode
--
-- Purely additive: one nullable column, no default, no NOT NULL, no
-- backfill, no table rewrite. Every existing row is untouched. Follows the
-- exact idempotent shape migration 0013 already established for adding a
-- CHECK constraint after the fact (DROP IF EXISTS, then ADD) — safe to
-- apply, re-apply after a partial failure, or apply a second time by
-- mistake; none of these can fail unpredictably or leave the constraint
-- half-applied.
--
-- WHY NOT CALLED "mode" OR "game_mode": both names are already spoken for in
-- this codebase. POST /api/game/create's own request body already has a
-- `mode` field selecting WHICH OF THE THREE CREATION PATHS applies
-- ("ai_composer" / "human_composer" / "human_human" — i.e. who plays which
-- seat). And migration 0003 explicitly REFUSED a corpus "game-mode" column
-- for that same seat-direction concept, on the grounds that
-- composer_kind/racer_kind already encode it and a third field restating
-- them would create two sources of truth that could drift
-- (migrations/0003_human_human_participants.sql). experience_mode is a
-- THIRD, independent thing — a player-chosen tone/assistance preset,
-- orthogonal to both direction and difficulty — and does not restate
-- either of the above; the name is deliberately distinct so nobody
-- confuses the three.
--
-- IMMUTABLE BY CONSTRUCTION, NOT BY TRIGGER: written once, at INSERT, in
-- lib/corpus/gameCorpus.ts's syncGame(), and deliberately ABSENT from that
-- same statement's `ON CONFLICT ... DO UPDATE SET` list — mirroring how
-- benchmark_case_id/benchmark_run_id are already treated. A later re-sync
-- of the same game therefore cannot rewrite it even before the
-- finalized-row immutability trigger (migration 0001's
-- reject_finalized_mutation) would additionally refuse the attempt.
--
-- NULL MEANS "created before V2.8.8", NEVER "competitive". No backfill: a
-- game recorded before this migration made no such choice, and defaulting
-- it to any of the four values would fabricate one. See lib/types.ts's
-- ExperienceMode and lib/gameStore.ts's getGame() backfill (which also
-- normalizes missing KV records to NULL, never to a chosen value).
-- ---------------------------------------------------------------------------

ALTER TABLE corpus.games ADD COLUMN IF NOT EXISTS experience_mode text;

ALTER TABLE corpus.games
  DROP CONSTRAINT IF EXISTS games_experience_mode_known;
ALTER TABLE corpus.games
  ADD CONSTRAINT games_experience_mode_known CHECK (
    experience_mode IS NULL OR experience_mode IN (
      'competitive', 'friendly', 'teaching', 'humorous'
    )
  );
