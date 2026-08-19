-- ---------------------------------------------------------------------------
-- Barkóba V2.6 Module 1 — persistent player accounts and revocable sessions.
--
-- The account keeps the EXISTING player_id. Entitlement and corpus ownership
-- rows are references to that id and are deliberately not copied or rewritten.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounts.players (
  player_id      text PRIMARY KEY,
  recovery_key   text NOT NULL UNIQUE,
  display_name   text,
  created_at     timestamptz NOT NULL,
  registered_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz,

  CONSTRAINT player_account_id_shape CHECK (player_id ~ '^[0-9a-f]{32}$'),
  CONSTRAINT player_account_recovery_shape CHECK (recovery_key ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS accounts.player_sessions (
  session_hash  text PRIMARY KEY,
  player_id     text NOT NULL REFERENCES accounts.players(player_id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,

  CONSTRAINT player_session_hash_shape CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT player_session_expiry_order CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS player_sessions_active_by_player
  ON accounts.player_sessions (player_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- New purchase rows require an active registered account. During the one-time
-- 24-hour cutover, grantPurchase() may set this transaction-local flag for a
-- reference minted by the pre-account deployment. The setting cannot leak to
-- another request because it is local to one transaction.
CREATE OR REPLACE FUNCTION accounts.require_purchase_account()
RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'purchase'
     AND NOT EXISTS (
       SELECT 1
         FROM accounts.players
        WHERE player_id = NEW.player_id
          AND disabled_at IS NULL
     )
     AND COALESCE(current_setting('barkoba.allow_legacy_purchase', true), '') <> 'on'
  THEN
    RAISE EXCEPTION 'purchase entitlement requires a registered player account';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entitlement_purchase_requires_account
  ON accounts.entitlement_ledger;
CREATE TRIGGER entitlement_purchase_requires_account
  BEFORE INSERT ON accounts.entitlement_ledger
  FOR EACH ROW EXECUTE FUNCTION accounts.require_purchase_account();
