# V2.8.x — Required-Target-Grain State Experiment: Evaluation

**Status: complete.** All 5 frozen regression games ran under genuine
`racer/4.0.0` (unmodified), provider `xai`, pinned `grok-4.20-0309-reasoning`,
via the same turn-by-turn architecture as the prior two experiments.
Verdict rendered strictly against the criteria pre-registered in
`docs/v2.8-grok-baseline/grain-state-spec.md` §6, before any game ran.

## 0. Evidence index

| Fixture | Role | Result | Q used | Grain established? | Gate check |
|---|---|---|---|---|---|
| guitar | treatment | `racer_correct` | 18/50 | No — `unset` throughout | `no_check_unset` |
| Golden Gate Bridge | treatment | `racer_correct` | 17/50 | No — `unset` throughout | `no_check_unset` |
| chess | treatment | `composer_win_integrity_upheld` (concede) | 50/50 | No — `unset` throughout | never fired (no guess attempted) |
| platypus | must-not-regress | `racer_correct` | 23/50 | No — `unset` throughout | `no_check_unset` |
| Eiffel Tower | must-not-regress | `racer_correct` | 32/50 | No — `unset` throughout | `no_check_unset` |

Full evidence: `docs/v2.8-grok-baseline/grain-state/*.grain-evidence.json`
(every step, including `grain_established_this_step`/`grain_checks_this_step`,
persisted after each call).

## 1. The central finding

**Probe A and Probe B never matched a single question, on a single turn, in
any of the 5 games.** `required_target_grain` stayed `unset` for the entire
duration of every game — no exceptions, no partial matches, no near-misses.
This is not a coding defect: `lib/prompts/grainState.ts`'s functions were
independently verified against all 12 pre-existing Grok transcripts before
this regression ran (`docs/v2.8-grok-baseline/grain-state-spec.md`'s own
pre-registered survey), which also found zero matches — 17/17 real games
now checked, 0 probe activations.

The mechanism (`checkCandidateGrain`) itself never had anything to compare
a final guess against, so it never blocked, never allowed on merits, and
never had the chance to demonstrate whether a deterministic named-referent
check (the one case it can meaningfully decide, per the spec's own honesty
about generic_type/exact_identity being undecidable by text shape alone)
would have caught Golden Gate Bridge's earlier failure mode. This game's
own Golden Gate Bridge run happened to reach a correct, capitalized,
location-specific guess on its own — good for the game, uninformative for
the mechanism, since nothing tested it.

## 2. Why the probes never fire — observed, not merely predicted

Reading the actual transcripts: Grok's opening strategy consistently
partitions along ontological category (person / animal / plant / physical
object / place / natural phenomenon / abstract concept) and then narrows by
property, exactly as `racer/4.0.0`'s SELECT guidance asks. It essentially
never pauses to ask a meta-question about the target's OWN specificity —
"is this one particular thing or a general kind" is not a move this
strategy's opening or mid-game repertoire produces, in 17 real games
observed across three separate experiments (discovery batch, candidate-gate
regression, this grain-state regression). The two probe families were
deliberately written narrow and precise, per governance ("do not invent
certainty" — a loose probe that fired on unrelated text would be worse than
one that never fires); the cost of that precision is exactly what this
regression demonstrates.

## 3. Must-not-regress outcomes

Both hold. Platypus: `racer_correct` (23q, vs. control's 12q and the
candidate-gate run's 13q — longer this run, still correct; ordinary
stochastic variance in how thoroughly it walked Carnivora sub-families
before reaching monotreme). Eiffel Tower: `racer_correct` (32q, matching
control's 32q exactly). No new hard-evidence contradiction; no mechanism
was ever active to have caused one.

## 4. Chess — a genuinely worse outcome than either prior chess run, unrelated to the mechanism

Chess never reached a guess at all this run — 50 questions of the same
residual-dimension drift the discovery batch and candidate-gate regression
both showed (never asking about games/sport/rules), this time never even
recovering into that dimension late (unlike the candidate-gate run, which
found "sport, game, or competition" at t19). The game timed out its
question budget and conceded. This is **not attributable to the grain-state
mechanism** — the mechanism never activated at any point in this game,
having nothing to check since no guess was ever proposed. It is further,
consistent evidence for the discovery batch's own #2/#3 ranked findings
(D9 persistence, residual-dimension failure), reported here for
completeness, not claimed as new.

## 5. Facts vs. interpretations vs. hypotheses

**Observed facts:**
- 0/5 games in this regression established `required_target_grain`.
- 0/17 games across all three experiments to date (discovery batch,
  candidate-gate, grain-state) have ever matched either probe.
- `checkCandidateGrain` was invoked 0 times against a real candidate in
  this regression — every guess proceeded under `no_check_unset`.
- Both must-not-regress controls held.
- Chess concluded in a forced concede, the first time any chess run in
  this project's history has done so (control: incorrect guess at 34/50;
  candidate-gate: correct at 28/50; this run: concede at 50/50).

**Plausible interpretations:**
- `racer/4.0.0`'s actual questioning repertoire, as currently written,
  does not naturally produce a "kind vs. particular" meta-question — the
  strategy partitions by ontological category and property, never by the
  target's own specificity as a distinct dimension. This is a property of
  the guidance text and the model's trained question-asking habits
  together, not something this experiment can attribute to one or the
  other in isolation.
- Chess's continued difficulty (now three different failure/near-failure
  shapes across three independent runs) suggests this fixture specifically
  exercises a durable weakness — plausibly the same residual-dimension gap
  the discovery batch already ranked #2/#3 — rather than being noise.

**Unproven hypotheses, explicitly not acted on:**
- That broadening the probe patterns would meaningfully increase the
  activation rate without also increasing false positives (untested — no
  broadened variant was built or run, per governance's ban on mid-run
  tuning).
- That a version of this mechanism which DID ask a dedicated specificity
  question (explicitly out of scope — "do not add a new opening
  questionnaire merely to populate the enum") would perform differently.
  This experiment deliberately did not test that design, so it says
  nothing about it either way.

## 6. Verdict, rendered strictly against the pre-registered criteria (spec §6)

**PASS** requires the check to have actually fired on a genuinely-established
grain and produced a correctly-graded outcome. It never fired. **Not met.**

**REJECT** requires the check to have fired and let a wrong-grain guess
through, or a block to have failed to recover. Neither happened, because it
never fired. **Not met.**

**STATE NEVER ESTABLISHED RELIABLY** — the pre-registered condition: "across
all three treatment fixtures, Probe A/B never produces a clean-answer
match — the mechanism had nothing to compare against in any game." Exactly
what happened, on all three treatment fixtures (guitar, Golden Gate Bridge,
chess) and both must-not-regress controls. **Met, cleanly.**

**Rendered verdict: STATE NEVER ESTABLISHED RELIABLY.**

This was the pre-registered expectation (§2 of the frozen spec, based on a
0/12 survey before any candidate game ran) and the regression confirmed it
exactly — 0/5 here, 0/17 overall. Per the frozen spec's own framing, this
is not a disappointing result to explain away: it is the honest answer to
the actual experimental question, "can Barkóba establish this state
naturally enough to be useful." On the evidence collected across 17 real
games, the answer is no, not with these two probe families against
`racer/4.0.0`'s actual play patterns.

Per governance: `racer/4.0.0` untouched, no write to
`corpus.racer_guidance_versions` or `corpus.racer_guidance_decisions`, no
second grain-state version proposed or implemented, D9 not reopened. This
is a completed experiment with a clean, evidence-grounded null result, not
a paused one.
