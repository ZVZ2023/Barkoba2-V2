-- ---------------------------------------------------------------------------
-- Barkóba V2.6.x — migration 0010: registration upgrade (email + photo)
--
-- Supersedes DESIGN-NOTES §42's "e-mail... remain out of scope" line; see §44.
-- Purely additive: five nullable columns, two shape checks, one partial
-- index. No table rewrite, no backfill, no default. Every existing row
-- (registered under the old no-email design) stays valid with all five
-- columns NULL.
--
-- email_verification_token STORES A HASH, NOT THE RAW TOKEN — same
-- convention as accounts.players.recovery_key, which despite its name has
-- never stored a raw credential either (see lib/recoveryCode.ts). The raw
-- token exists only in the verification link; a database compromise must
-- not itself be enough to verify (or spoof-verify) an address.
--
-- email_verified_at is set once and never cleared by re-visiting a still-
-- valid link (see lib/playerAccounts.ts markEmailVerified) — the token and
-- its expiry are therefore left in place after a successful verification
-- rather than consumed, so a double-clicked or prefetched link is a harmless
-- no-op instead of a confusing "invalid link" on the second hit.
-- ---------------------------------------------------------------------------

ALTER TABLE accounts.players
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_verification_token text,
  ADD COLUMN IF NOT EXISTS email_verification_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS photo_url text;

-- Cheap sanity check, not RFC 5322 — matches lib/emailVerification.ts
-- looksLikeEmail() exactly, so the app and the database never disagree about
-- what counts as a plausible address.
ALTER TABLE accounts.players
  ADD CONSTRAINT player_account_email_shape CHECK (
    email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  );

ALTER TABLE accounts.players
  ADD CONSTRAINT player_account_verification_token_shape CHECK (
    email_verification_token IS NULL OR email_verification_token ~ '^[0-9a-f]{64}$'
  );

-- Verification is looked up by token, not by player_id. Partial, like
-- players_email_verification_token's siblings elsewhere in this schema: most
-- rows will have no pending token (never registered with one, or already
-- verified and never re-requested), so the index stays small.
CREATE INDEX IF NOT EXISTS players_email_verification_token
  ON accounts.players (email_verification_token)
  WHERE email_verification_token IS NOT NULL;
