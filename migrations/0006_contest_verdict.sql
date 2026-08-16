-- ---------------------------------------------------------------------------
-- Barkóba V2.6 — migration 0006: Contest Verdict foundation
--
-- Purely additive. One new table, three indexes, one trigger. No existing
-- table, column, constraint or trigger is altered. Every V2.2/V2.3/V2.5
-- invariant is untouched.
--
-- WHY A NEW TABLE AND NOT COLUMNS ON corpus.games
--
-- corpus.games is immutable once finalized (0001's trigger, widened by 0003 for
-- erasure only). A contest is created LONG after finalization, so a column on
-- that row could not be written at all without weakening the immutability
-- guarantee this corpus exists to provide. A contest is a DERIVED record about
-- a historical game, and it gets its own row.
--
-- WHY corpus.* AND NOT derived.*
--
-- derived.* is the interpretation layer: scores, annotations, model readings.
-- A contest is not an interpretation of evidence — it is a new observable
-- event (a named participant said this, at this time, about this verdict) plus
-- a preserved copy of the evidence as it stood. That is raw record, so it
-- belongs in corpus.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CREATE
--
-- No reviewer queue, no votes, no comments, no moderation, no reputation, no
-- public index, no reviewer decisions and no verdict-reversal path. V2.6 Task 2
-- captures a contest; it does not adjudicate one.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.game_contests (
  contest_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The durable parent. CASCADE matches every other corpus child table: if the
  -- game evidence is ever deleted outright, a contest about it is meaningless.
  corpus_game_id        uuid NOT NULL
                          REFERENCES corpus.games(corpus_game_id) ON DELETE CASCADE,

  -- Retained for provenance, exactly as the task requires, and because it is
  -- the id a participant actually holds (it is what appears in the game URL).
  -- NOT a foreign key: corpus.games.operational_game_id is unique, but this
  -- column's job is to survive as a written fact even if the join is later
  -- restructured.
  operational_game_id   uuid NOT NULL,

  -- A REFERENCE, not a foreign key — identical reasoning to games.player_id.
  -- There is no players table.
  --
  -- NULLABLE BECAUSE OF ERASURE, and that is the entire reason. V2.6 ratified
  -- that contest linkage follows the corpus unlink model: unlinkPlayer() sets
  -- this to NULL, the contest record itself survives with its argument and its
  -- evidence intact, and no fallback ever re-identifies the former contestant.
  player_id             text,

  -- WHICH SEAT contested. This is a ROLE, not an identity, so it survives
  -- erasure — which is what makes the uniqueness constraint below still mean
  -- "one contest per participant" after a player has been unlinked.
  contestant_seat       text NOT NULL,

  -- The verdict as it stood when the contest was filed, captured server-side
  -- from corpus.games.outcome. Never client-supplied.
  contested_outcome     text NOT NULL,

  -- The participant's own words. Immutable after creation: V2.6 ships no edit
  -- endpoint and this table has no updated_at, deliberately.
  player_argument       text NOT NULL,

  -- V2.6 SUPPORTS EXACTLY ONE STATE. The CHECK is what makes that structural
  -- rather than a convention: adding 'reviewed', 'resolved', 'overturned' or
  -- any sibling requires a migration and therefore a decision.
  status                text NOT NULL DEFAULT 'open',

  -- The shape of `evidence`, so a later reader knows how to interpret it
  -- without guessing from its contents. A version string, not a migration
  -- framework: when the shape changes, new rows carry a new version and old
  -- rows keep meaning exactly what they meant.
  evidence_schema_version text NOT NULL,

  -- THE POINT-IN-TIME SNAPSHOT.
  --
  -- The whole reason a contest is not merely `contest -> game_id -> reconstruct
  -- later`. A review that happens months from now must see the evidence as it
  -- was when the contest was filed, not as a later schema or a later
  -- application renders it.
  --
  -- Contains NO player identifiers, by construction. Seats are recorded as
  -- roles and occupancy booleans. If ids were embedded here, erasing player B
  -- would leave B's identifier sitting inside player A's snapshot, and the
  -- unlink guarantee would be quietly false.
  evidence              jsonb NOT NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contests_status_open_only CHECK (status = 'open'),
  CONSTRAINT contests_seat_known CHECK (contestant_seat IN ('composer', 'racer'))
);

-- ---------------------------------------------------------------------------
-- ONE CONTEST PER PARTICIPANT PER GAME, enforced at the durable layer.
--
-- Keyed on SEAT rather than player_id on purpose. player_id is nullable and is
-- actively nulled by erasure, and NULLs are distinct in a unique index — so a
-- player_id key would silently stop enforcing anything the moment a player was
-- unlinked, and the same seat could then file a second contest.
--
-- A game has exactly one Composer seat and one Racer seat, so "one row per
-- seat" IS "one row per participant", and it holds whether or not the
-- identities behind those seats still exist.
--
-- The two seats are independent: a Composer contest does not block the Racer
-- from filing their own.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS game_contests_one_per_seat
  ON corpus.game_contests (corpus_game_id, contestant_seat);

-- Retrieval by game, and the erasure sweep. Both are the queries this table
-- exists to serve.
CREATE INDEX IF NOT EXISTS game_contests_by_game
  ON corpus.game_contests (corpus_game_id, created_at DESC);

CREATE INDEX IF NOT EXISTS game_contests_by_player
  ON corpus.game_contests (player_id) WHERE player_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- CONTEST IMMUTABILITY.
--
-- The same shape as corpus.games' finalized-row lock, and for the same reason:
-- a comment cannot enforce this, a trigger can.
--
-- Exactly ONE permitted post-creation mutation, ratified in V2.6: the
-- privacy-driven nulling of player_id. Everything else — the argument, the
-- snapshot, the seat, the captured verdict, the status, the timestamps — raises.
--
-- Note the second guard. Permitting "player_id may change" would allow a
-- contest to be REASSIGNED to a different player, which is a far worse defect
-- than the edit this trigger is written to prevent. player_id may only ever
-- travel one way: to NULL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION corpus.reject_contest_mutation()
RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    IF (to_jsonb(NEW) - 'player_id') IS DISTINCT FROM (to_jsonb(OLD) - 'player_id') THEN
      RAISE EXCEPTION
        'corpus.game_contests %: a contest is immutable (only player_id unlink may change)',
        OLD.contest_id;
    END IF;
    IF NEW.player_id IS NOT NULL AND NEW.player_id IS DISTINCT FROM OLD.player_id THEN
      RAISE EXCEPTION
        'corpus.game_contests %: player_id may only be cleared, never reassigned',
        OLD.contest_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contests_immutable ON corpus.game_contests;
CREATE TRIGGER contests_immutable
  BEFORE UPDATE ON corpus.game_contests
  FOR EACH ROW EXECUTE FUNCTION corpus.reject_contest_mutation();
