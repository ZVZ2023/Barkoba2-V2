-- ---------------------------------------------------------------------------
-- Barkóba M2 — migration 0012: Racer Guidance catalog (Strategy Memory)
--
-- Purely additive. Two new tables, two indexes, two immutability triggers, one
-- seed row. No existing table, column, constraint or trigger is touched.
--
-- WHAT THIS RECORDS, AND WHY IT BELONGS IN corpus.* NOT derived.*
--
-- `corpus.game_turns.prompt_version` (migration 0005) has stamped WHICH
-- guidance version produced each turn since 2.5.0.0. What it never had is a
-- parent catalog: WHAT that version's text actually said, WHEN it started
-- being used, and WHETHER it has ever been promoted or rejected. That catalog
-- is a raw fact about the deployed system — "this text was live guidance from
-- this point on" — not an interpretation of game evidence, so it takes the
-- same schema as the evidence it describes.
--
-- TWO TABLES, NOT ONE, BECAUSE IDENTITY AND DECISION HISTORY ARE DIFFERENT
-- KINDS OF FACT.
--
-- A mutable "status" column on one row would destroy exactly what M2 requires:
-- a durable, auditable HISTORY of promotion/rejection events, including the
-- valid initial condition that NONE have occurred yet for a version still
-- being field-tested. So the version's identity (racer_guidance_versions) is
-- separate from, and never mutated by, its decision history
-- (racer_guidance_decisions) — the same separation this schema already uses
-- for corpus.games vs corpus.game_resolutions.
--
-- "Zero decision events" is expressed as ZERO ROWS, not as a default status
-- value. A status column defaulting to e.g. 'unevaluated' can be misread as a
-- decision that was made; an empty result set from
-- `SELECT * FROM racer_guidance_decisions WHERE version = ...` cannot be
-- misread as anything but "no decision has occurred."
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
-- No promotion/rejection logic, no default status, no write path for a
-- decision — M2 establishes the storage contract only. The first row ever
-- inserted into racer_guidance_decisions is a later, explicit, human-made
-- decision, not something this migration or any M2 code produces.
--
-- `game_memory_observability` IS A DECLARATION ABOUT THE VERSION'S OWN CODE,
-- NOT A MEASUREMENT OF ANY GAME.
--
-- lib/prompts/racer.ts's tool schema (turnInputSchema) forces exactly four
-- output keys — action, question_text, guess_text, rationale — and
-- CORE_RACER_RULES itself instructs the model to "hold this state internally
-- ... emit only the resulting question or guess." Exclusions, uncertainty and
-- candidate/hypothesis state are therefore not observable in any turn played
-- under this version, for any game, by construction. Recording that as a
-- per-version fact — rather than a per-game field that would need to repeat
-- "not_observable" identically on every row forever — is what makes the
-- evaluation-ready record self-describing without inventing state the Racer
-- never emitted.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.racer_guidance_versions (
  -- The load-bearing database claim already stamped per-turn since migration
  -- 0005 (RACER_PROMPT_VERSION, verified true-by-construction at call time by
  -- assertGuidanceApplied() in lib/prompts/racer.ts). This catalog gives that
  -- string a durable parent row rather than leaving its text and history only
  -- in git and code comments.
  version                     text PRIMARY KEY,

  -- CORE_RACER_RULES, verbatim, for the version this row identifies. Pinned by
  -- test/racerGuidanceCatalog.test.ts against the live constant so this seed
  -- can never silently drift from what was actually shipped.
  guidance_text               text NOT NULL,

  introduced_at               timestamptz NOT NULL,

  -- Commit locating the source text, for a human auditing this row later.
  source_ref                  text,

  -- See the migration header. Declared once, when the row is created, from
  -- reading the version's own tool schema and system prompt — never derived
  -- from any game.
  game_memory_observability   jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS corpus.racer_guidance_decisions (
  decision_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version           text NOT NULL
                      REFERENCES corpus.racer_guidance_versions(version),

  -- No default, no third value. A row's mere existence IS the decision; there
  -- is no 'pending' state to encode because a pending version simply has no
  -- row yet.
  decision          text NOT NULL CHECK (decision IN ('promoted', 'rejected')),

  decided_at        timestamptz NOT NULL DEFAULT now(),
  decided_by        text,

  -- The controlled benchmark run that produced this decision, where one
  -- exists. Not a foreign key: corpus.games.benchmark_run_id is not unique
  -- (it groups repeated runs of one case), so this is provenance, not a join
  -- key.
  benchmark_run_id  uuid,

  notes             text
);

CREATE INDEX IF NOT EXISTS racer_guidance_decisions_by_version
  ON corpus.racer_guidance_decisions (version, decided_at DESC);

-- ---------------------------------------------------------------------------
-- IMMUTABILITY.
--
-- Unlike corpus.games/game_turns (0001, 0002), neither table here has an
-- "in-progress, then finalized" lifecycle to gate on — every row in both
-- tables is a finished fact from the moment it is inserted. So the trigger is
-- unconditional: no UPDATE is ever legitimate on either table. A version whose
-- text changes is a NEW version string and a NEW row; a reversed decision is a
-- NEW row in racer_guidance_decisions, never an edit of an old one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION corpus.reject_guidance_version_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'corpus.racer_guidance_versions %: a guidance version is immutable once recorded — add a new version row instead',
    OLD.version;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guidance_versions_immutable ON corpus.racer_guidance_versions;
CREATE TRIGGER guidance_versions_immutable
  BEFORE UPDATE ON corpus.racer_guidance_versions
  FOR EACH ROW EXECUTE FUNCTION corpus.reject_guidance_version_mutation();

CREATE OR REPLACE FUNCTION corpus.reject_guidance_decision_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'corpus.racer_guidance_decisions %: a decision is immutable once recorded — a reversal is a new row, never an edit',
    OLD.decision_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guidance_decisions_immutable ON corpus.racer_guidance_decisions;
CREATE TRIGGER guidance_decisions_immutable
  BEFORE UPDATE ON corpus.racer_guidance_decisions
  FOR EACH ROW EXECUTE FUNCTION corpus.reject_guidance_decision_mutation();

-- ---------------------------------------------------------------------------
-- SEED — the currently shipped version, identity and provenance only.
--
-- introduced_at/source_ref are the real commit that introduced racer/4.0.0
-- (git show -s --format='%H %cI' 204de37 ->
--  204de3780a1177614ef73af40285afda87efe784, 2026-08-21T21:22:14+02:00).
--
-- ON CONFLICT DO NOTHING makes this migration safe to re-run, matching the
-- idempotency this schema uses everywhere else. No row is ever inserted into
-- racer_guidance_decisions here — see the migration header: zero decision
-- events is this version's correct, honest initial condition, not something
-- this migration asserts by inserting a status.
-- ---------------------------------------------------------------------------

INSERT INTO corpus.racer_guidance_versions (
  version, guidance_text, introduced_at, source_ref, game_memory_observability
) VALUES (
  'racer/4.0.0',
  $guidance$RACER GUIDANCE V4 — UNCERTAINTY-MANAGEMENT LOOP — APPLY EVERY TURN

Before every turn, hold this state internally. Emit only the resulting question or guess.

KNOWN
Every hard YES, NO, and AMBIGUOUS answer so far. These are filters, not suggestions — nothing later may contradict one. AMBIGUOUS is informative failure, not a soft answer: it means the last question conflated two things a truthful answerer could not separate. Isolate one of them next; never re-ask a paraphrase of it.

UNKNOWN
The open dimensions that actually matter for this target's domain — discovered from the target itself, not a fixed checklist. Which one, if answered, would most shrink what remains possible?

HYPOTHESES
The leading family or families still consistent with KNOWN, plus the single strongest credible alternative. Keep this small and live, never a single premature favorite.

SELECT
Prefer the question that most usefully divides current HYPOTHESES over one that only confirms the leader. A broad split across an unresolved dimension beats naming siblings one at a time. After two or three related NOs on the same branch, stop — that is a signal, not a coincidence — and ask whether the parent frame itself is wrong before trying more siblings.

RED FLAGS — reject and regenerate if the question:
- Contradicts anything in KNOWN
- Re-probes a dimension already settled by a YES or a NO — a sibling within it, an edge case, or a more precise variant of the same confirmed value
- Names one specific sibling while a broader grouping one level up still has multiple live alternatives
- Is a disguised identity question — naming a candidate is a GUESS, not a question
- Investigates spelling, letters, or name structure instead of meaning and properties
- Targets two or three very similar remaining candidates with something generic or descriptive rather than the one property that specifically separates them

BEFORE ANY FINAL GUESS
Name the leader and the strongest remaining alternative — specifically, not a vague sense that others remain. Which facts support the leader and not equally the alternative? Have I asked the single discriminator that would most separate them? Would a reasonably informed human, given everything established so far, still be seriously considering that alternative — if yes, I am not ready to guess. Does the leader violate any fact in KNOWN? If an important discriminator remains unasked and budget allows, ask it instead of guessing.$guidance$,
  '2026-08-21T19:22:14Z'::timestamptz,
  '204de3780a1177614ef73af40285afda87efe784 — lib/prompts/racer.ts RACER_PROMPT_VERSION = "racer/4.0.0"',
  '{"evidence_ledger":"observed","remaining_budget":"deterministically_derived","exclusions":"not_observable","uncertainty":"not_observable","candidate_hypotheses":"not_observable"}'::jsonb
)
ON CONFLICT (version) DO NOTHING;
