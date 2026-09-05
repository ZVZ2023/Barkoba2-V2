-- ---------------------------------------------------------------------------
-- Attested payment provenance on purchase ledger rows.
--
-- This column is evidence, never an entitlement input. Existing rows remain
-- valid with NULL. The ledger's existing mutation trigger already rejects all
-- UPDATE and DELETE operations, so provenance is immutable once inserted.
--
-- V2.8.7 — IDEMPOTENT RE-RUN. A Preview database was found carrying this
-- column WITHOUT this file's ledger row (a half-applied earlier attempt, from
-- before scripts/migrate.ts ran each file as one transaction). Rather than
-- skip on mere existence, the block below verifies the existing column is
-- EXACTLY what this file would have created — jsonb, nullable, no default —
-- and aborts the whole transaction otherwise; the three CHECK constraints are
-- then recreated with their exact original definitions. Databases where this
-- file already ran (production) never execute it again: the ledger is keyed
-- by filename and unchanged. No data is altered or deleted on any path.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  col record;
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO col
    FROM information_schema.columns
   WHERE table_schema = 'accounts'
     AND table_name   = 'entitlement_ledger'
     AND column_name  = 'purchase_facts';

  IF FOUND THEN
    IF col.data_type <> 'jsonb' OR col.is_nullable <> 'YES' OR col.column_default IS NOT NULL THEN
      RAISE EXCEPTION
        'entitlement_ledger.purchase_facts exists but does not match 0008 (type=%, nullable=%, default=%)',
        col.data_type, col.is_nullable, col.column_default;
    END IF;
  ELSE
    ALTER TABLE accounts.entitlement_ledger ADD COLUMN purchase_facts jsonb;
  END IF;
END
$$;

ALTER TABLE accounts.entitlement_ledger
  DROP CONSTRAINT IF EXISTS entitlement_purchase_facts_purchase_only,
  DROP CONSTRAINT IF EXISTS entitlement_purchase_facts_object,
  DROP CONSTRAINT IF EXISTS entitlement_purchase_facts_size;

ALTER TABLE accounts.entitlement_ledger
  ADD CONSTRAINT entitlement_purchase_facts_purchase_only CHECK (
    purchase_facts IS NULL OR kind = 'purchase'
  ),
  ADD CONSTRAINT entitlement_purchase_facts_object CHECK (
    purchase_facts IS NULL OR jsonb_typeof(purchase_facts) = 'object'
  ),
  ADD CONSTRAINT entitlement_purchase_facts_size CHECK (
    purchase_facts IS NULL OR octet_length(purchase_facts::text) <= 8192
  );
