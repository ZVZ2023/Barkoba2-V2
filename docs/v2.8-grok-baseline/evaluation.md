# V2.8.x — Grok Baseline: Calibration + 10-Game Discovery Evaluation

**Status: complete.** All 2 calibration games and all 10 discovery games ran
under genuine frozen `racer/4.0.0`, provider `xai`, pinned
`grok-4.20-0309-reasoning`. Analysis performed only after Game 10, per
governance. Claude M1/M3/M4 evidence is never mixed statistically with this
population — every comparison below is qualitative, side-by-side, never a
pooled number.

## 0. Evidence index

| Run | Guidance | Transcript | Result | Questions |
|---|---|---|---|---|
| Smoke test | racer/4.1.0 (not evidence) | [provider-smoke/smoke-test-result.json](provider-smoke/smoke-test-result.json) | n/a | 1 call |
| Calibration D-1 (backpack) | racer/4.0.0 | [calibration/d1-generic-backpack.grok.transcript.json](calibration/d1-generic-backpack.grok.transcript.json) | `racer_incorrect` | 18/50 |
| Calibration D-2 (Eiffel Tower) | racer/4.0.0 | [calibration/d2-eiffel-tower.grok.transcript.json](calibration/d2-eiffel-tower.grok.transcript.json) | `racer_correct` | 32/50 |
| Discovery 1 (wristwatch) | racer/4.0.0 | [discovery-10/01-wristwatch.transcript.json](discovery-10/01-wristwatch.transcript.json) | `racer_correct` | 11/50 |
| Discovery 2 (guitar) | racer/4.0.0 | [discovery-10/02-guitar.transcript.json](discovery-10/02-guitar.transcript.json) | `racer_incorrect` | 12/50 |
| Discovery 3 (Great Sphinx) | racer/4.0.0 | [discovery-10/03-great-sphinx.transcript.json](discovery-10/03-great-sphinx.transcript.json) | `racer_correct` | 20/50 |
| Discovery 4 (Titanic) | racer/4.0.0 | [discovery-10/04-titanic.transcript.json](discovery-10/04-titanic.transcript.json) | `racer_correct` | 13/50 |
| Discovery 5 (platypus) | racer/4.0.0 | [discovery-10/05-platypus.transcript.json](discovery-10/05-platypus.transcript.json) | `racer_correct` | 12/50 |
| Discovery 6 (Golden Gate Bridge) | racer/4.0.0 | [discovery-10/06-golden-gate-bridge.transcript.json](discovery-10/06-golden-gate-bridge.transcript.json) | `racer_incorrect` | 14/50 |
| Discovery 7 (Rosetta Stone) | racer/4.0.0 | [discovery-10/07-rosetta-stone.transcript.json](discovery-10/07-rosetta-stone.transcript.json) | `racer_correct` | 33/50 |
| Discovery 8 (chess) | racer/4.0.0 | [discovery-10/08-chess.transcript.json](discovery-10/08-chess.transcript.json) | `racer_incorrect` | 34/50 |
| Discovery 9 (rubber duck) | racer/4.0.0 | [discovery-10/09-rubber-duck.transcript.json](discovery-10/09-rubber-duck.transcript.json) | `racer_correct` | 22/50 |
| Discovery 10 (Antarctica) | racer/4.0.0 | [discovery-10/10-antarctica.transcript.json](discovery-10/10-antarctica.transcript.json) | `racer_incorrect` | 17/50 |

**Discovery batch record: 6/10 correct.** Calibration: 1/2 correct.

## 1. Cross-game table

| # | Fixture | Type | Result | Q used | Final guess | A1/A2 | D9 incident | Notable recovery |
|---|---|---|---|---|---|---|---|---|
| 1 | wristwatch | generic | correct | 11 | wristwatch | none | none | — |
| 2 | guitar | generic | **incorrect** | 12 | **"musical instrument"** | none | none | — |
| 3 | Great Sphinx | specific | correct | 20 | Great Sphinx of Giza | none | **yes** — t14–16 (Europe/Americas/Asia NO), t17 Africa = 4th sibling | resolved productively at t17 |
| 4 | Titanic | specific | correct | 13 | RMS Titanic | none | none | — |
| 5 | platypus | generic | correct | 12 | platypus | none | **avoided** — t5–7 (Carnivora/rodent/primate NO), t8 tests parent frame ("placental mammal?") instead of a 4th order | **Excellent-shaped**: genuine parent-frame test after exactly 3 NOs |
| 6 | Golden Gate Bridge | specific | **incorrect** | 14 | **"bridge"** | none | none | — |
| 7 | Rosetta Stone | specific | correct | 33 | Rosetta Stone | none | **severe** — t18, t20–24 (metal/wood/plastic/glass/fabric NO), stone YES at t24 = 5th+ sibling | resolved at t24, but very late |
| 8 | chess | specific | **incorrect** | 34 | **"tradition"** | **A1-shaped, sustained** — t7 hard NO to "abstract concept," t8–t33 (26 turns) test subtypes/adjacent framings of "concept" anyway | related sibling/branch pattern, but framed as sustained premise violation rather than pure enumeration | none — never recovered |
| 9 | rubber duck | generic | correct | 22 | rubber duck | none | none | — |
| 10 | Antarctica | specific | **incorrect** | 17 | **"glacier"** | none (near-miss, not contradiction) | none — but "continent"/"landmass" as an explicit category was never tested at all | — |

**AMBIGUOUS answers across all 10 discovery games: zero.** A sharp contrast
with the Claude M3 D-1 baseline (24/49 questions AMBIGUOUS). Observed fact,
not interpreted further — F (AMBIGUOUS handling) is N/A for this entire
batch; nothing to score.

**D4 redundancy:** one clear instance found, inside game 8's larger failure
— t16 ("a conceptual framework about society or culture?") and t17 ("a
concept pertaining to society or culture?") are near-paraphrases of each
other, both already subsumed by the t7 contradiction. Not elevated to a
primary finding on its own (N=1, embedded in a larger failure), per
governance.

## 2. D1–D9 scoring — what was rigorously checked vs. not

Full M0 turn-by-turn scoring on all nine dimensions for all 12 games was not
attempted in this pass — stated honestly rather than implied. What was
checked with turn-level rigor, across every game: **D1** (solve outcome —
table above), **D6** (category/instance discipline — table above, granularity
column), **D9** (per the frozen 3-NO operational definition — table above),
and **D3/A1–A2** (hard-evidence contradiction — table above). These four are
the dimensions this batch's own governance made primary. **D2, D4, D5, D7,
D8** were observed opportunistically during play (noted where something
surfaced — game 7's length, game 8's severity, the single D4 instance) but
not exhaustively re-verified turn-by-turn for every game; a claim of
complete scoring on those three would be false precision this batch's own
evidence-honesty standard does not permit.

## 3. Ranked failure taxonomy — recurrence × materiality × causal reach

### #1 — Bare-category final guess (highest-ranked)

**Recurrence: 3/10 discovery games (30%)** — games 2, 6, 8. Also the
dominant pattern across the two calibration games' one loss was a wrong
*specific* guess (Great Wall of China for D-2... no, correction: D-1
calibration's wrong guess was a specific wrong garment path, not a bare
category — this pattern is specific to the discovery batch).

**What it is:** the final guess names a bare parent category
("musical instrument," "bridge," "tradition") rather than the actual target
— for `generic_type` game 2, one level broader than even the category the
fixture asks for; for `specific_instance` games 6 and 8, far too broad to
ever be adjudicated correct per the M0 D6 rubric's own Poor-level
definition ("too broad for a specific_instance target").

**Materiality: maximum.** Directly and solely caused the loss in all three
instances — this is not a contributing factor, it *is* the failure.

**Causal reach: maximum.** It is the terminal decision of the entire game;
no other turn downstream can compensate for it.

**This is the single clearest, most actionable, cross-game recurring
pattern this batch produced.**

### #2 — D9 bad-branch persistence (moderate-ranked)

**Recurrence: 2 clean instances (games 3, 7), 1 related-but-distinct
instance (game 8's sustained premise violation is D9-adjacent but scored
separately as A1 above).** Confirms the exact same failure shape the M3
Claude baseline and M4 Grok-vs-Claude comparison already found —
**generalizes across providers**, not a Claude-specific artifact. `racer/4.1.0`
was already tried and REJECTED against this dimension in M4; that
experiment's conclusion stands and is not reopened here.

**Materiality: lower than #1 in this batch** — both clean instances (games
3, 7) still resolved *correctly*; the cost was turns and depth, not the win.

**Causal reach: moderate** — contributes to games running long (game 7's 33
questions), which plausibly increases exposure to other failure modes, but
did not directly cause any of this batch's four losses.

### #3 — Sustained evidence-carry-forward violation (game 8, N=1)

The 26-turn run testing subtypes of a category already excluded by a hard
NO is the single most severe *episode* in the whole batch, but it is **one
instance**. Per this project's own standing rule — not every failure
becomes a rule — this is flagged as a high-severity, unconfirmed pattern,
not promoted to an actionable finding. A third data point would be needed.

### Not elevated

D4 (one embedded instance), D2 efficiency (variable, tracks with #2/#3
rather than independent), D7 (N/A, zero AMBIGUOUS answers), D8/D5 (no
severe cross-game pattern surfaced during play).

## 4. Facts vs. interpretations vs. hypotheses — kept explicitly separate

**Observed facts:**
- 6/10 discovery games correct, 4/10 incorrect.
- 3 of those 4 losses share an identical final-guess shape: a bare category
  label.
- Zero AMBIGUOUS answers across all 10 discovery games.
- D9's exact 3-NO/4th-sibling boundary was violated in games 3 and 7 (both
  still won) and arguably in game 8's own way (lost).
- Game 8's t8–t33 all build on a premise (`abstract concept`) the transcript
  itself hard-excluded at t7.

**Plausible interpretations:**
- The bare-category-guess pattern plausibly reflects the Racer treating
  high confidence about a *category* as sufficient grounds to guess, without
  a check that the category itself satisfies the fixture's required
  specificity (`generic_type` still needs a member of the family;
  `specific_instance` needs the actual referent).
- Grok's D9 persistence, at the same magnitude as Claude's, suggests the
  underlying weakness is in `racer/4.0.0`'s own SELECT wording (already
  established in M4) rather than being specific to either model.
- Zero AMBIGUOUS answers may reflect Grok's questions being phrased more
  cleanly/atomically than the compound framings that triggered many of
  Claude's AMBIGUOUS results in M3 — or may reflect the Composer (always
  Anthropic) resolving Grok's phrasing more decisively. Both are plausible;
  neither is confirmed.

**Unproven hypotheses, explicitly not acted on:**
- That fixing the bare-category-guess pattern would not introduce new
  failures elsewhere (untested).
- That game 8's contradiction pattern is anything more than an
  unusually loud single game (N=1, per governance not yet a rule).
- Any claim that Grok is "better" or "worse" than Claude at Barkóba overall
  — the two calibration games and this discovery batch are not a matched,
  controlled comparison (different targets, different N), and this document
  makes no such claim.

## 5. The one recommended next bounded intervention hypothesis

**Target: the bare-category final guess (#1 above).**

**Selection rationale, against the stated question** — *"which single
recurring failure, if fixed, is most likely to improve release-readiness
without contaminating causal attribution"*: #1 has the highest recurrence in
this batch (3/10, vs. 2/10 for #2), the maximum possible materiality (it
directly *is* the loss, not a contributing factor), and is a **self-contained
failure mode** — fixing it does not require touching the SELECT/branch-recovery
machinery `racer/4.1.0` already tried and that M4 already rejected, so
pursuing it cannot be confused with reopening that closed experiment.

**What the evidence suggests, without yet designing the fix:** this looks
less like a wording problem in the guidance's prose (`BEFORE ANY FINAL
GUESS` already asks the Racer to name a specific leader and alternative) and
more like a missing **validation step** — nothing currently checks, before a
guess is emitted, whether the candidate answer actually matches the
fixture's required granularity. That is a structurally different kind of
fix than a `racer/4.2.0` prose edit: a candidate-validation / guess-discipline
check, potentially a runtime gate rather than another paragraph competing
for the model's attention inside an already-dense trailing block.

**This is a hypothesis for the next milestone to test, not an
implementation.** Per explicit instruction, no `racer/4.2.0` was drafted, no
Strategy Memory was touched, and no fix was attempted in this session.

---

**Verdict on the primary scientific question (Phase 3):** the batch found
**both** outcomes at once, cleanly separated by dimension — D9's
bad-branch persistence is a *stable, recurring, provider-independent*
defect (confirmed across this batch, M3's Claude baseline, and M4's direct
comparison), while the bare-category-guess failure is a **newly discovered**
recurring pattern this batch surfaced for the first time, not visible in
the smaller M3/M4 Claude sample. Neither is "one unusually loud game" — both
clear the recurrence bar this batch's own governance set.
