# M4 — Evaluation & Final Verdict

**Status: COMPLETE.** All six pre-registered games ran, all six transcripts
are preserved in `docs/m4-evidence/`, and a verdict is rendered strictly
against the criteria frozen in `docs/m4-experiment-spec.md` §9, before this
document existed in this form and without amendment to those criteria.

**Execution environment:** Vercel Preview deployments of this repository
(`barkoba2-v2`, team `zvz-x`), reached via this session's Vercel connector
after access was restored. Two branches were deployed:
`claude/m4-ai-play-intelligence-1394d4` (the M4 branch, `racer/4.1.0`) and
`m4-heldout-control-baseline` (a throwaway branch forked from the M3
baseline commit `2ca5f1b`, `racer/4.0.0`, with only the held-out fixture's
files cherry-picked on — created solely to obtain fresh `racer/4.0.0`
control evidence for the held-out target, per §2's run-ordering note; not
part of the M4 branch's own history). Both are Preview deployments only;
neither touched `main` or production.

---

## 0. Evidence index

| Fixture | Guidance | Transcript | Model | Questions | Result |
|---|---|---|---|---|---|
| D-1 (generic backpack) | `racer/4.0.0` (control) | [control-rg-4.0.0/d1-generic-backpack.transcript.json](m4-evidence/control-rg-4.0.0/d1-generic-backpack.transcript.json) | — (frozen M3 evidence) | 49/50 | `racer_correct` |
| D-2 (Eiffel Tower) | `racer/4.0.0` (control) | [control-rg-4.0.0/d2-eiffel-tower.transcript.json](m4-evidence/control-rg-4.0.0/d2-eiffel-tower.transcript.json) | — (frozen M3 evidence) | 42/50 | `racer_correct` |
| Held-out (Mona Lisa) | `racer/4.0.0` (control) | [control-rg-4.0.0/heldout-01-mona-lisa.transcript.json](m4-evidence/control-rg-4.0.0/heldout-01-mona-lisa.transcript.json) | `claude-haiku-4-5-20251001` | 47/50 | `racer_incorrect` |
| D-1 (generic backpack) | `racer/4.1.0` (candidate) | [candidate-rg-4.1.0/d1-generic-backpack.transcript.json](m4-evidence/candidate-rg-4.1.0/d1-generic-backpack.transcript.json) | `claude-haiku-4-5-20251001` | 33/50 | `racer_correct` |
| D-2 (Eiffel Tower) | `racer/4.1.0` (candidate) | [candidate-rg-4.1.0/d2-eiffel-tower.transcript.json](m4-evidence/candidate-rg-4.1.0/d2-eiffel-tower.transcript.json) | `claude-haiku-4-5-20251001` | 29/50 | `racer_incorrect` |
| Held-out (Mona Lisa) | `racer/4.1.0` (candidate) | [candidate-rg-4.1.0/heldout-01-mona-lisa.transcript.json](m4-evidence/candidate-rg-4.1.0/heldout-01-mona-lisa.transcript.json) | `claude-haiku-4-5-20251001` | 18/50 | `racer_correct` |

D-1/D-2 control rows are byte-identical mirrors of the frozen M3 transcripts
— never rerun, per §6 of the spec. The other four are new evidence produced
in this session (timestamps in §1).

## 1. Run timestamps and provenance

| Run | Start (UTC) | End (UTC) | Duration |
|---|---|---|---|
| Held-out control (`racer/4.0.0`) | 2026-08-31T12:43:24Z | 2026-08-31T12:47:26Z | ~4m |
| D-1 candidate (`racer/4.1.0`) | 2026-08-31T13:12:19Z | 2026-08-31T13:15:18Z | ~3m |
| D-2 candidate (`racer/4.1.0`) | 2026-08-31T13:15:31Z | 2026-08-31T13:18:02Z | ~2.5m |
| Held-out candidate (`racer/4.1.0`) | 2026-08-31T15:01:34Z | 2026-08-31T15:03:05Z | ~1.5m |

**Total completed model-backed games this session: 4** (D-1/D-2 controls were
not rerun — reused from M3). **No failed or partial runs occurred** — all
four POSTs returned `HTTP 200` on the first attempt; no retries, no
timeouts, no `502`/`500` responses. Racer provider/model: `anthropic` /
`claude-haiku-4-5-20251001` for all four, matching the frozen fixture specs
(provider/model resolution is server-held, per `lib/prompts/racer.ts`'s
`racerModelFor()` — not something this session or the pre-registered spec
chose).

## 2. Primary D9 measurement — all six games, against the decisive test

*No fourth same-branch sibling probe after three consecutive related NOs.*

### Control (`racer/4.0.0`)

| Fixture | Episode(s) | Consecutive NOs | 4th+ sibling after 3rd NO? | Recovery | D9 (M0 rubric) |
|---|---|---|---|---|---|
| D-1 | t7–t14 | 8 | **Yes** (t10–t14) | t15, parent-frame pivot | Poor (M3, frozen) |
| D-2 | t8–t14 / t17–t24 / t26–t37 | 7 / 8 / 12 | **Yes** (all three) | t15 / t25 / t38 | Poor (M3, frozen) |
| Held-out | none reached 3 (four 2-NO mini-runs: t11–12, t29–30, t33–34, t38–39) | max 2 | N/A — never reached the 3-NO trigger | each mini-run followed by a genuine dimension pivot (t13, t31, t35, t40), not a same-branch sibling | **Good** — new evidence. This fixture's control run simply never produced the severe branch-persistence pattern D-1/D-2 did; it never needed a recovery move to fail |

### Candidate (`racer/4.1.0`)

| Fixture | Episode(s) | Consecutive NOs | 4th+ sibling after 3rd NO? | Recovery | D9 (M0 rubric) |
|---|---|---|---|---|---|
| D-1 | t5–t7 (body-location: head/face/neck, wrist/hand/arm, legs/feet) | 3 | **Yes** — t8 asks a 4th body-location sibling (torso), violating the letter of the new rule | t8 happens to return YES and closes the branch productively; no further siblings tried | **Fair** — one extra same-level sibling tried after the 3-NO run, then the Racer moves off (exact "Fair" rubric shape). Improvement over control's Poor, but the rule itself was still violated once |
| D-2 | t16–t27 (infrastructure-type: dam, transportation, military, water mgmt, tunnel, bridge, utility, weather, energy, entertainment, religious, agricultural) | **12** | **Yes** — repeatedly (t19 is already the 4th sibling; enumeration continues through t27, nine turns past the boundary) | t28, finally | **Poor** — unchanged in kind and magnitude from the worst control episode (also 12 NOs). The new rule was violated as badly here as `racer/4.0.0`'s vague version was |
| Held-out | t6–t8 (object-function: worn on body, container, tool) | 3 | **Yes** — t9 asks a 4th sibling in the same function-type family (decorative), immediately YES | closes on the 4th sibling, same shape as D-1's episode | **Fair** — same pattern as D-1 candidate. This is new: the control run for this exact fixture never even reached 3 NOs (Good), so this is a mild regression in kind, though not in severity |

**Decisive-test verdict: violated in every single candidate episode** — three
out of three, including the two milder "Fair" cases where the violation was
a single extra sibling rather than runaway enumeration. The rule change
(exact "three," mandatory rationale-stated branch/count, recovery move)
measurably shortened the *worst* episodes on two of three fixtures (D-1,
held-out: from unbounded enumeration to exactly one extra sibling) but did
**not** eliminate the violation anywhere, and had **no effect at all** on
D-2's episode, which reproduced the control's worst-case severity exactly.

## 3. Secondary observation — D4 (redundancy), not the target dimension

Per `docs/m4-experiment-spec.md` §1, D4 was deliberately not targeted and no
anti-redundancy text was added. Checked anyway, on all four new transcripts:

- **D-1 candidate:** No clear re-probe of an already-settled dimension. One
  borderline exchange (t28 YES "hold cameras/lenses/photography equipment"
  → t32 NO "a camera bag/photo bag/photography backpack... a ready-to-use
  carrying solution... rather than a protective storage case") tests a
  genuinely different property (use-case framing, not identity) — not
  counted as D4, though flagged under D3 below.
- **D-2 candidate:** No literal re-probe pairs found — the dominant failure
  here is D9 (enumeration), not D4 (restating a settled fact).
- **Held-out candidate:** No re-probe pairs found; narrow, fast-converging
  game (18 questions).
- **Held-out control:** No re-probe pairs found.

**D4 did not recur as a distinct problem in this batch** — a genuinely
different result from M3's 2/2 D4 recurrence, though N=1 per fixture here is
far too small to read as "D4 is fixed." Reported plainly per governance:
this is incidental, not evidence the (untouched) redundancy text improved
anything.

## 4. Regression check — D1, D3, D6, D8 (D2 discussed in §5)

- **D1 (solve outcome).** D-1: `racer_correct` both control and candidate —
  unchanged, Excellent. **D-2: `racer_correct` (control, Excellent) →
  `racer_incorrect` (candidate, Needs work) — a material regression.** The
  candidate's final guess (`Great Wall of China`, t30) also directly
  contradicts an established `KNOWN` fact from its own transcript: t6 had
  confirmed the target is "primarily made of metal" (YES), but the Great
  Wall is predominantly stone/brick — a genuine D3 (evidence consistency)
  Poor-level finding on top of the D1 regression. Held-out: `racer_incorrect`
  (control) → `racer_correct` (candidate) — an *improvement*, not a
  regression, on this fixture.
- **D3 (evidence consistency).** D-2 candidate: Poor, per the metal/Great
  Wall contradiction above — the final guess is incompatible with an
  established earlier answer, the rubric's own Poor-level example. D-1
  candidate: one minor, self-evidently-harmless-looking inconsistency (t28
  YES vs. t32 NO on camera-equipment framing) that did not change the
  trajectory — Good, matching M3 baseline norms. No new D3 issue found on
  the held-out pair.
- **D6 (category/instance discipline).** No regression found. D-1
  candidate's guess (`camera backpack`) is a valid subtype of the
  `generic_type` target, consistent with D-1 control. D-2 candidate's wrong
  guess still correctly attempts to name a `specific_instance` (not a vague
  category) — the granularity discipline itself held even though the guess
  was wrong; that's D1's failure, not D6's.
- **D8 (guess timing).** D-2 candidate is Poor: the guess follows an
  `AMBIGUOUS` answer with 21 of 50 questions still unspent, and no turn
  specifically tested `Great Wall of China` (or any other named rival)
  against the leading hypothesis before guessing — the exact "premature
  conviction" shape the rubric's Poor level describes. This is a regression
  from control D-2's Fair. D-1 and held-out candidates show a real
  discriminator turn immediately before guessing (D-1: t32/t33 test the
  bag-vs-case framing; held-out: t18 explicitly isolates Leonardo by name
  before guessing, textbook Excellent) — no regression there.

**Likely causal link, stated plainly rather than left implicit:** D-2's D1
regression, D3 Poor, and D8 Poor findings are not three independent
failures — they read as one chain. The 12-turn D9 violation (§2) burned
almost half the budget on unproductive same-branch enumeration; by t28 the
Racer had a large but unfocused `KNOWN` list and, under budget pressure,
guessed a structure that fits the vaguest features of that list
(metal-ish, outdoor, monumental) while contradicting a specific one
(material). The D9 failure this experiment targeted is plausibly the root
cause of every other regression found on this fixture, not a separate
defect in the guidance's guess-timing or consistency logic.

## 5. Secondary effect — question efficiency (D2) dropped sharply everywhere

| Fixture | Control questions | Candidate questions | Change |
|---|---|---|---|
| D-1 | 49 | 33 | −33% |
| D-2 | 42 | 29 | −31% |
| Held-out | 47 | 18 | −62% |

Not a pre-registered metric, but too consistent and too large to omit. Every
candidate game converged (correctly or not) using far fewer questions than
its control counterpart. This is consistent with — and may simply be an
artifact of — the SELECT rewording making the Racer's internal bookkeeping
more decisive generally, not narrowly scoped to branch recovery. It cuts
both ways: the held-out fixture's 18-question win looks efficient, but
D-2's 29-question loss looks like the same decisiveness misapplied,
producing a confident wrong guess rather than a careful one. This is
flagged as an open question for any future revision of this text, not
something this experiment's scope authorizes investigating further.

## 6. PASS / REVISE / REJECT

Against `docs/m4-experiment-spec.md` §9, evaluated in order:

**PASS — not met.** Requirement 2 ("obeys the three-NO recovery boundary in
every material episode") fails outright: the decisive test was violated in
all three candidate episodes (§2). Requirement 4 ("no dimension scored
Good/Excellent at baseline regresses to Fair/Poor") also fails: D1 dropped
from Excellent to Needs-work on D-2 (§4).

**REJECT — triggered**, on two independent grounds, either sufficient alone:

1. *"D9 remains materially Poor / unchanged on the trusted benchmark
   rerun."* True for D-2 specifically: 12 consecutive NOs both before and
   after the intervention, same magnitude, same failure shape.
2. *"A material regression occurs on a previously Good/Excellent
   dimension."* True for D1 (solve outcome) and D3 (evidence consistency)
   on D-2, both newly Poor where the control was Excellent/clean.

D-1's genuine improvement (Poor → Fair, §2) and the held-out fixture's
correct final answer are real, and are exactly the kind of partial signal
`docs/m4-experiment-spec.md` §9's REVISE bucket was written to describe
("D-1 improves and D-2 does not"). But REJECT's own bullets are independent
OR-conditions, pre-registered before any result existed, and two of them
are unambiguously satisfied by D-2's evidence alone. Honoring the criteria
as written — the entire point of pre-registering them — means REJECT, not a
softened REVISE, even though part of the evidence points the right
direction.

## `racer/4.1.0` VERDICT: **REJECT**

`racer/4.1.0`'s SELECT rewording measurably shortened branch-persistence
failures on two of three fixtures but did not reliably enforce the
three-NO boundary anywhere, left one fixture (D-2) exactly as broken as
`racer/4.0.0`, and that unfixed fixture also regressed on solve outcome and
evidence consistency — plausibly as a direct downstream consequence of the
same unresolved D9 failure (§4). `racer/4.0.0` remains the shipped guidance.
No promotion decision is implied or requested by this verdict; per
governance, that stays a separate, explicit conversation with Zsolt.

`NOT EVERY FAILURE BECOMES A RULE` cuts the other way here too: this REJECT
does not itself license a new, larger rewrite. The next step, if any, is
Zsolt's call.
