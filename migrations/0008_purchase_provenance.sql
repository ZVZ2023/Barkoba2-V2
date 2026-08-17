-- ---------------------------------------------------------------------------
-- Attested payment provenance on purchase ledger rows.
--
-- This column is evidence, never an entitlement input. Existing rows remain
-- valid with NULL. The ledger's existing mutation trigger already rejects all
-- UPDATE and DELETE operations, so provenance is immutable once inserted.
-- ---------------------------------------------------------------------------

ALTER TABLE accounts.entitlement_ledger
  ADD COLUMN purchase_facts jsonb;

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
