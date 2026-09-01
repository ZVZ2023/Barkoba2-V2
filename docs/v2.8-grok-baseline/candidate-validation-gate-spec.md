# V2.8.x — Candidate Validation / Final-Guess Granularity Gate: Frozen Spec

**Status: frozen before Game 1 of the candidate regression run.** Nothing
below may change once the first candidate game starts. Any amendment found
necessary after that point goes in a dated addendum at the bottom of this
file, never a silent edit above it.

This is the ONE bounded strategy-system intervention authorized to follow
the 10-game Grok discovery batch (`docs/v2.8-grok-baseline/evaluation.md`).
It targets that batch's #1-ranked finding: a final guess that names the
correct *class* but the wrong *grain* — a bare parent category instead of
the identity the fixture actually requires.

## 0. What this experiment does NOT do

Restated from governance, because every one of these is a plausible-looking
scope-creep and none of them is in scope here:

- Does **not** modify or replace `racer/4.0.0`. `CORE_RACER_RULES` in
  `lib/prompts/racer.ts` is byte-identical to the frozen discovery-batch
  text; `RACER_PROMPT_VERSION` stays `"racer/4.0.0"` for both control and
  candidate games in this experiment, because the guidance text really is
  unchanged for both.
- Does **not** reopen D9 (bad-branch recovery). `racer/4.1.0` already tried
  and was REJECTED against that dimension in M4; that conclusion stands.
- Does **not** add prose to `CORE_RACER_RULES`. The mechanism is a second,
  separate model call gating the Racer's own output — not a new paragraph
  competing for attention inside an already-compressed block.
- Does **not** promote anything. No write to
  `corpus.racer_guidance_versions` or `corpus.racer_guidance_decisions`.
  The gate is not a Strategy Memory entry and is not eligible for
  promotion without a separate, explicit human review of this experiment's
  own results.
- Does **not** begin a second intervention based on this run's result. One
  hypothesis, one bounded test, one PASS/REVISE/REJECT verdict, then stop.

## 1. Target failure

A final candidate is emitted at the wrong grain:

- `generic_type` target → Racer guesses a parent/superordinate class
  rather than the intended type/member (e.g. guessing "a musical
  instrument" for a target that specifically requires "a guitar").
- `specific_instance` target → Racer guesses the class rather than the
  actual referent (e.g. guessing "bridge" for the Golden Gate Bridge, or
  "tradition" for the game of chess).

Observed 3/10 times in the frozen discovery batch (games 2, 6, 8 —
`docs/v2.8-grok-baseline/evaluation.md` §3, finding #1), the highest
recurrence, maximum materiality (it directly *is* the loss in all three),
and maximum causal reach (terminal decision, nothing downstream can
compensate) of anything that batch found.

## 2. Why a second model call, not more prompt text or a deterministic check

`RacerPublicState` (`lib/types.ts`) carries no target metadata whatsoever —
by construction, per `lib/racerState.ts`'s own "narrowing boundary"
comment. The Racer does not know, and structurally cannot know, whether the
fixture requires `generic_type` or `specific_instance` framing; that is
exactly what it must discover through play. This means "is the proposed
guess the right grain" cannot be answered by a deterministic code check
against secret metadata — the check has access to nothing the Racer itself
doesn't already have, namely the public transcript.

What CAN be enforced in code is not the semantic judgment but the
**gate itself**: whether a proposed guess is allowed to become the game's
final action without first passing a structured, adversarial re-check.
`racer/4.0.0` already asks the Racer to self-check before guessing
(`BEFORE ANY FINAL GUESS`) — the discovery batch is the evidence that
self-checking inside the same call that produced the bad guess is
insufficient 3/10 times. A second, independent call — one that never
generated the candidate guess and has nothing invested in it — is
structurally different: it can be REFUSED THE ABILITY to rubber-stamp a
bad decision, because `lib/prompts/candidateValidationGate.ts`'s own
`runCandidateValidationGate()` overrides the model's own `decision` field
in code whenever any of the three structured sub-checks (grain_ok,
unused_discriminator, hard_evidence_violation) disagrees with it. That
override is the actual runtime enforcement this experiment tests — not
prose, not model self-discipline, a code path that cannot commit a "guess"
action to the game record without it.

## 3. The intervention

Immediately before ANY final guess is committed to the game record, the
turn-by-turn driver (`scripts/runGrokStepCandidate.ts`) runs the gate
against exactly the same public transcript the Racer itself saw:

**A. Required grain.** Does the proposed candidate match the identity
grain required by the game? ("musical instrument" is too broad for
guitar; "bridge" is too broad for the Golden Gate Bridge.)

**B. Unused high-value discriminator.** Given remaining question budget and
current uncertainty, is there an obvious high-value discriminator that
would separate the live candidates/class members? If yes, the guess is
held regardless of A.

**C. Hard-evidence compatibility.** Does the proposed candidate violate any
hard KNOWN fact? If yes, it is never emitted, regardless of A or B.

Full system prompt and schema: `lib/prompts/candidateValidationGate.ts`.

## 4. Replacement behavior

A blocked guess is not merely refused. The gate's schema *requires* a
`replacement_question` whenever it blocks — the single highest-value
discriminator that would separate the remaining plausible identities
inside the established class — and
`scripts/runGrokStepCandidate.ts`'s `appendRacerTurnCandidate()` installs
that question as the turn's actual output in place of the guess. The game
continues normally from there: the replacement question is answered by the
Composer exactly like any other turn, and a later turn may attempt to
guess again (and may be gated again). This is the behavior Phase 5's
success criterion (§7 below) actually requires: a blocked guess that
merely stalls, without producing useful discrimination, does not count as
the intervention working.

## 5. Boundary — what this experiment does not touch

Per governance, restated as an explicit checklist:

- D9 rules — untouched. The gate never fires on a "question" action, only
  on "guess"; SELECT and RED FLAGS behavior is unmodified.
- Opening strategy — untouched.
- Ontology — no domain vocabulary added anywhere in the gate's prompt.
- AMBIGUOUS handling — untouched; the gate never sees or judges an
  AMBIGUOUS answer differently from a YES/NO.
- Question-selection logic — untouched EXCEPT the one place the spec
  explicitly allows it: choosing the replacement discriminator after a
  blocked guess, which is the gate's own job, not a change to
  `CORE_RACER_RULES`'s SELECT paragraph.
- Provider/model — unchanged: `xai`, pinned `grok-4.20-0309-reasoning`,
  for both the Racer-turn calls and the gate's own calls.
- Fixture answers — unchanged; §7 fixtures reuse the exact frozen
  target/definition text from `docs/v2.8-grok-baseline/discovery-10-fixture-spec.md`
  and `scripts/runD2GrokCalibration.ts`, imported (not retyped) into
  `scripts/runGrokStepCandidate.ts` via `scripts/runGrokStep.ts`'s `SPECS`
  table, so control and candidate text can never drift.

## 6. Frozen regression set

| # | Fixture | Role | Frozen result under `racer/4.0.0`, no gate (control — already collected) |
|---|---|---|---|
| 1 | guitar | mandatory failure-regression | `racer_incorrect`, guessed "musical instrument" — `docs/v2.8-grok-baseline/discovery-10/02-guitar.transcript.json` |
| 2 | Golden Gate Bridge | mandatory failure-regression | `racer_incorrect`, guessed "bridge" — `docs/v2.8-grok-baseline/discovery-10/06-golden-gate-bridge.transcript.json` |
| 3 | chess | mandatory failure-regression | `racer_incorrect`, guessed "tradition" — `docs/v2.8-grok-baseline/discovery-10/08-chess.transcript.json` |
| 4 | platypus | must-not-regress control | `racer_correct` — `docs/v2.8-grok-baseline/discovery-10/05-platypus.transcript.json` |
| 5 | Eiffel Tower | must-not-regress control | `racer_correct` — `docs/v2.8-grok-baseline/calibration/d2-eiffel-tower.grok.transcript.json` |

**Decision: control is NOT re-run.** All five fixtures already have valid,
complete, frozen `racer/4.0.0` transcripts, collected under the identical
provider, pinned model, turn-by-turn architecture, no-tools constraint, and
governance this experiment also requires ("Use the existing frozen fixture
definitions and answer behavior"). Re-running control would (a) spend real
xAI budget reproducing evidence that already exists, and (b) introduce
fresh stochastic variance into the "control" side of the comparison for no
benefit — the existing transcripts are not a summary or a re-derivation,
they are the actual games. This experiment therefore runs the CANDIDATE
side of all five fixtures only (5 new games), and compares each against
its own already-frozen control game. If this reasoning is judged wrong on
review, control can be re-run later without invalidating anything below —
the candidate evidence stands on its own regardless.

## 7. Pre-registered PASS / REVISE / REJECT criteria (written before Game 1)

**Targeted success.** The candidate must eliminate the observed
bare-category / wrong-grain final-guess defect on the three mandatory
failure-regression cases (guitar, Golden Gate Bridge, chess). A blocked
too-broad guess is not sufficient by itself — the Racer must execute the
replacement behavior (§4) and continue discriminating toward a
correctly-grained final answer, not merely stall or repeat the same guess
verbatim after a block.

**Must-not-regress.**
- Platypus and Eiffel Tower must remain `racer_correct`.
- No new material hard-evidence contradiction (A1/A2, per the discovery
  batch's own frozen definitions) may be introduced on any of the 5
  fixtures.
- No catastrophic latency/cost regression caused specifically by the gate
  — i.e. gate calls should not multiply game duration or cost by an order
  of magnitude. A moderate increase (more questions, more calls) from
  legitimately continuing to discriminate after a block is expected and
  acceptable; a runaway loop of repeated blocks on the same guess is not.
- Lower question count is NOT required. More questions are acceptable if
  they prevent an invalid premature final answer — per explicit
  governance, "do not require lower question count."

**REJECT if:**
- Wrong-grain guesses persist materially (the gate fails to catch what it
  was built to catch on the mandatory regression cases), OR
- The gate merely delays the same bad guess without producing useful
  discrimination (blocks, but the replacement question doesn't narrow
  anything, or the very next guess attempt repeats the same blocked
  candidate without new evidence), OR
- A successful control (platypus, Eiffel Tower) materially regresses, OR
- A new severe reasoning-integrity failure appears that was not present in
  the corresponding control game.

**PROMOTION IS NOT PART OF THIS RUN.** Even a clean PASS on every criterion
above stops at: *"candidate passed bounded experiment; eligible for
promotion review."* No merge into shipped RG or Strategy Memory without
explicit human approval — this file, `lib/prompts/racer.ts`, and the
`corpus.racer_guidance_versions`/`corpus.racer_guidance_decisions` tables
are all left exactly as they are regardless of outcome.

## 8. Telemetry plan (repaired before paid execution — Phase 2)

Every candidate-run model call (Racer turns, gate checks, guess-intent
resolutions — all xAI) is captured via `ToolCallResult.diagnostics`
(`lib/providers/xai.ts`, extended with `latencyMs` for this experiment) and
returned in each step's HTTP response
(`GrokStepStatusCandidate.step_diagnostics`,
`scripts/runGrokStepCandidate.ts`). `scripts/runPreviewBenchmark.mjs`'s
`runGrokLoopCandidate()` accumulates every raw step response — including
`gate_activations_this_step` and `step_diagnostics` — into
`docs/v2.8-grok-baseline/candidate-validation-gate/<fixture>.candidate-evidence.json`
after every single step, not only at game end, so an interrupted run (the
discovery batch hit several Vercel Deployment Protection session
expiries) never loses evidence already collected.

This was NOT retrofitted into `corpus.game_turns` — `QuestionLogEntry`
(`lib/types.ts`) has no token/cost columns, and adding them is a schema
migration this experiment does not need and was not asked to make. The
sidecar JSON file per fixture is the durable telemetry record for this
experiment, exactly as the transcript JSON files already are the durable
game record.

Composer calls stay on Anthropic permanently (the measuring instrument,
per `lib/providers/index.ts`) and that adapter does not populate
token/cost diagnostics; Composer-turn latency is still measured
wall-clock so total game duration accounting is complete even where
per-call Composer cost is not. This mirrors the existing, disclosed scope
of the xAI cost-observability work from the discovery batch — Composer
cost was never part of that ask either.

Before any paid regression game: `npm test` green, `npm run check:isolation`
green, `RACER_PROMPT_VERSION === "racer/4.0.0"` verified on this checkout,
candidate provenance verified (`CANDIDATE_VALIDATION_GATE_VERSION` present
and distinct from any `racer/X.Y.Z` string), model pinned to
`grok-4.20-0309-reasoning` for both Racer-turn and gate calls, no
web/X/tools enabled anywhere in this path, same turn-by-turn
accumulated-state execution path as the valid Grok baseline
(`scripts/runGrokStepCandidate.ts` is a direct sibling of
`scripts/runGrokStep.ts`, reusing its `SPECS`/`requireModelBudget`/
`resolveGame`/`toStatus`/`newLogEntry` unmodified), and a minimal smoke
call against the gate itself
(`app/api/internal/benchmark/gate-smoke-test/route.ts`) confirmed working
before spending regression budget.
