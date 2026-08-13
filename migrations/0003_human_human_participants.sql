-- ---------------------------------------------------------------------------
-- Barkóba V2.3 — migration 0003: Human↔Human participants
--
-- Purely additive. Two nullable columns and two partial indexes. No table
-- rewrite, no backfill, no default, no constraint change, no trigger change.
-- Every existing row and every V2.2 invariant is untouched.
--
-- WHY NO GAME-MODE COLUMN: composer_kind and racer_kind already encode it.
-- A Human↔Human game is exactly composer_kind='human' AND racer_kind='human',
-- using fields the corpus has recorded since migration 0001. Adding a third
-- field that restates them would create two sources of truth that could drift.
--
-- WHY REFERENCES AND NOT FOREIGN KEYS: identical reasoning to games.player_id.
-- There is no players table — the anonymous majority has no durable record — so
-- a FK would be unsatisfiable for most rows.
--
-- These columns participate in player deletion. lib/corpus/gameCorpus.ts
-- unlinkPlayer clears all three id columns together; clearing only player_id
-- would leave an erased player still linked as Composer or Racer, which would
-- silently weaken the V2.2 erasure guarantee.
-- ---------------------------------------------------------------------------

ALTER TABLE corpus.games ADD COLUMN IF NOT EXISTS composer_player_id text;
ALTER TABLE corpus.games ADD COLUMN IF NOT EXISTS racer_player_id    text;

-- Partial, like games_player_history: the predicate is highly selective and the
-- index stays small while most games have no recorded seat.
CREATE INDEX IF NOT EXISTS games_composer_player
  ON corpus.games (composer_player_id, created_at DESC)
  WHERE composer_player_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS games_racer_player
  ON corpus.games (racer_player_id, created_at DESC)
  WHERE racer_player_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The immutability trigger must let erasure through on the new columns too.
--
-- 0001 exempted exactly two fields from the finalized-row lock: player_id, so
-- deletion stays possible on finished evidence, and collection_context. The two
-- new seat columns are erasure targets for the same reason and must join that
-- list — otherwise deleting a player whose Human↔Human game has already
-- finalized would RAISE, and the unlink would roll back.
--
-- That would be the worst possible failure of the three: a player asks to be
-- forgotten, the request appears to succeed, and the link survives.
--
-- The guarantee is otherwise unchanged. Any edit to actual recorded evidence on
-- a finalized game still raises.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION corpus.reject_finalized_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.finalized_at IS NOT NULL THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      IF (to_jsonb(NEW) - 'player_id' - 'composer_player_id' - 'racer_player_id' - 'collection_context')
         IS DISTINCT FROM
         (to_jsonb(OLD) - 'player_id' - 'composer_player_id' - 'racer_player_id' - 'collection_context') THEN
        RAISE EXCEPTION
          'corpus.games %: finalized evidence is immutable (only participant unlink and collection_context may change)',
          OLD.corpus_game_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
