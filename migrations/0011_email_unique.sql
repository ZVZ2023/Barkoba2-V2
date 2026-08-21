-- ---------------------------------------------------------------------------
-- Barkóba V2.6.x — migration 0011: unique email
--
-- Closes a gap left by migration 0010: nothing prevented the same address
-- from being attached to more than one account. Case-insensitive
-- (LOWER(email)) because mail providers overwhelmingly treat the local part
-- as case-insensitive in practice — a "duplicate" that only differed by
-- capitalisation would defeat the point of this index entirely.
--
-- A UNIQUE INDEX rather than a table CONSTRAINT: Postgres has no syntax for
-- a constraint over an expression like LOWER(email) — only a functional
-- index can express it.
--
-- PARTIAL, matching every other index on this table: most rows still have no
-- email at all (every pre-V2.6.x account, and every legacy-migrated one).
-- Excluded explicitly rather than relying on NULL <> NULL semantics to do
-- the same job implicitly.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS players_email_unique
  ON accounts.players (LOWER(email))
  WHERE email IS NOT NULL;
