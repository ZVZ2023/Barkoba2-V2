-- ---------------------------------------------------------------------------
-- Barkóba V2.6 — migration 0007: developer / tester unlimited play
--
-- Purely additive. One new table, two indexes. No existing table, column,
-- constraint, trigger or index is altered. accounts.entitlement_ledger is not
-- touched in any way.
--
-- WHY THIS IS NOT A LEDGER ROW — the decisive argument.
--
-- Balance is defined as SUM(amount) over accounts.entitlement_ledger, and
-- getStatus() buckets that same sum into complimentary_granted / purchased /
-- consumed. ANY expression of unlimited play as a ledger row therefore lands in
-- one of those buckets and corrupts the Play Credit curve — a live workstream
-- that is waiting on token-level telemetry and will be calibrated against
-- exactly these numbers.
--
-- Unlimited play is not an amount of value. It is a PROPERTY OF AN IDENTITY,
-- and a property of an identity belongs in its own table. This mirrors the
-- reasoning that keeps corpus.game_targets separate from corpus.games: a
-- different kind of fact, with a different access profile, gets a different
-- table rather than a column on someone else's.
--
-- WHAT THIS DELIBERATELY DOES NOT CREATE
--
-- No expiry column — the requirement is unlimited with no expiration, and a
-- nullable expires_at that nothing reads would be a lie of the kind
-- entitlement_ledger.expires_at already documents. No amount, no tier, no
-- quota. No grant API: rows arrive by direct database access only, which is
-- what keeps self-grant impossible without also making an admin panel a
-- prerequisite.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounts.unlimited_play (
  grant_id        bigserial PRIMARY KEY,

  -- A REFERENCE, not a foreign key — identical reasoning to
  -- entitlement_ledger.player_id and corpus.games.player_id. There is no
  -- players table; durable identity lives in Redis, and the anonymous majority
  -- has no durable record at all.
  --
  -- NOTE THE CONSEQUENCE: nothing validates that this id exists. A typo grants
  -- unlimited play to a player who will never appear. That is inert rather than
  -- dangerous, but it is why identity must be confirmed by round trip before a
  -- row is written, not inferred.
  player_id       text NOT NULL,

  -- WHO this is, in human terms: 'zsolt_dev', 'william_test'. Required, because
  -- a bare player_id in this table six months from now is unattributable, and
  -- an unattributable privilege grant is one nobody dares revoke.
  label           text NOT NULL,

  reason          text,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  granted_by      text,

  -- REVOCATION IS A TIMESTAMP, NEVER A DELETE. The grant history of a
  -- privileged identity is exactly the kind of record that must survive its own
  -- withdrawal — "was this player ever exempt, and between which dates" has to
  -- stay answerable. Same philosophy as the ledger's append-only trigger,
  -- expressed with a column because this table is tiny and hand-operated.
  revoked_at      timestamptz,
  revoked_reason  text
);

-- ---------------------------------------------------------------------------
-- AT MOST ONE ACTIVE GRANT PER PLAYER, and a full history alongside it.
--
-- PARTIAL, on the revoked_at IS NULL predicate. That is what allows a player to
-- be granted, revoked and granted again — several rows, one active — while
-- making a duplicate active grant impossible. A plain UNIQUE(player_id) would
-- have forced revocation to be an UPDATE-in-place and destroyed the history the
-- column above exists to keep.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS unlimited_play_one_active_per_player
  ON accounts.unlimited_play (player_id) WHERE revoked_at IS NULL;

-- The lookup on the game-creation path. Partial for the same reason the index
-- above is: revoked rows are history and are never consulted by the gate.
CREATE INDEX IF NOT EXISTS unlimited_play_active
  ON accounts.unlimited_play (player_id) WHERE revoked_at IS NULL;
