-- ---------------------------------------------------------------------------
-- Barkóba V2.9.0 Slice 1 — migration 0015: Limited Beta / Founding Tester
-- foundation.
--
-- TWO NEW SCHEMAS, NOT accounts.* OR corpus.*. Beta membership and profile
-- moderation are neither entitlement (accounts.*) nor immutable game evidence
-- (corpus.*) — they are a third, separate concern, and mixing them into an
-- existing schema would be exactly the "beta membership must be stored
-- separately from ordinary player accounts and game entitlements" mistake
-- the product decision explicitly rules out. Player-visible feedback is
-- separate again: it is available to every player regardless of beta status,
-- so it must not live under beta.* either.
--
-- REFERENCES, NOT FOREIGN KEYS, matching corpus.games' and
-- accounts.entitlement_ledger's own precedent: there is no players table,
-- because the anonymous majority has no durable record. Every player_id
-- here is the same signed identity that exists from first contact.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS beta;
CREATE SCHEMA IF NOT EXISTS feedback;

-- ---------------------------------------------------------------------------
-- beta.applications — Founding Tester applications.
--
-- AT MOST ONE ROW PER PLAYER, EVER, ENFORCED BY THE UNIQUE CONSTRAINT ON
-- player_id (not append-only like entitlement_ledger): a "duplicate
-- application" is defined as "this player already has a row" — resubmission
-- returns the EXISTING status rather than creating a second row, so a
-- retried or double-clicked submission can never race two applications for
-- the same player_id, and there is exactly one status to review, not a
-- history to reconcile.
--
-- "Membership" (Community Beta Tester / Founding Tester) is DERIVED, not a
-- separate table: a player is a member iff their own row has status =
-- 'approved'. A second table would just be this one filtered, and would
-- invite the two to drift.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beta.applications (
  application_id    bigserial PRIMARY KEY,
  player_id         text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'pending',
  note              text,
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at       timestamptz,
  reviewed_by       text,
  rejection_reason  text,

  CONSTRAINT beta_application_status_known CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Directional sanity: a row cannot claim to be reviewed without saying by
  -- whom and when, and a still-pending row cannot claim either.
  CONSTRAINT beta_application_review_consistent CHECK (
    (status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS beta_applications_status
  ON beta.applications (status, submitted_at DESC);

-- ---------------------------------------------------------------------------
-- beta.profile_revisions — the ONLY public-facing content this slice
-- introduces: a Founding Tester's own headline/bio, shown to other
-- community members.
--
-- APPEND-ONLY, mirroring accounts.entitlement_ledger's own precedent, and
-- for the SAME structural reason: "the last approved public version stays
-- visible while a newer revision awaits review, and is never replaced by an
-- unreviewed edit" falls out for free if the public read is defined as "the
-- most recent row with status = 'approved' for this player_id" rather than
-- "the most recent row" — a pending or rejected revision simply is not that
-- row, by construction, with no separate "current published version"
-- pointer to keep in sync or accidentally overwrite.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beta.profile_revisions (
  revision_id   bigserial PRIMARY KEY,
  player_id     text NOT NULL,
  headline      text,
  bio           text,
  status        text NOT NULL DEFAULT 'pending',
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz,
  reviewed_by   text,

  CONSTRAINT beta_profile_revision_status_known CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT beta_profile_revision_review_consistent CHECK (
    (status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
  )
);

-- The hot read: "what is player X's current public profile" — most recent
-- APPROVED row. Partial, so it stays cheap regardless of how many pending/
-- rejected revisions a player accumulates over time.
CREATE INDEX IF NOT EXISTS beta_profile_revisions_approved
  ON beta.profile_revisions (player_id, submitted_at DESC)
  WHERE status = 'approved';

-- The moderation queue read: pending revisions across every player.
CREATE INDEX IF NOT EXISTS beta_profile_revisions_pending
  ON beta.profile_revisions (submitted_at DESC)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- feedback.submissions — available to every player regardless of beta
-- status, account status, or verification. player_id is NULLABLE on
-- purpose: a caller resolved as `{kind:"none"}` (no identity at all, e.g. a
-- cleared/blocked cookie) must still be able to leave feedback, per the
-- product decision that Founding Tester approval — or any other gate — must
-- never be a precondition for it.
--
-- operational_game_id is the ONLY game-related field, and deliberately the
-- ONLY one: it is an opaque reference, safe to store because it reveals
-- nothing by itself (matching the isolation boundary lib/entitlements.ts
-- already relies on for the exact same field) — never the target, the
-- transcript, or any other game content. Anyone reviewing feedback with
-- game context must go through the EXISTING, already-authorized channels
-- (getArchivedGameForOwner, the live game record) to resolve it, so this
-- table can never become a second, unguarded way to read a game's secret.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback.submissions (
  submission_id        bigserial PRIMARY KEY,
  player_id            text,
  operational_game_id  uuid,
  category             text,
  -- Which language the submitter wrote in ("hu"/"en"), for the admin
  -- inbox's own display only — never derived from, or coupled to, a
  -- referenced game's own game_language. Nullable: an older or malformed
  -- submission simply has no known language, not a fabricated one.
  language             text,
  message              text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_submissions_created
  ON feedback.submissions (created_at DESC);
