-- ---------------------------------------------------------------------------
-- Barkóba V2.4 — migration 0004: Play Credit entitlement ledger
--
-- A NEW SCHEMA, NOT A corpus.* TABLE. corpus.* is immutable raw evidence with
-- BEFORE UPDATE triggers rejecting any change to a finalized row. Entitlement is
-- mutable, money-adjacent, operational state. Putting it in its own schema keeps
-- every V2.2 invariant intact and gives entitlement its own grant surface — a
-- future read-only research role can be given the corpus without ever being
-- given anyone's balance.
--
-- APPEND-ONLY. Balance is SUM(amount), never a stored counter. This follows the
-- strongest precedent in the codebase, lib/clueCredits.ts, which stores no
-- counter on purpose: "a counter is a second source of truth that can drift
-- from the transcript, and drift in a scarce resource is the kind of bug
-- players notice and remember." For a resource with money behind it, that
-- argument is stronger, not weaker.
--
-- Expiry is therefore a ROW, not a filter: a lapsed grant is neutralised by
-- writing a negative 'expiry' entry, so the balance stays a plain SUM and the
-- history of what expired remains readable. A WHERE clause on expires_at would
-- have made an already-spent grant go negative when it lapsed.
--
-- PLAY CREDIT IS NOT THE SÚGÓ/CLUE CREDIT. They share no naming, no storage and
-- no code path. lib/clueCredits.ts is derived per-game from the transcript and
-- never touches this table.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS accounts;

CREATE TABLE IF NOT EXISTS accounts.entitlement_ledger (
  entry_id            bigserial PRIMARY KEY,

  -- A REFERENCE, not a foreign key — identical reasoning to corpus.games:
  -- there is no players table, because the anonymous majority has no durable
  -- record. Play Credits attach to the signed player_id that exists from first
  -- contact. Attach, never replace.
  player_id           text NOT NULL,

  -- PROVENANCE MUST STAY QUERYABLE. Complimentary and purchased value are the
  -- same fungible play_credit for spending, and must never collapse into an
  -- indistinguishable balance: "how much of what this player holds was paid
  -- for?" has to remain answerable after the fact, and cannot be reconstructed
  -- from a single number.
  kind                text NOT NULL,

  -- Positive grants, negative consumption and expiry. The unit is play_credit:
  -- not a game, not a model call, not a token, not a currency.
  amount              integer NOT NULL,

  -- Set on consumption; the game this entitlement was spent on.
  operational_game_id uuid,

  -- Grants only. Advisory: the authoritative neutralisation of a lapsed grant
  -- is an 'expiry' row, not this column.
  expires_at          timestamptz,

  -- Dedupe key for grants that must happen at most once per player (a
  -- first-contact complimentary allowance, say). NULL for ordinary grants.
  grant_key           text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  note                text,

  CONSTRAINT entitlement_kind_known CHECK (kind IN (
    'complimentary_grant',
    'purchase',
    'consumption',
    'expiry',
    'adjustment'
  )),
  -- Directional sanity: a grant cannot take value away, a consumption cannot
  -- add it. 'adjustment' is deliberately unconstrained — it is the manual
  -- correction path and must be able to go either way.
  CONSTRAINT entitlement_amount_direction CHECK (
    (kind IN ('complimentary_grant', 'purchase') AND amount > 0)
    OR (kind IN ('consumption', 'expiry') AND amount < 0)
    OR kind = 'adjustment'
  ),
  CONSTRAINT entitlement_consumption_has_game CHECK (
    kind <> 'consumption' OR operational_game_id IS NOT NULL
  )
);

-- IDEMPOTENT CONSUMPTION. A retried game creation — a double submit, a
-- serverless retry, a client that fired twice — must never charge twice. This
-- index is what makes that a database guarantee rather than application care.
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_one_consumption_per_game
  ON accounts.entitlement_ledger (operational_game_id)
  WHERE kind = 'consumption';

-- At-most-once grants (e.g. a first-contact complimentary allowance).
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_grant_key_once
  ON accounts.entitlement_ledger (player_id, grant_key)
  WHERE grant_key IS NOT NULL;

-- Balance is read on every gated game creation, so this is the hot path.
CREATE INDEX IF NOT EXISTS entitlement_by_player
  ON accounts.entitlement_ledger (player_id, created_at DESC);

-- Provenance queries: "how much complimentary value has been issued", "what did
-- this player purchase". Kept cheap so the distinction stays usable.
CREATE INDEX IF NOT EXISTS entitlement_by_kind
  ON accounts.entitlement_ledger (kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- APPEND-ONLY, ENFORCED.
--
-- The ledger's correctness rests on entries never changing after the fact. A
-- balance derived from a mutable log is a stored counter wearing a disguise.
-- Deletion is likewise refused: an entry written in error is corrected with an
-- 'adjustment' row, which keeps the correction itself auditable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounts.reject_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'accounts.entitlement_ledger is append-only (attempted % on entry %)',
    TG_OP, OLD.entry_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entitlement_ledger_append_only ON accounts.entitlement_ledger;
CREATE TRIGGER entitlement_ledger_append_only
  BEFORE UPDATE OR DELETE ON accounts.entitlement_ledger
  FOR EACH ROW EXECUTE FUNCTION accounts.reject_ledger_mutation();
