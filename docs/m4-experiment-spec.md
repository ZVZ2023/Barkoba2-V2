# M4 — Pre-Registered Experiment: D9 Branch-Recovery Intervention

**Status:** Pre-registration. Frozen BEFORE `racer/4.1.0` was implemented and
BEFORE any candidate transcript — trusted or held-out — was produced or
inspected. Nothing in this document may be edited after a candidate result is
seen; a change of scope after that point goes in a new, dated addendum, never
a silent edit to the sections below.

**Authorization:** Local implementation, local benchmark execution, and local
scoring only. No push, PR, merge, promotion, or write to
`corpus.racer_guidance_decisions` is authorized by this document. This
document itself is not a promotion decision.

---

## 1. Scope decision

**One recurring material failure → one bounded intervention.** M4's targeted
dimension is **D9 (Recovery from a bad branch) only.**

D4 (Redundancy) is explicitly **not** targeted in this experiment, even though
the M3 baseline ranked it the #1 finding and even though the mechanism
considered for D9 could plausibly also help D4 (both were hypothesized in the
pre-implementation analysis to share a root cause: failure to make
"already-settled" state explicit rather than implicit). Combining them here
would weaken causal attribution — if both dimensions moved, it would be
impossible to say which textual change caused which effect. D4 is carried
forward as a **regression / secondary-observation dimension only**: scored on
every transcript this experiment produces, reported honestly if it moves, but
never used as a basis for the PASS/REVISE/REJECT verdict, and no new
anti-redundancy text is added to `racer/4.1.0` on the strength of any
incidental D4 movement.

D2, D6, D7, D8 are likewise not targeted (per the M3 ranked findings: D7 is
N=1/unconfirmed, D2/D6/D8 show no consistent 2/2 signal). They are scored as
regression dimensions only, per §6.

## 2. Frozen control vs. candidate

| | Guidance identity | Source |
|---|---|---|
| **Control** | `racer/4.0.0` | [lib/prompts/racer.ts](../lib/prompts/racer.ts) as of commit `2ca5f1b` (M3 baseline close) — unmodified |
| **Candidate** | `racer/4.1.0` | Same file, one bounded addition to the `SELECT` paragraph of `CORE_RACER_RULES` — see §4 for the exact diff |

Both versions are provider-neutral, single-call, no new schema field, no new
backend architecture — consistent with every prior RG #3/#4 pass
(`racer/3.0.0` → `racer/4.0.0`).

## 3. Hypothesis

**Target behavior.** After the Racer has accumulated a short run of related
`NO` answers while exploring sibling hypotheses inside the same branch, it
must stop enumerating siblings and deliberately step back — test the parent
frame, or pivot to a materially different discriminating dimension.

**Diagnosis carried forward from the M3 baseline analysis.** `racer/4.0.0`
already states this rule in `SELECT`: *"After two or three related NOs on the
same branch, stop... and ask whether the parent frame itself is wrong before
trying more siblings."* The M3 evidence shows this rule was **violated, not
missing** — D-1 ran to 8 consecutive same-branch NOs (t7–t14) and D-2 ran to
as many as 12 (t26–t37) before either fixture stepped back. The rule is
descriptive preference, held as silent internal state (*"hold this state
internally. Emit only the resulting question or guess"*) with no forcing
function that makes violating it visible or costly at generation time. This
is the same failure shape RG #3's own history already documents once before
(`racer/3.0.0`→`3.1.0`, §47 of
[docs/DESIGN-NOTES.md](DESIGN-NOTES.md): "descriptive preference proved too
weak" for the geography-enumeration case, fixed by making the same class of
rule an explicit, numbered gate rather than a soft preference).

**Hypothesis.** Replacing the vague threshold ("two or three") with an exact,
countable boundary ("three"), and requiring the Racer to state the branch and
its NO-count in its own `rationale` once the boundary is reached, will make
the existing recovery rule operational rather than aspirational, measurably
reducing same-branch sibling runs past three NOs without a parent-frame
test or dimension pivot.

## 4. Exact intervention text (diff)

Only the `SELECT` paragraph of `CORE_RACER_RULES` changes. Every other
paragraph (`KNOWN`, `UNKNOWN`, `HYPOTHESES`, `RED FLAGS` — including its
redundancy bullet, which is D4's territory and stays untouched — and
`BEFORE ANY FINAL GUESS`) is byte-identical to `racer/4.0.0`.

```diff
 SELECT
-Prefer the question that most usefully divides current HYPOTHESES over one that only confirms the leader. A broad split across an unresolved dimension beats naming siblings one at a time. After two or three related NOs on the same branch, stop — that is a signal, not a coincidence — and ask whether the parent frame itself is wrong before trying more siblings.
+Prefer the question that most usefully divides current HYPOTHESES over one that only confirms the leader. A broad split across an unresolved dimension beats naming siblings one at a time. After three related NOs on one branch, the next question must not be a fourth sibling there — name the branch and NO-count in rationale, then test the parent frame or pivot dimensions.
```

(Trimmed to hold `CORE_RACER_RULES` at exactly 400 words, `racer/4.0.0`'s own upper bound — see `test/racerGuidance.test.ts`'s "RG #4 is under 400 words" test. The compression discipline `racer/4.0.0` was built around is a real constraint this diff respects, not just a target's own past decision.)

`RACER_PROMPT_VERSION` moves from `"racer/4.0.0"` to `"racer/4.1.0"`. The RG
history comment block above it gains one new dated entry (this section);
no existing history comment is edited. `RACER_SYSTEM_PROMPT`,
`GUESS_INTENT_SYSTEM_PROMPT`, both schemas, `assertGuidanceApplied`, and every
call site are untouched — the experimental variable stays isolated to the
trailing block, matching every prior RG pass.

## 5. Model / provider / fixture identity

| | Value |
|---|---|
| Racer provider | `anthropic` (identical to D-1/D-2) |
| Racer model | `env.modelRacer()` — whatever `ANTHROPIC_MODEL_RACER` resolves to at run time; recorded per-run, not pinned in this document, per the existing D-1/D-2 convention (`provenance.model_id` is captured on every turn) |
| `max_questions` | 50 |
| `difficulty` | `medium` |
| `game_language` | `en` |
| Composer | AI Composer, `answerAsComposer` — same function both D-1 and D-2 already use |

**Trusted benchmark (regression pair):**
| | `benchmark_case_id` | Target | Granularity |
|---|---|---|---|
| D-1 | `m1-d1-generic-backpack` | "a backpack" | `generic_type` |
| D-2 | `m3-d2-eiffel-tower` | "the Eiffel Tower" | `specific_instance` |

**Held-out fixture (frozen before any candidate result is seen):**
| | `benchmark_case_id` | Target | Granularity |
|---|---|---|---|
| D-3 | `m4-d3-mona-lisa` | "the Mona Lisa" | `specific_instance` |

D-3 was not used to design, motivate, or word the `racer/4.1.0` diff in §4 —
it was selected after the diff was written, for domain distance from both
D-1 (a worn/carried object) and D-2 (a public monument/structure): a specific
fine-art object, a domain with its own dense sibling taxonomy (painting vs.
sculpture vs. tapestry vs. manuscript; artist, era, museum, movement) capable
of producing the same sibling-enumeration shape D-1 and D-2 both showed,
under a materially different subject. Full frozen spec:
[scripts/runD3Fixture.ts](../scripts/runD3Fixture.ts). In evidence paths
(§10) this fixture is filed as `heldout-01-mona-lisa` — numbered rather than
named `d3-...` because the held-out set is sized to what M4 actually needs
("minimum defensible held-out set"), not fixed at exactly one member; a
future milestone that adds a second held-out target would file it as
`heldout-02-<name>` alongside this one without renumbering.

**Existing fixture inventory checked before creating D-3:** only D-1
(`app/api/internal/benchmark/d1-generic-backpack/route.ts`) and D-2
(`app/api/internal/benchmark/d2-eiffel-tower/route.ts`) existed prior to M4.
No unused held-out fixture was available, so D-3 was created new rather than
selected from an existing inventory.

## 6. Runs required

Six total games — three fixtures × two guidance versions:

| Fixture | `racer/4.0.0` (control) | `racer/4.1.0` (candidate) |
|---|---|---|
| D-1 | already exists — [docs/m3-evidence/d1-generic-backpack.transcript.json](m3-evidence/d1-generic-backpack.transcript.json), frozen, never rerun or reinterpreted | new run required |
| D-2 | already exists — [docs/m3-evidence/d2-eiffel-tower.transcript.json](m3-evidence/d2-eiffel-tower.transcript.json), frozen, never rerun or reinterpreted | new run required |
| D-3 | new run required (control evidence for the held-out fixture) | new run required |

The D-1/D-2 `racer/4.0.0` transcripts are **historical control evidence** and
are never re-executed, overwritten, or rescored under a different reading —
only `racer/4.1.0`'s D-1/D-2 reruns are new evidence, compared against the
existing frozen baseline scores in
[docs/m3-baseline-evaluation.md](m3-baseline-evaluation.md).

D-3 needs both versions run fresh, since no `racer/4.0.0` evidence exists for
it yet — without a same-fixture control, a `racer/4.1.0`-only D-3 result would
show what the candidate did but not what the control would have done on the
identical target, which is the actual held-out comparison this document
requires.

## 7. Primary measurement (D9)

For every transcript produced (all six games), for each run of two or more
consecutive `NO` answers to same-branch sibling questions, record:

1. Turn index the streak begins at.
2. Number of consecutive related NOs in the streak.
3. Whether a fourth (or later) same-branch sibling was asked after the third
   NO — the literal target-behavior violation.
4. Whether the Racer instead performed a parent-frame test or a pivot to a
   materially different dimension, and at which turn.
5. The D9 level this episode earns under
   [docs/racer-scorecard.md](racer-scorecard.md) §5.9, unmodified.

**The single decisive behavioral test:** *no fourth same-branch sibling probe
after three consecutive related NOs, in any episode, in any `racer/4.1.0`
transcript.* One counter-example in a material episode does not
automatically fail the candidate (§9 REVISE), but it must be reported, cited,
and weighed honestly against the control's own performance on the same
fixture.

The M0 scorecard (`docs/racer-scorecard.md`) is not redefined, extended, or
reinterpreted to favor the candidate. D9 is scored exactly as written in §5.9.

## 8. Regression dimensions

Every dimension the M0 scorecard defines (D1–D8, D9 as primary) is scored on
every new transcript, using the scorecard exactly as written — no new rubric
text, no new level, no threshold change. Two are watched with particular
care because the M3 baseline already found them Good/Excellent and a
regression there would be a direct cost of the D9 change:

- **D2 (question efficiency).** SELECT is the exact paragraph both D2 and D9
  read from; a wording change there is the most plausible place an
  unintended D2 side effect could appear.
- **D4 (redundancy).** Explicitly not targeted (§1) — reported as a secondary
  observation only, never as evidence the intervention worked or as grounds
  to add new redundancy text to `racer/4.1.0`.

## 9. PASS / REVISE / REJECT criteria (fixed before any candidate result exists)

**PASS** requires all four:
1. D9 materially improves versus `racer/4.0.0` on the trusted benchmark (D-1
   and D-2 reruns) — concretely, the level assigned under §5.9 rises by at
   least one full grade on at least one of the two, with neither dropping.
2. The candidate obeys the three-NO recovery boundary (§7's decisive test) in
   every material bad-branch episode found in the D-1/D-2 reruns — "material"
   meaning an episode that reached three or more related NOs at all under the
   control.
3. The D-3 held-out comparison (`racer/4.0.0` vs. `racer/4.1.0`, same target)
   supports the same direction of improvement — it does not need to match
   the trusted-benchmark magnitude, but it must not contradict it (e.g. the
   candidate must not perform a same-branch enumeration violation on D-3 that
   the D-1/D-2 reruns do not also show being fixed).
4. No dimension scored Good or Excellent in the M3 baseline (D1, D3, D5, D6,
   D8) regresses to Fair or Poor on either trusted-benchmark rerun.

**REVISE** applies when the D9 signal moves in the right direction but is
inconsistent — e.g. D-1 improves and D-2 does not, the D-3 held-out result
disagrees with the trusted benchmark, or the recovery mechanism fires in some
episodes but not others without an evident cause. REVISE means iterate the
wording (e.g. strengthen "state the branch and its NO-count" into a harder
gate) — it does not mean declare PASS on partial evidence, and it does not
mean expand scope to D4/D7/D2 in the same pass.

**REJECT** applies if any of:
- D9 remains materially Poor / unchanged on the trusted benchmark rerun.
- The candidate obeys the letter of the boundary but the underlying failure
  simply relocates (e.g. a fourth sibling never occurs, but the parent-frame
  test/pivot itself is low-information or circles back to another sibling
  one turn later).
- A material regression occurs on a previously Good/Excellent dimension.
- The D-3 held-out evidence contradicts the trusted-benchmark improvement.

`NOT EVERY FAILURE BECOMES A RULE.` A REVISE or REJECT verdict here does not
license inventing a new gate outside D9's own territory to compensate.

## 10. Evidence locations (to be filled in as runs happen, never edited
retroactively — new evidence is appended, not substituted)

The durable evidence root is `docs/m4-evidence/`, split by guidance version —
`control-rg-4.0.0/` and `candidate-rg-4.1.0/` — so every game this milestone
touches is permanently reviewable in one place, independent of whether the
live corpus database also holds a copy. Git, not the database, is the
canonical scientific record for M4 (per addendum, see bottom of this
section).

| Run | Transcript | Status |
|---|---|---|
| D-1, `racer/4.0.0` | [docs/m4-evidence/control-rg-4.0.0/d1-generic-backpack.transcript.json](m4-evidence/control-rg-4.0.0/d1-generic-backpack.transcript.json) | Existing, frozen — byte-identical mirror of [docs/m3-evidence/d1-generic-backpack.transcript.json](m3-evidence/d1-generic-backpack.transcript.json), never rerun |
| D-2, `racer/4.0.0` | [docs/m4-evidence/control-rg-4.0.0/d2-eiffel-tower.transcript.json](m4-evidence/control-rg-4.0.0/d2-eiffel-tower.transcript.json) | Existing, frozen — byte-identical mirror of [docs/m3-evidence/d2-eiffel-tower.transcript.json](m3-evidence/d2-eiffel-tower.transcript.json), never rerun |
| D-1, `racer/4.1.0` | `docs/m4-evidence/candidate-rg-4.1.0/d1-generic-backpack.transcript.json` (path reserved) | **Not yet run — blocked, see §11** |
| D-2, `racer/4.1.0` | `docs/m4-evidence/candidate-rg-4.1.0/d2-eiffel-tower.transcript.json` (path reserved) | **Not yet run — blocked, see §11** |
| Held-out 01 (Mona Lisa), `racer/4.0.0` | `docs/m4-evidence/control-rg-4.0.0/heldout-01-mona-lisa.transcript.json` (path reserved) | **Not yet run — blocked, see §11** |
| Held-out 01 (Mona Lisa), `racer/4.1.0` | `docs/m4-evidence/candidate-rg-4.1.0/heldout-01-mona-lisa.transcript.json` (path reserved) | **Not yet run — blocked, see §11** |

See [docs/m4-evaluation.md](m4-evaluation.md) for the live index of every
evaluated run, the real D9 measurement already computable from the two
existing control transcripts, and the full explanation of why the four
"not yet run" rows above are currently blocked.

## 11. Evidence-preservation addendum (post-registration, appended per Zsolt's
instruction — does not alter §1–§10 above)

Every control and candidate game used in M4 must be permanently reviewable
after the session, as raw transcripts — not only scores or summaries — with
turn sequence, answers, rationale where available, final result,
model/provider identity, Racer Guidance version, fixture identity,
game/benchmark run identifiers, and budget/environment provenance. This is
satisfied by the `docs/m4-evidence/{control-rg-4.0.0,candidate-rg-4.1.0}/`
structure above: it is the canonical scientific record for this milestone
even where the benchmark machinery also writes a game record to the live
corpus database. No transcript file is ever fabricated or hand-written to
fill an empty row — an unrun game is recorded as **not yet run**, never
represented by placeholder data.

---

**This document is frozen at the point above.** Any change made after a
candidate transcript has been produced or inspected must be recorded as a
dated addendum below this line, never as a silent edit above it.
