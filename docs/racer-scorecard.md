# The Barkóba Racer Scorecard (V2.8.0 — M0)

**Status:** definition only. Nothing in this document changes game logic, changes
Racer Guidance (`CORE_RACER_RULES`, currently `racer/4.0.0` in
[lib/prompts/racer.ts](../lib/prompts/racer.ts)), or ships a benchmark fixture.
Those are M1 and M3. This is M0: a written answer to "what does a good Barkóba
Racer look like?", precise enough that two transcripts can be scored against it
and disagree in a defensible way.

Baseline: v2.7.0.23 (frozen production).

---

## 1. What this scores

The **Racer** is the AI seat in a Barkóba game: it starts blind, asks yes/no
questions of the Composer, and must name the secret target inside a fixed
question budget (`max_questions`, one of 20/35/50/100 — see
[lib/questionBudget.ts](../lib/questionBudget.ts)). Every turn it does exactly
one of `question`, `guess`, `concede`, or `clue` (when offered). Composer
answers are `YES`, `NO`, or `AMBIGUOUS`. This is the V1 engine — AI Racer,
human or AI Composer — and it is the only mode that produces transcripts today.

This scorecard evaluates **Racer competence only**: the quality of the
questions, guesses, and internal deliberation the Racer produced. It does not
evaluate:

- **The Composer.** Composer honesty is Integrity Review's job
  ([lib/prompts/integrityReview.ts](../lib/prompts/integrityReview.ts)), a
  separate, narrower verdict ("did any answer contradict the target?") that
  already exists and is out of scope here.
- **The target itself.** A hard or unusually obscure target is a Composer
  choice (`Difficulty`), not a Racer failure, and this scorecard does not
  attempt to normalize for target difficulty. Two transcripts against
  differently-hard targets are comparable dimension-by-dimension on *behavior*,
  not on raw outcome — see §6.

## 2. What a scorer has access to that the Racer did not

The Racer only ever sees `RacerPublicState` (transcript, budget, clues,
language — see [lib/types.ts](../lib/types.ts)). A scorer reading a completed
`GameRecord` after the fact sees more, and should use it:

- `qa_log`: every `QuestionLogEntry`, including `rationale` (the Racer's
  private notes — never shown to the Composer or scored in-game, but honest
  evidence of stated reasoning for this exercise), `guess_detector_flagged`,
  `guess_intent_outcome`, `ambiguous_consumed_credit`, `pre_revision_question_text`.
- `final_action`, `final_guess_text`, `result`, `adjudicator_verdict`,
  `integrity_verdict` — the resolution.
- `revealed_target`, `revealed_definition`, `revealed_granularity`,
  `revealed_modifiers` — declassified only after resolution. Use these to
  check the Racer's questions in hindsight (§5.6); the Racer never had them.
- `question_count` / `max_questions` — the budget actually used.

A scorer judging category/instance discipline or contradiction handling is
doing something the Racer itself could not: checking the transcript against
the answer key. That is legitimate for grading and should not be confused with
what the Racer is expected to know mid-game.

## 3. Scoring scale

Each dimension is scored independently, on:

**Poor / Fair / Good / Excellent / N/A / UNSCORABLE**

`N/A` is a real outcome, not a default. If a game never produced an occasion
for a dimension to matter — no `AMBIGUOUS` answer ever occurred, no
sibling-branch dead end ever arose — that dimension is `N/A`, not a free
`Excellent`. A transcript that never had to handle ambiguity has told you
nothing about how it handles ambiguity. See §6 for how `N/A` is treated when
comparing two transcripts.

`UNSCORABLE` is a different thing and must never be merged with `N/A`. `N/A`
asserts a fact about the *game*: this situation did not arise, and that
absence is itself informative. `UNSCORABLE` asserts a fact about the
*record in front of the scorer*: the situation may or may not have arisen,
but the evidence needed to tell is not available — a narrative excerpt, a
partial `qa_log`, a summary of only some turns. Scoring a dimension `N/A`
when the truth is really `UNSCORABLE` silently reports "handled cleanly" on a
transcript that was simply never checked, which is the opposite of what
happened. Default to `UNSCORABLE` whenever the record could plausibly be
incomplete; reserve `N/A` for a verdict reached against a complete, trusted
`qa_log`. (This gap was found, not designed in from the start: the M0 dry
run in this session scored two real transcripts and had to invent this
distinction ad hoc on several dimensions because only fragments of each
game's `qa_log` exist in this repository.)

D1 (§5.1) is the one exception to the five-level scale: it collapses to
**Excellent / Needs work / N/A**, one level per possible `GameResult`, and
does not use `UNSCORABLE` — its inputs (`final_action`, `result`,
`adjudicator_verdict`) are always present, in full, on a resolved
`GameRecord`, so there is no partial-evidence case for it to cover. See §5.1.

**No dimension is weighted against the others, and this document does not
define a combined numeric score.** The SOW's exit criterion asks for "which
one performed better, with a stated reason per dimension" — a per-dimension
verdict, not a composite. Collapsing nine independent dimensions into one
number requires deciding how much a bad guess (D1) is worth relative to one
redundant question (D4), which is a product judgment this SOW does not make
and which this document does not invent on its own. See §7.

Every level assigned must cite the specific `turn_index` (or index range) it
rests on. A level with no citation is not a score.

## 4. Reading order

For each dimension below: **Definition**, **Signal** (what to look at in the
transcript), **Rubric** (what separates the four levels), **Notes**.

---

## 5. The nine dimensions

### 5.1 Solve outcome

**Definition.** Did the Racer actually win the game it played, on its own
merits?

**Signal.** `final_action`, `result`, `adjudicator_verdict`.

**Rubric.** One level per outcome, no overlap — every non-null `GameResult`
value maps to exactly one of the three below:
- **Excellent — `racer_correct`.** The guess was adjudicated correct.
  (Whether the *timing* of that guess was efficient or lucky is D8's question,
  not this one — a correct guess is always Excellent here, regardless of how
  it was reached.)
- **Needs work — `racer_incorrect`** (a guess was made and adjudicated wrong —
  whether volunteered early or forced by `forceFinal` at budget exhaustion,
  both land here; the schema has no separate "ran out of budget" result) **or
  `composer_win_integrity_upheld`** (the Racer conceded — gave up — and
  Integrity Review found no Composer dishonesty). Either way, the Racer did
  not converge on the target within budget, on the merits.
- **N/A — `racer_win_integrity_violation`.** The Integrity Review found the
  Composer — the target-setter — answered dishonestly somewhere in the
  transcript: a target-setter error, not a Racer result. **Do not score solve
  outcome on this branch**, and treat the whole transcript's other dimensions
  with the caveat that at least one answer in `integrity_flagged_turns` may be
  false and any dimension that leans on that turn's answer should note the
  caveat rather than penalize the Racer for trusting it.

**Notes.** This is a binary-ish read of the result table in
[lib/resolveResult.ts](../lib/resolveResult.ts), deliberately kept simple. It
answers "did it work", nothing about how well. Previously "Excellent / Good"
both named `racer_correct`, which let the identical transcript be recorded at
two different levels; that ambiguity is removed by giving `racer_correct`
exactly one label.

---

### 5.2 Question efficiency

**Definition.** Did each question meaningfully shrink the space of remaining
possibilities, or did the Racer spend turns on low-information moves?

**Signal.** The full sequence of `question` turns, read as a trajectory. The
Racer's own system prompt states the target shape directly (see
[lib/prompts/racer.ts](../lib/prompts/racer.ts)): early questions should
"split the space of possibilities close to in half"; narrowing should proceed
"by category, then by property, then by identity"; and if the budget is
running out while the space is still wide, later questions should "take bigger
cuts."

**Rubric.**
- **Excellent.** A visible broad-to-narrow arc: opening questions partition a
  large space (domain/kind-level), each subsequent question's scope is
  consistent with everything already established, and no question's answer
  was already fully determined by prior answers (that specific failure is
  D4's territory, but it also depresses this score). Specificity increases
  roughly monotonically with confidence, not necessarily linearly.
- **Good.** The same arc, with one or two questions that added little marginal
  information (near-duplicate scope to an adjacent question, or a
  confirmatory question late that didn't change what would be guessed either
  way).
- **Fair.** Several low-information questions, or budget usage noticeably
  larger than the trajectory of hypotheses narrowing would predict — e.g. the
  space was effectively down to two candidates by turn 15 of 35 but the game
  still used 30 questions without a clear reason (recovery from a dead branch,
  see D9, is a legitimate reason and should not be counted against this
  dimension if it's already accounted for there).
- **Poor.** No visible arc — narrow, single-candidate-shaped questions from
  early turns, or repeated sibling enumeration rather than partitioning
  (`"is it X?" / "is it Y?" / "is it Z?"` instead of a question that splits X,
  Y, Z, and others at once).
- **UNSCORABLE** if the available record is not the full sequence of question
  turns — a partial excerpt can support a read on the turns it shows, but not
  a verdict on the whole-game arc this dimension asks about.

**Notes.** Normalize against `max_questions`, not an absolute count — a
20-question game and a 100-question game are not compared on raw turns used.
A question that triggered `AMBIGUOUS` is not automatically inefficient (the
Composer may have genuinely conflated two things); a question that triggered
`AMBIGUOUS` *and* was a bad cut to begin with is inefficient on this axis and
should also be checked against D7.

---

### 5.3 Evidence consistency

**Definition.** Does every later question or guess remain compatible with
*everything* already on the board — every `YES`, `NO`, and `AMBIGUOUS` so
far — not just the answer to the immediately preceding question?

**Signal.** Cross-check each `question_text`/`guess_text` against the full
prior transcript, not just the last turn. Where `rationale` is present, it is
direct evidence of what the Racer believed KNOWN to be at that point.

**Rubric.**
- **Excellent.** No detectable inconsistency anywhere in the game: nothing
  asked or guessed is incompatible with an earlier answer.
- **Good.** One minor inconsistency (e.g. a question that implicitly reopens
  something a `NO` two turns ago had already settled), and it is self-evidently
  harmless — it didn't change the trajectory and wasn't repeated.
- **Fair.** One inconsistency that went uncorrected but did not reach the
  final guess.
- **Poor.** The final guess, or a pivotal late-game question building directly
  toward it, is incompatible with an established earlier answer.
- **UNSCORABLE** if the available record is not the full prior transcript —
  a partial excerpt can rule out inconsistency within itself, but cannot rule
  out inconsistency against turns it doesn't contain.

**Notes.** This is distinct from D5. D3 asks "does the Racer only build on
what's true so far" (a *positive*, ongoing consistency check across the whole
transcript). D5 asks specifically "what does the Racer do at the *moment* a new
answer conflicts with where it was heading" (a reaction to a single event).
A transcript can score well on D3 and poorly on D5, or vice versa — e.g. a
Racer that never contradicts old evidence but also never revises a hypothesis
fast enough when new evidence cuts against it.

---

### 5.4 Redundancy

**Definition.** Did the Racer re-ask something whose answer was already
logically fixed by an earlier `YES` or `NO`? This is the RED FLAGS item from
`CORE_RACER_RULES` itself: "Re-probes a dimension already settled by a YES or
a NO — a sibling within it, an edge case, or a more precise variant of the
same confirmed value."

**Signal.** Pairwise: for each question, could its truth value have been
determined from the answers already on the board? Includes sibling
enumeration inside an already-confirmed branch (asking about breed A, then
breed B, then breed C one at a time, after "is it a dog breed" was already a
`YES`).

**Rubric.**
- **Excellent.** Zero redundant questions.
- **Good.** One redundant question, low-impact (didn't cost a question that
  was later scarce — see `questions_remaining` at that turn).
- **Fair.** One redundant question that was costly (asked late, when budget
  was tight), or two low-impact ones.
- **Poor.** Three or more, or a pattern of sibling-by-sibling enumeration
  inside a settled branch instead of a single dividing question.
- **N/A** only if the full `qa_log` was checked and the game is genuinely too
  short (e.g. ended in 2–3 turns) to have had a real opportunity for
  redundancy to arise.
- **UNSCORABLE** if only a partial record is available — a short *excerpt* of
  a longer game can look too short for redundancy to arise while turns
  outside the excerpt are simply unseen. Do not call that `N/A`.

**Notes.** A question flagged by the Guess Detector (`guess_detector_flagged`)
and resolved as `continue_questioning` is not automatically redundant — check
the *revised* question (`question_text`, post-revision) against this same
test, not the original.

---

### 5.5 Contradiction handling

**Definition.** When a new answer directly cuts against the hypothesis the
Racer's last few questions were visibly building toward, does it pivot on the
very next move — or does it keep acting as though the hypothesis still holds
(explicit rationalization, quietly changing the subject without addressing the
conflict, or guessing the contradicted candidate anyway)?

**Signal.** Identify each turn where the answer plausibly falsifies whatever
the preceding 2–3 questions were narrowing toward. (This step is inherently
interpretive — the scorer is inferring the Racer's working hypothesis from its
question pattern, since the Racer doesn't declare it explicitly outside
`rationale`. Where `rationale` states the hypothesis directly, use it; where it
doesn't, note the inference as such.) Then check the following 1–2 turns for a
visible pivot: a question or guess that no longer depends on the falsified
premise.

**Rubric.**
- **Excellent.** Every identified falsifying answer is followed by a clear
  pivot on the very next turn.
- **Good.** Pivots happen, but take an extra turn (one turn spent still
  adjacent to the dead hypothesis before moving off it).
- **Fair.** One falsifying answer is not clearly addressed, but the eventual
  guess does not rest on the falsified premise anyway.
- **Poor.** A hypothesis that was directly contradicted by an answer survives,
  unaddressed, into the final guess.
- **N/A** if the full transcript was checked and no answer in it plausibly
  falsified anything the Racer had been building toward — i.e. the game
  never presented this test.
- **UNSCORABLE** if only a partial record is available — the absence of a
  visible falsifying answer in what's shown does not establish that none
  occurred elsewhere in the game.

**Notes.** Do not double-penalize here for AMBIGUOUS handling — that has its
own dimension (D7). A `NO` that contradicts a live hypothesis is this
dimension's concern; an `AMBIGUOUS` that reveals a poorly-framed question is
D7's.

---

### 5.6 Category/instance discipline

**Definition.** Did the Racer's line of questioning respect the target's
actual granularity — `generic_type` ("bicycle": subtypes and variants ARE
it) vs. `specific_instance` ("my red bicycle": other members of the category
are NOT it) — see [lib/types.ts](../lib/types.ts), `TargetGranularity`? And
separately, did it observe the category-before-identity ladder the guidance
itself names as a RED FLAG: "Names one specific sibling while a broader
grouping one level up still has multiple live alternatives"?

**Signal.** `revealed_granularity` and `revealed_modifiers`, read against the
transcript in hindsight (the Racer never sees these directly — see §2). Check
whether questions treating a variant/subtype as ruled-in-or-out are consistent
with the revealed granularity, and whether the final guess's specificity
matches it (a `generic_type` target is correctly solved by naming the category
cleanly; a `specific_instance` target requires the guess to actually pick out
the one thing, not a category that happens to contain it — see
[lib/prompts/adjudicator.ts](../lib/prompts/adjudicator.ts): "A broader
category ... is sufficient only if it uniquely picks out the same single
referent as the locked target").

**Rubric.**
- **Excellent.** The questioning ladder and the final guess are both
  consistent with the revealed granularity throughout — no point where the
  Racer either over-generalizes a `specific_instance` target or over-narrows a
  `generic_type` one.
- **Good.** One minor slip (e.g. one question briefly treats a variant as
  disqualifying when the target was `generic_type`) that self-corrects and
  doesn't affect the final guess.
- **Fair.** A slip that goes uncorrected but the final guess still lands
  correctly on the appropriate granularity.
- **Poor.** The final guess itself mismatches the revealed granularity's
  required specificity — too broad for a `specific_instance` target, or a
  needlessly narrow single sibling declared as the guess when any member of a
  `generic_type` family would have counted.

**Notes.** The final-guess-vs-granularity half of this check is always
scorable — every resolved game has a `revealed_granularity` and a
`final_guess_text`. The questioning-ladder half (whether earlier questions
respected the granularity throughout, not just the final guess) needs the
full transcript; score that half **UNSCORABLE** when only a partial record
is available, even where the final-guess half can still be scored on its
own. Where the full transcript is available and the target's granularity
was never actually in tension with a question the Racer asked, note
explicitly that the dimension simply never approached this edge, rather than
crediting it as Excellent by default.

---

### 5.7 Ambiguity handling

**Definition.** Per the system prompt: "AMBIGUOUS means your question could
not be answered truthfully as a binary — the framing was wrong, not the
topic. ... do not re-ask the same question; re-cut the same territory along a
cleaner line." Per `CORE_RACER_RULES`' KNOWN section: "AMBIGUOUS is
informative failure, not a soft answer ... Isolate one of them next; never
re-ask a paraphrase of it."

**Signal.** Every turn where `composer_response === "AMBIGUOUS"`, plus its
`ambiguous_explanation`. Check the next question: does it split the conflated
dimension into two separable questions (good), superficially rephrase the same
conflation (bad), or drop the axis entirely without ever resolving either
reading, even though the final guess turned out to depend on it (also bad)?

**Rubric.**
- **Excellent.** Every `AMBIGUOUS` is followed by a genuine split — a
  next-question that isolates one of the two conflated readings, never a
  paraphrase of the original.
- **Good.** Splits happen, but not on the very next question (one intervening
  turn on something else first).
- **Fair.** One `AMBIGUOUS` is answered with a near-paraphrase, but it wasn't
  load-bearing for the eventual guess.
- **Poor.** A paraphrase repeat occurs on a dimension that mattered, or an
  `AMBIGUOUS` axis is left permanently unresolved despite the final guess
  depending on which reading was true.
- **N/A** if the full transcript was checked and genuinely contains no
  `AMBIGUOUS` answers.
- **UNSCORABLE** if only a partial record is available — the absence of a
  documented `AMBIGUOUS` answer in what's shown does not establish that none
  occurred elsewhere in the game.

**Notes.** `ambiguous_consumed_credit` marks an `AMBIGUOUS` that burned a real
question (past the free cap). A mishandled `AMBIGUOUS` that also cost a
question is a more severe instance of the same failure, not a separate one —
reflect that in the Poor/Fair distinction rather than inventing a tenth
dimension for cost.

---

### 5.8 Guess timing

**Definition.** Per the system prompt's falsify-before-commit rule: "a leading
hypothesis is a reason to ask, not a reason to guess. Spend a question trying
to break it ... A hypothesis that survives an honest attempt to kill it is
worth guessing; one you have merely not contradicted yet is not." And per
`CORE_RACER_RULES`' BEFORE ANY FINAL GUESS: name the strongest remaining
alternative and ask "have I asked the single discriminator that would most
separate them?" before guessing.

**Signal.** The 1–3 turns immediately preceding the final guess (or
`concede`). Was there a discriminating question against the strongest named
alternative before the guess, or did the guess follow the moment a hypothesis
first became plausible? Also: did the guess arrive at `forceFinal`
(budget exhausted — `question_count === max_questions`) or voluntarily with
budget remaining?

**Rubric.**
- **Excellent.** The guess follows a clear, identifiable falsification attempt
  against the strongest alternative, and either (a) arrives voluntarily with
  the falsification already done, or (b) arrives at budget exhaustion after
  genuine falsification attempts were made along the way — running out of
  budget is not itself a defect if the turns leading up to it show real work.
- **Good.** A falsification attempt exists but is directed at a weaker
  alternative than the one actually closest to the leading hypothesis.
- **Fair.** The guess follows the leading hypothesis becoming merely
  uncontradicted, with no turn spent specifically trying to break it — but
  there was no clearly-identifiable rival candidate left to test against
  either, so the omission is understandable rather than careless.
- **Poor.** A premature guess: fired the moment a hypothesis became plausible,
  with unspent budget remaining *and* an identifiable, still-live alternative
  that was never tested. (This is the exact failure the RG history in
  [lib/prompts/racer.ts](../lib/prompts/racer.ts) names as "premature
  conviction" — guessing "Volga" immediately after confirming a category,
  without ruling out a specific sibling.)
- **UNSCORABLE** if the turns immediately preceding the final guess (or
  `concede`) are not present in the available record — this dimension
  specifically needs that window, and a record that states only the outcome
  cannot support a level here.

**Notes.** A guess flagged by the Guess Detector
(`guess_detector_flagged: true`) that resolves `confirm_guess` should be
scored at the turn where the intent was actually declared, using
`guess_intent_outcome`, not treated as a phantom extra turn.

---

### 5.9 Recovery from a bad branch

**Definition.** Per `CORE_RACER_RULES`' SELECT: "After two or three related
NOs on the same branch, stop — that is a signal, not a coincidence — and ask
whether the parent frame itself is wrong before trying more siblings." This is
also RG history's Hierarchy/Resolved-branch gate lineage (§37–§49 of
[docs/DESIGN-NOTES.md](DESIGN-NOTES.md)).

**Signal.** Find any run of two or more consecutive `NO` answers to questions
that are siblings within one narrow branch (same family, probed member by
member). Check the question immediately after that run.

**Rubric.**
- **Excellent.** The next question after a bad-branch run visibly steps back —
  it tests or reopens the parent assumption itself, rather than trying another
  sibling at the same level.
- **Good.** The branch is abandoned (no further siblings tried), but the next
  question doesn't explicitly test the parent frame either — it just moves
  somewhere else without confirming whether the frame was the actual problem.
- **Fair.** One more same-level sibling is tried after the run before the
  Racer moves off the branch.
- **Poor.** The Racer continues enumerating same-level siblings past the point
  the guidance itself flags (two or three consecutive NOs), never reopening
  the parent frame.
- **N/A** if the full transcript was checked and it genuinely never produced
  a run of two or more consecutive NOs on the same narrow branch.
- **UNSCORABLE** if only a partial record is available — the absence of a
  visible bad-branch run in what's shown does not establish that none
  occurred elsewhere in the game.

**Notes.** Multiple bad-branch episodes can occur in one game; score the
dimension on the pattern across all of them, citing each, not just the first.

---

## 6. Comparing two transcripts

For each of the nine dimensions:

1. Assign a level (Poor/Fair/Good/Excellent/N/A) to each transcript, with the
   citation the rubric requires.
2. If both are scorable (neither is `N/A`), state which transcript's level is
   higher and why, in one sentence tied to the citation — this is the "stated
   reason per dimension" the exit criterion asks for.
3. If one is `N/A` and the other is not, say so plainly: that dimension only
   discriminates on the transcript that exercised it. Do not treat a lower
   level in the other transcript as automatically better just because it
   avoided the situation entirely — avoidance is not evidence of competence.
4. If both are `N/A`, say so — the dimension is silent for this pair.

The output of a comparison is a nine-row table (dimension, level A, level B,
reason), not a single verdict. Where a holistic summary is wanted on top of
that table, it should be a qualitative sentence pointing at which dimensions
actually discriminated between the two and by how much — never a computed
score, per §3 and §7.

## 7. Decisions made in writing this scorecard, flagged rather than hidden

The SOW leaves some structural choices open. These are the ones judged to be
ordinary scorecard-authoring latitude rather than product decisions requiring
escalation — flagged here so they're visible rather than buried in rubric
prose:

- **No numeric or weighted composite score.** Justified directly by the exit
  criterion's own wording ("a stated reason per dimension"). If a future
  milestone needs a single pass/fail number (for a benchmark gate, say), that
  requires deciding how much each dimension is worth relative to the others —
  a product call this document does not make.
- **`racer_win_integrity_violation` games are excluded from Solve Outcome
  entirely, not counted as a Racer win.** The Racer didn't demonstrably win on
  the merits when at least one answer it reasoned from was false. This is a
  scoring-methodology choice, not a claim about who "really" won the game.
- **Rationale text is used as evidence even though the game itself never
  scores it.** It's the most direct available signal of the Racer's stated
  reasoning at each turn, and using it for offline grading doesn't conflict
  with its in-game purpose (private notes, unscored by the Adjudicator).
- **Target difficulty is not normalized for.** Two transcripts against
  differently-hard targets are compared on behavior, not on whether one had an
  easier time. Flagged in case a future milestone wants difficulty-matched
  pairs instead.

None of these touch V1 game logic, Racer Guidance, `secretStore.ts`, or any
migration, and none required a call this document couldn't make on the SOW's
own terms — so none triggered a stop.

## 8. Explicitly out of scope for M0

- No change to `CORE_RACER_RULES` / `RACER_PROMPT_VERSION`.
- No change to any game logic, prompt, or route.
- No benchmark fixtures, no scoring automation, no corpus queries.
- No claim about which prompt version (`racer/3.x`, `racer/4.0.0`, or a future
  one) performs better on any dimension — that's M1/M3's job, run against this
  scorecard, not this document's.
