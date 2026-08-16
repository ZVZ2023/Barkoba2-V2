-- ---------------------------------------------------------------------------
-- Barkóba V2.5 — migration 0005: Game Intelligence provenance
--
-- Purely additive. Eight nullable columns and two partial indexes. No table
-- rewrite, no backfill, no default, no constraint change, NO TRIGGER CHANGE.
-- Every existing row and every V2.2/V2.3 invariant is untouched.
--
-- WHY THIS EXISTS. The V2.5-1 evidence audit, verified read-only against a real
-- completed AI-Racer game (corpus_game_id bd14b386-9837-4cd1-a293-0788aec77ce1,
-- app_version 2.4.0.0, 84 questions, 18 AMBIGUOUS, outcome racer_incorrect),
-- established that the transcript layer is sound and complete: turn_index
-- contiguous 1–85, counters reconciling exactly, and raw Racer output preserved
-- with a non-empty rationale on 86 of 86 stored turns.
--
-- It also established what is NOT recoverable. Across every persisted
-- raw_output object in that game the only keys are action, guess_text,
-- question_text and rationale. There is no model, provider or version anywhere
-- in the record. An 84-question hard game against an unknown model is
-- analysable as reasoning and worthless as a benchmark.
--
-- These columns close that. They record WHO produced a turn and under WHICH
-- prompt — nothing about what was reasoned, which was already durable.
--
-- ---------------------------------------------------------------------------
-- WHY NULLABLE, WITH NO DEFAULT.
--
-- NULL must keep meaning "not captured", never "unknown model". A DEFAULT would
-- assert a fact about historical rows that nobody observed, and a NOT NULL
-- would force a rewrite of a table whose whole value is that it has never been
-- rewritten. Games already in the corpus keep NULL provenance forever, and that
-- is the honest record: analysis must exclude them from model comparison rather
-- than assume a model for them.
--
-- ---------------------------------------------------------------------------
-- WHY MODEL AND PROMPT LIVE ON THE TURN, NOT THE GAME.
--
-- Identical reasoning to migration 0003's refusal of a game-mode column. A
-- game-level racer_model_id would restate what the turns already say and create
-- two sources of truth that can drift — and it would silently lie about a game
-- that straddled a configuration change, attributing every turn to whichever
-- model happened to be configured at the end. Group by turn when comparing
-- models; it is cheap, and it cannot drift.
--
-- ---------------------------------------------------------------------------
-- WHY THE BENCHMARK COLUMNS ARE PROSPECTIVE ONLY.
--
-- corpus.reject_finalized_mutation (0001, amended 0003) exempts exactly four
-- fields from the finalized-row lock: player_id, composer_player_id,
-- racer_player_id and collection_context. benchmark_case_id is NOT on that list
-- and deliberately will not be added — widening an immutability exemption to
-- buy a convenience is how the guarantee erodes.
--
-- The consequence, accepted: a game that has already finalized can never be
-- tagged here. bd14b386 is an excellent benchmark candidate and is permanently
-- untaggable in corpus.*. Retroactive designation of an existing game has
-- exactly one legal home, derived.*, and populating it is out of V2.5-3 scope.
--
-- These columns therefore serve games LAUNCHED as benchmark runs from here on.
-- That is a fact about the run, recorded at its start — raw evidence, not an
-- interpretation, which is why it belongs in corpus.* rather than derived.*.
--
-- Forward-only. Applied by scripts/migrate.ts and recorded in
-- public.schema_migrations.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- corpus.game_turns — per-turn provenance and the two evidence losses the
-- audit identified as structural.
-- ---------------------------------------------------------------------------

-- The model that actually produced THIS turn, as reported by the API in its
-- response — not the alias the request asked for. Those differ whenever a
-- configured id resolves to a dated snapshot, and only the resolved one is
-- evidence. Falls back to the requested id if the response omits it.
ALTER TABLE corpus.game_turns ADD COLUMN IF NOT EXISTS model_id text;

-- Constant for every row written today. The column exists now because adding it
-- later would mean altering the schema in the middle of the first comparison
-- that needed it, and a column added mid-experiment cannot describe the rows
-- already collected.
ALTER TABLE corpus.game_turns ADD COLUMN IF NOT EXISTS model_provider text;

-- The prompt that governed this turn, bumped by hand in the prompt module.
-- app_version and commit_sha already locate the source, and for a corpus with
-- one prompt per deployment they are a working proxy. They stop being one the
-- moment two Racer variants run at a single commit, which is precisely what
-- V2.5 benchmarking is for.
ALTER TABLE corpus.game_turns ADD COLUMN IF NOT EXISTS prompt_version text;

-- When the Composer's answer landed.
--
-- occurred_at is the moment the RACER's turn row was created. The answer is
-- written back onto that same row on a later request and, until now, carried no
-- timestamp of its own. The only thing derivable was an interval bound between
-- consecutive turns — which also contains the model call, so Composer think
-- time and model latency were inseparable. In a game with 18 IS-IS answers,
-- "did the Composer hesitate here?" is a real signal and was unmeasurable.
ALTER TABLE corpus.game_turns ADD COLUMN IF NOT EXISTS answered_at timestamptz;

-- The question as the Racer first emitted it, before the Guess Detector's
-- intent resolution rewrote it.
--
-- In /api/game/[id]/turn a flagged question is destroyed on BOTH resolution
-- branches: confirm_guess nulls question_text, and continue_questioning
-- replaces it with the revision. Either way the corpus recorded the second
-- question as though it were the first, next to guess_detector_flagged=true
-- with no evidence of what was flagged. original_question_text does not cover
-- this — it belongs to the human-Racer edit path in /ask.
--
-- This is the §18-B question/guess-boundary benchmark, which was unmeasurable
-- by construction until this column existed.
ALTER TABLE corpus.game_turns ADD COLUMN IF NOT EXISTS pre_revision_question_text text;

-- Which rewind discarded this turn. 1-based, NULL on the main branch.
--
-- buildTurnRows flattens GameRecord.abandoned_branches — an array of arrays —
-- into one branch='abandoned' bucket with no marker, and turn_index legitimately
-- repeats across branches. With two or more corrections in one game, which
-- discarded run a turn belonged to could not be recovered. occurred_at does not
-- rescue it: an abandoned turn carries its ORIGINAL creation time, not its
-- discard time, so overlapping index ranges produce interleaved timestamps.
--
-- No game in the corpus has ever had two corrections, so this failure has never
-- been observed. It ships anyway, because branch identity cannot be captured
-- retroactively: deferring it would permanently lose branch structure for every
-- multi-rewind game played between now and a later migration.
ALTER TABLE corpus.game_turns ADD COLUMN IF NOT EXISTS branch_seq integer;

-- ---------------------------------------------------------------------------
-- corpus.games — benchmark identity.
-- ---------------------------------------------------------------------------

-- Which benchmark case this run instantiates, e.g. 'red-citroen-c4'.
-- NULL — the overwhelming majority — is ordinary play.
ALTER TABLE corpus.games ADD COLUMN IF NOT EXISTS benchmark_case_id text;

-- Groups repeated runs of one case, so N replays against different Racers are
-- one comparable set rather than N unrelated games. Minted server-side.
ALTER TABLE corpus.games ADD COLUMN IF NOT EXISTS benchmark_run_id uuid;

-- ---------------------------------------------------------------------------
-- Indexes. Both partial, like games_player_history: the predicates are highly
-- selective and the indexes stay small while most rows carry neither field.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS games_benchmark_case
  ON corpus.games (benchmark_case_id, created_at DESC)
  WHERE benchmark_case_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS game_turns_model
  ON corpus.game_turns (model_id)
  WHERE model_id IS NOT NULL;
