# V2.8.x — Required-Target-Grain State Experiment: Frozen Spec

**Status: frozen before Game 1.** Lab work only, on the experimental branch.
Does not touch `racer/4.0.0`, the live Human↔AI seat, or `main`.

## 0. Hypothesis, restated precisely

The rejected candidate-validation gate (`docs/v2.8-grok-baseline/candidate-validation-gate-evaluation.md`)
showed the block-and-replace *mechanism* works when the semantic judgment
behind it is correct, and fails when that judgment is wrong (Golden Gate
Bridge: the gate re-derived the same category-for-referent error the Racer
made, from scratch, at guess time). The next narrow hypothesis: if the
required grain is established **earlier**, from **hard play evidence**, and
carried as **state**, a final-guess check can *compare* against that state
instead of re-inferring it from nothing at guess time — removing the exact
failure mode that sank the rejected gate.

This is a state-plumbing experiment, not a smarter-judge experiment. No LLM
call judges anything in this cycle. Every decision below is a deterministic
function of already-existing evidence.

## 1. The experimental enum

```
type RequiredTargetGrain = "generic_type" | "named_referent" | "exact_identity" | "unset";
```

These are **experimental operational labels only**, distinct from the
existing `TargetGranularity` (`generic_type` | `specific_instance`) the
Composer/Adjudicator already use — this enum is a finer three-way split of
what that type calls `specific_instance`, and it is never read from or
written to `TargetGranularity`, the secret record, or any fixture
definition. It is derived **only** from the public transcript, exactly as
the Racer itself sees it.

No fixture→grain lookup table exists anywhere in the implementation. The
mission's own worked examples (guitar→generic_type, Golden Gate
Bridge→named_referent, chess→exact_identity) are illustrations of what the
mechanism is *trying* to detect, never inputs to it.

## 2. B2 — establishing grain from existing play evidence

**Two independent, pre-registered, deterministic probes** applied to the
Racer's own QUESTION text as it appears in the transcript — never to
`guess_text`, never to the Composer's answer content (which carries no text
beyond an optional `ambiguous_explanation`). Both probes are regex-based,
in the same style and file family as `lib/guessDetector.ts`'s existing
definiteness/candidate-identification machinery, because that is the
"particular-vs-kind" discriminator this codebase already has — reused here
in spirit and construction, not literally imported, because it is built to
classify a different text shape (declarative guess frames, not open
specificity probes).

**Probe A — kind-vs-particular** (does the target's IDENTITY TYPE itself
get asked about):
```
/\bis (?:it|the target) (?:a )?(?:general|generic) (?:type|kind|category)(?:,| |\?)/i
/\bis (?:it|the target) one (?:specific|particular|singular|individual) (?:thing|instance|example|item)\b/i
/\bwould any (?:example|instance|member) of (?:its|the|that) (?:kind|category|type) count\b/i
/\bis (?:it|the target) a specific,? one[- ]of[- ]a[- ]kind\b/i
/\bis (?:it|the target) (?:a )?unique,? one[- ]of[- ]a[- ]kind\b/i
```
A YES on a "generic/type/kind" framing (patterns 1, 3) → leans
`generic_type`. A YES on a "specific/particular/individual/one-of-a-kind"
framing (patterns 2, 4, 5) → leans "specific" (provisional; see Probe B).
A NO inverts the lean. AMBIGUOUS, or no match anywhere in the transcript →
Probe A never resolves.

**Probe B — named vs unnamed specific** (only evaluated if Probe A
resolved "specific"): does the target have a recognizable proper name?
```
/\bdoes (?:it|the target) have a (?:proper|well[- ]known|specific|formal) name\b/i
/\bis (?:it|the target) (?:commonly |widely |generally )?known by (?:a specific |its own )?name\b/i
/\bwould (?:most|many) people recognize (?:it|the target) by name\b/i
/\bdoes (?:it|the target) have an? official (?:title|designation|name)\b/i
```
YES → `named_referent`. NO → `exact_identity`. Never asked, or AMBIGUOUS →
Probe A's "specific" lean stays **unresolved down to its sub-type**, and
the overall state is `unset` — per governance, this is not "invent
`exact_identity` as the default narrower reading"; it is a genuinely
unestablished sub-classification.

**Locking rule.** The first turn, in transcript order, where a probe
matches AND receives a clean YES/NO (not AMBIGUOUS) sets the state. Once
set, later turns never overwrite it — "established earlier in the game,
carried as state," not re-derived every turn. If no probe ever matches
with a clean answer, state stays `unset` for the whole game.

**Pre-registered expectation, stated honestly before Game 1.** A survey of
all 12 completed Grok transcripts collected so far (the 10-game discovery
batch + 2 calibration games) found **zero** naturally-occurring questions
matching either probe set. This experiment is not expected to fire often.
That is a legitimate anticipated result, not a flaw to route around before
running it — see §6, "state never established reliably" is a first-class
verdict, not a failure mode.

## 3. B3 — final-guess use

**The validator never reinvents the grain classification.** It only
compares `candidate` (the proposed `guess_text`) against the ALREADY
-DERIVED `required_target_grain`, using a check whose power is
deliberately bounded by what is actually decidable from text shape alone
— stated honestly rather than papered over with an LLM call, which would
revive the rejected gate.

| `required_target_grain` | Check performed | Basis |
|---|---|---|
| `unset` | **None.** Recorded as `no_check_unset`. Guess proceeds unblocked. | Nothing to compare against; blocking here would be inventing certainty. |
| `named_referent` | **Deterministic.** `grain_ok` = candidate text contains a capitalized proper-noun-shaped span (reusing `lib/guessDetector.ts`'s own capitalization + digit + `CAPITALIZED_PREDICATE_STOPWORDS` logic, applied to the bare candidate text directly rather than requiring the "is it the X" question frame `namesABareCandidate` needs). "Golden Gate Bridge" passes; "bridge" fails. | Proper-namedness is a genuine, domain-general textual signal — the one case where a purely mechanical check is legitimate. |
| `exact_identity` | **Not decidable.** Recorded as `not_deterministically_decidable`. Guess proceeds unblocked. | "chess" vs "tradition" are both lowercase common nouns; no textual signal separates a correctly-grained exact-identity answer from an overly broad one without semantic judgment, which this experiment does not use. |
| `generic_type` | **Not decidable.** Recorded as `not_deterministically_decidable`. Guess proceeds unblocked. | Same reason: "guitar" vs "musical instrument" are both lowercase common nouns; the failure that sank the original discovery-batch finding is exactly this pair, and no capitalization-style signal separates them. |

**Consequence, stated up front:** this mechanism can only ever *block*
something on a `named_referent`-state game — i.e., only on the Golden Gate
Bridge fixture, and only if Probe A+B actually fired earlier in that
specific playthrough. Given §2's honest expectation, that may not happen.
This is not a weakness introduced to guarantee a pass; it is the
consequence of refusing to invent a semantic judge for the two grains
where no deterministic signal exists. It directly tests whether *this*,
narrower mechanism earns its keep, without smuggling the rejected gate
back in under a new name.

**On block:** the driver does not author a replacement question (that
would be a second candidate-gate prompt). It re-invokes the ordinary
Racer-turn generation once, on the unchanged transcript, and accepts
whatever comes back — including, if the model still guesses the exact same
bare category, the same blocked outcome recorded a second time (capped at
one retry, then accepted as final either way, so the driver cannot loop).
A repeated wrong-grain guess after one retry is an honest REJECT-shaped
result per §6, not hidden.

## 4. Boundary

Not touched: `racer/4.0.0`, D9, ontology, RG prose, the rejected
candidate-validation-gate prompt/module, production, `main`, Strategy
Memory. No new opening question is added to CORE_RACER_RULES or the system
prompt — Probes A/B only ever *observe* text the Racer already produces
under unmodified `racer/4.0.0`; they never prompt for it.

## 5. Frozen five-fixture run

Same five as the rejected-gate experiment, same roles, same reused control
evidence, same pinned model (`grok-4.20-0309-reasoning`), same turn-by-turn
architecture, D9 frozen, no mid-run tuning:

| # | Fixture | Role |
|---|---|---|
| 1 | guitar | treatment |
| 2 | Golden Gate Bridge | treatment |
| 3 | chess | treatment |
| 4 | platypus | must-not-regress |
| 5 | Eiffel Tower | must-not-regress |

## 6. Verdict criteria, pre-registered before Game 1

**PASS requires ALL of:**
- On every treatment fixture where grain was genuinely established
  (Probe A/B fired on a clean answer, before the final guess), the final
  guess satisfies that grain — for `named_referent`, this means the
  deterministic check actually blocked a bare-category attempt and the
  game went on to land a properly-grained, capitalized-referent guess.
- State was established from real play, never retrofitted from the final
  candidate or the known fixture identity — mechanically guaranteed here
  since Probe A/B only ever read from the transcript that existed *before*
  the guess turn.
- platypus and Eiffel Tower remain `racer_correct`.
- No new material reasoning-integrity regression.

**REJECT if:** state was established at least once, the check fired, and
still let a wrong-grain guess through, or a blocked guess was followed by
another wrong-grain guess after the one retry, or a must-not-regress
control failed.

**STATE NEVER ESTABLISHED RELIABLY if:** across all three treatment
fixtures, Probe A/B never produces a clean-answer match — the mechanism
had nothing to compare against in any game, so no PASS/REJECT claim about
the *comparison* mechanism can be honestly made. Per §2, this is the
pre-registered expectation, not a disappointing outcome to explain away.

A correct final guess reached without the state ever being established, or
without the check ever activating, is not evidence for the mechanism —
exactly the same discipline applied to chess's stochastic improvement in
the rejected-gate evaluation.

## 7. Telemetry

Same repaired per-call observability as the rejected-gate experiment
(`lib/providers/xai.ts` diagnostics, `latencyMs` included), extended with:
grain-state transitions (which turn, which probe, which answer, the
resulting state), every final candidate and its grain-check outcome
(`allow` / `block` / `not_deterministically_decidable` / `no_check_unset`),
and any retry triggered by a block. Persisted the same way as before — a
JSON sidecar per fixture under `docs/v2.8-grok-baseline/grain-state/`,
written after every step so an interrupted run loses no evidence.
`cost_in_usd_ticks` reported raw; no dollar conversion invented.
