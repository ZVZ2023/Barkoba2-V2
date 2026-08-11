-- ---------------------------------------------------------------------------
-- Barkóba V2.2 — migration 0002: make finalized turns repairable
--
-- THE BLOCKER THIS REMOVES.
--
-- 0001 gave corpus.games and corpus.game_turns immutability triggers, but only
-- the games one asks whether anything actually changed:
--
--   games  ->  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN ... RAISE
--   turns  ->  RAISE, unconditionally, for any UPDATE on a finalized game
--
-- The corpus writer syncs full state with
-- `INSERT ... ON CONFLICT (turn_id) DO UPDATE`, so re-syncing a completed game
-- issues an UPDATE for every existing turn — even when every value is
-- identical. Under the 0001 trigger that raises, and the whole transaction
-- rolls back.
--
-- The consequence was that replay and repair were impossible for exactly the
-- games that needed them: a completed game with a missing target or resolution
-- row could never be completed, because the attempt died on its own turns.
-- 2.2.0.2 produced one such row in production.
--
-- WHAT CHANGES, AND WHAT DOES NOT.
--
-- Only the trigger function body. No table, column, index, constraint or row is
-- touched, so the schema and every existing record are unchanged.
--
-- The immutability GUARANTEE is unchanged too: a real edit to a finalized turn
-- still raises. What is now permitted is a write that changes nothing, which is
-- not a mutation of evidence — it is a replay proving the evidence already
-- matches. This is precisely the rule corpus.games has always followed; 0002
-- makes the two consistent rather than loosening either.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION corpus.reject_finalized_turn_mutation()
RETURNS trigger AS $$
DECLARE
  parent_finalized timestamptz;
BEGIN
  SELECT finalized_at INTO parent_finalized
    FROM corpus.games WHERE corpus_game_id = OLD.corpus_game_id;

  IF parent_finalized IS NOT NULL THEN
    -- A no-op re-sync is allowed; an actual change to recorded evidence is not.
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION
        'corpus.game_turns %: turns of a finalized game are immutable', OLD.turn_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
