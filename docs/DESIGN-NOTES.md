# Barkóba — Design Notes

Decisions that are easy to lose, and the reasoning behind them. Anything
recorded here was decided deliberately. If a future change contradicts a note,
that is a decision to make on purpose, not a bug to quietly fix.

## Versioning

The codebase uses a numeric series, one per V1 configuration:

| Series | Configuration | Status |
|---|---|---|
| `0.3.x` | Human Composer → AI Racer | current |
| `0.6.x` | remaining configuration | not started |
| `0.9.x` | remaining configuration | not started |

Current build: **`0.3.0.1`** — scaffold, data layer, Validator, Racer loop,
Guess Detector (EN + HU), Adjudicator, Integrity Review, result semantics.

Which of the two remaining configurations lands in `0.6.x` versus `0.9.x` is
**not yet fixed** and is deliberately not guessed at here.

Ad-hoc `M`-numbers are retired. Earlier notes retain their original `M` labels
inline **only as historical provenance** — those milestones were not renumbered,
because assigning them versions after the fact would invent a history that did
not happen. Everything through this point is consolidated as `0.3.0.1`. New
work uses the numeric convention only.

Note on `package.json`: npm requires three-part semver, so it reads `0.3.0`.
The four-part build tag lives in the `VERSION` file and should be the git tag
(`v0.3.0.1`).

---

## 1. Guess-flag resolution: internal to the Racer in V1

**Decision (M3).** When the Guess Detector flags a Racer output whose declared
`action` is `"question"`, the flag is resolved by **re-prompting the Racer**
with a forced `confirm_guess` / `continue_questioning` choice. The human
Composer never sees the flag, is never asked to confirm anything, and never
waits on the exchange.

**Why.** The original spec described a confirmation step in which the flagged
party is shown the flag and asked "did you mean that as a guess?". That pattern
was written for the human/child Racer the game was originally imagined around.
It does not map onto V1, where the Racer is an AI with forced structured
output: there is no human on that side of the table to confirm with. Showing
the confirmation to the *Composer* instead would be worse than useless — the
Composer would be adjudicating the Racer's intent, which is not theirs to know.

**What counts as "the guess", precisely.** Interrogative form does not exempt an
utterance from guess detection — but the deciding factor is the Racer's
*committed intent*, not content-matching independent of that intent:

| Detector | Racer's resolution | Outcome |
|---|---|---|
| flags question-form output | `confirm_guess` | Becomes `final_guess_text`, phase → `resolving`, adjudicated like any other guess |
| flags question-form output | `continue_questioning` | **No guess consumed** — even if the named content exactly matches the target. The Racer keeps testing that hypothesis without burning its one shot. |

This is why there is no question-form category in the adjudication fixtures: the
Adjudicator never receives an unconfirmed question-form utterance, so asserting
its behaviour on one would be testing a component that cannot see the input.

**Fail-safe.** If the resolution call cannot be made — global budget exhausted
mid-turn, or the model call errors — the flagged output is treated as a
**question**, not a guess. An unresolved flag must never silently end someone's
game.

### Preserved for Phase 2: human-Racer confirmation UI

When human-vs-human mode arrives, the human Racer *does* need the confirmation
control, and the original design is the right one for it:

- Detector flags the Racer's submitted question.
- The **Racer** (not the Composer) is shown: "That reads like a guess. Submit it
  as your guess, or rephrase it as a question."
- The game blocks on the Racer's choice; `GamePhase.guess_pending_confirmation`
  is the state for that block.
- The Composer sees nothing until the Racer resolves it, so the pause leaks no
  information about how close the Racer is.

`guess_pending_confirmation` is retained in the `GamePhase` enum for exactly
this. **V1 never enters it.** Do not delete it as dead code — it is reserved.

---

## 2. AMBIGUOUS answers: free, then costed, never refused

**Decision (M3).** The first `MAX_FREE_AMBIGUOUS_ANSWERS` (default 3) AMBIGUOUS
answers do not consume a question credit. Every AMBIGUOUS answer after that
consumes one. AMBIGUOUS is **never rejected** and the Composer is **never
forced** into a YES/NO.

**Why.** AMBIGUOUS exists so a Composer is never made to give a materially
misleading binary answer to a badly-cut question. A cap implemented as
"rejected after N" would reintroduce that exact failure at the boundary — the
Composer's only remaining options would be to lie or to abandon the game. A cap
implemented as "costs a question after N" still bites a stalling Composer, but
the cost lands on the game clock rather than on the truth of the answer.

**Provenance note.** The decision recorded here is: *the cap exists* (chosen
from options) and *the cap is implemented as a cost, not a refusal* (decided
later, on the merits). An earlier written proposal described the mechanism as
"force YES/NO on the 4th, or flag for abuse", and a subsequent plan described it
as rejection at the API boundary. Neither was ever approved as a mechanism; both
were drafting artifacts that outran the actual decision. Recorded here so the
distinction survives.

---

## 3. Two independent cost controls, and why one is not enough

- `lib/rateLimit.ts` — **per-IP**, per-hour, on `/api/game/create` only.
- `lib/callBudget.ts` — **global**, per-UTC-day, on Racer model calls.

Per-IP limiting bounds the worst individual actor. It says nothing about
aggregate organic traffic, and nothing at all about one actor spread across many
IPs. The per-IP ceiling of 5 games/hour implies roughly 100–125 Racer calls per
hour per IP; with no global counter, total spend is bounded only by how many
IPs exist.

`consumeRacerCall()` **fails closed**: if the counter cannot be read or
incremented, the call is denied. A KV outage that silently disabled the only
global spend ceiling would be the precise failure the ceiling exists to prevent.

The Validator call in `/api/game/create` is deliberately *not* metered by the
global budget — it is already bounded by the per-IP creation limit. Putting it
under the same ceiling is a one-line change if that ever becomes desirable.

---

## 4. Isolation: enforced, not promised

Three layers, in increasing order of strength:

1. **Comment** in `lib/secretStore.ts`. Documents intent. Fails nothing.
2. **Type narrowing.** `lib/prompts/racer.ts` does not accept `GameRecord`; it
   accepts `RacerPublicState`, built only by `toRacerPublicState()` in
   `lib/racerState.ts`. If `GameRecord` grows a leaky field, the Racer does not
   inherit it silently — someone must edit the mapper on purpose.
3. **`scripts/check-isolation.mjs`.** Walks the local import graph from every
   Racer-facing module and fails the build on any path reaching
   `lib/secretStore.ts`, including transitive ones. Wired into `npm run build`.

The check is verified to catch a transitive violation, not just a direct one.

---

## 5. Language of play: detected, never asked

**Decision (M3).** `GameRecord.game_language` (`"hu" | "en"`) is set once, at
creation, from the **existing** Validator call — the Validator already reads the
target and the private clarification, so detection rides along in its structured
output. No extra model call. No language-selection screen. The Composer is never
asked.

It flows `Validator -> GameRecord -> RacerPublicState -> Racer prompt`. The Racer
plays in that language naturally, leaving proper nouns and technical terms in
their original form.

**Hard constraints.**

- Detection **never modifies** the target or the private clarification. Those
  stay canonical, verbatim, exactly as typed. The Validator prompt states this
  explicitly.
- Judge by connective prose, not by individual nouns: a Hungarian sentence
  containing an English brand name is Hungarian. For genuinely mixed input, take
  the dominant conversational language and let embedded foreign terms stand.
- Too little prose to judge → `"en"`.
- `game_language` carries **no information about the target**. It is a property
  of how the Composer types, not of what they chose, so passing it through
  `RacerPublicState` does not weaken isolation.

**Explicitly out of scope for M3**: i18n framework, translation layer,
language-selection UI, locale architecture. Hungarian UI is a separate frontend
matter. Pre-M3 records default to `"en"` on read.

### Guess Detector language coverage (M3 gap, closed in M3.1)

**M3 shipped with a known hole.** The detector was English-first. Hungarian
marks possession with a suffix (`fűnyíród` = "your lawnmower"), so the English
possessive and specific-instance rules could not fire, and a descriptive
Hungarian guess naming no proper noun — "Ez a fűnyíród fogantyúja?" — scored as
a free question. That was a real hole in the one-guess rule, in the language the
project is most likely to be tested in.

**M3.1 closes it.** Three additions, all narrow:

1. **Hungarian possessive-suffix rule.** The discriminator is the definite
   article: possessed nouns follow `a`/`az` ("a fűnyíród"), while the
   2nd-person verb forms sharing the same `-d` ending ("tudod", "látod",
   "gondolod") do not. That single constraint is what stops the rule firing on
   every second verb.
2. **Hungarian specific-instance rule** — a possessed thing belonging to another
   possessed thing ("a fűnyíród fogantyúja"), the Hungarian shape of "the handle
   on your lawnmower".
3. **Hungarian hedges and explicit-guess frames**, with `gondolsz` as the
   highest-yield frame.

**A design flaw surfaced while tuning, and it was not a Hungarian problem.**
The single-tier hedge model was wrong in both languages. "Is the answer a type
of tool?" is not a guess; "Arra gondolsz, hogy ez egy csavarhúzó?" is. Both
contain a guess frame and something hedge-shaped. What separates them is whether
the hedge is real **category vocabulary** ("type of", "fajta") or merely a
**copula/comparison frame** ("is it a", "ez egy") that appears just as readily
inside a guess. Hedges are now two-tiered:

- **STRONG** (category vocabulary) — can offset an explicit guess frame.
- **WEAK** (framing only) — applies only when no guess frame is present.

English behaviour is unchanged; the flaw was latent there and would have been
exploitable in English too, by any guess phrased as "I'm guessing it's a …".

**Still provisional.** `test/fixtures/hungarian.ts` (26 fixtures across explicit
guesses, descriptive/possessive guesses, and ordinary narrowing questions) has
**not had a native-speaker pass**. The fixtures are grammatical and plausible,
but grammatical is not the same as what a Hungarian player would actually type,
and a detector tuned against unrepresentative fixtures is confidently wrong
rather than merely wrong. The review protocol is written at the top of that
file: fix the phrasing, never the expected classification.

---

## 6. Dormant schema fields stay dormant

`QuestionLogEntry` carries `quality_score`, `information_gain`,
`strategy_classification`, `integrity_flag`, `confidence`, and `latency_ms`.
None are written by V1 logic — including `latency_ms`, which M3 could trivially
populate and deliberately does not. Z-Score and Warning Triangle successors
require an explicit go-ahead before anything writes to them.

`turn_index` (renamed from `index` in M3.1) is a **turn number**, not a
question-credit number. `question_count` on `GameRecord` is the single
authoritative record of charged questions. The two diverge on purpose: a free
AMBIGUOUS answer advances `turn_index` without advancing `question_count`, as
does a question swapped in after a Guess Detector flag. Anything asking "how
many questions has this cost?" reads `question_count`; anything asking "which
turn was this?" reads `turn_index`. Do not conflate them.

The Composer-facing thread labels turns `#3`, not `Q3`, for the same reason —
"Q3" implied a charged-question count the number does not carry. The header
carries the authoritative count.

---

## 7. M4 — resolution, adjudication, and integrity

### The result table

| `final_action` | Adjudicator | Integrity | `result` |
|---|---|---|---|
| `guess` | correct | **not run** | `racer_correct` |
| `guess` | incorrect | violated | `racer_win_integrity_violation` |
| `guess` | incorrect | upheld | `racer_incorrect` |
| `concede` | not run | violated | `racer_win_integrity_violation` |
| `concede` | not run | upheld | `composer_win_integrity_upheld` |

Every `GameResult` value is reached by exactly one path. No overlaps, no
unreachable states.

**A correct guess is unappealable and cheap.** The Integrity Review is not
invoked on that path — not invoked and discarded, *not invoked*. Two
consequences, both intended: a Composer who cheated and still lost is never
accused, and the resolve costs one strong-model call instead of two.

**Adjudication never runs on a concede.** There is no guess to judge.

The table lives in `lib/resolveResult.ts` as a pure function with no I/O, and
`deriveResult()` **throws** on any combination the table does not define rather
than returning a plausible default. Orchestration drift must fail loudly: this
module decides who won, and nothing downstream would catch a silent error.
The skip decisions (`needsAdjudication`, `needsIntegrityReview`) live there too,
so the cost behaviour is unit-tested rather than implied by control flow in a
route handler.

### Declassification

`GameRecord.revealed_target` is null for the entire life of a game and is
written **exactly once**, by `/api/game/[id]/resolve`, at the transition to
`complete`. It is the only place in the codebase where secret text is copied
into public state.

This is what lets the result screen show the target while `app/game/[id]/**`
stays fully quarantined from `secretStore`. The alternative — un-quarantining
the game page — would have permanently weakened the invariant to buy one string.
If something else needs the target later, add another deliberate declassification
point; do not widen this one.

### Isolation check, inverted (M4)

M3's check walked *from* a quarantine list, which only ever catches violations
in modules someone remembered to list. M4 added legitimate secret readers, which
made that model backwards. The check now runs **both**:

- **Allowlist** — scans every `.ts`/`.tsx` file and asserts the only importers of
  `secretStore.ts` are the permitted call sites. Catches violations in files that
  do not exist yet.
- **Transitive quarantine** — walks the import graph from each Racer-facing entry
  point, catching indirect paths.

Both are needed. Verified: the allowlist alone does *not* catch a quarantined UI
module importing an **allowlisted** module and obtaining the secret second-hand.
The transitive walk does.

### Integrity Review scope

Factual contradiction only: did a YES or NO answer state something false given
the target? Explicitly **not** in scope — evasiveness, stalling, strategy, good
faith, or AMBIGUOUS usage. Those are not falsifiable from a transcript, and a
model asked to infer bad intent will find it. AMBIGUOUS abuse is already priced
by the free-then-costed economics, which needs no model to enforce.

The prompt defaults to UPHELD unless a contradiction is unarguable. This verdict
accuses a person of cheating, and a false accusation costs more than a missed
one: the missed one costs a game, the false one costs trust in the mechanism.

Evidence goes in `GameRecord.integrity_flagged_turns`, a **new** field.
`QuestionLogEntry.integrity_flag` remains the dormant Warning-Triangle successor
and is still untouched.

### Cost controls, three counters

| Counter | Scope | Model | Volume |
|---|---|---|---|
| per-IP (`rateLimit.ts`) | `/create` | — | 5 games/hour/IP |
| `racer` (`callBudget.ts`) | turn + guess-intent | cheap | ~20–25 per game |
| `resolve` (`callBudget.ts`) | Adjudicator + Integrity | strong | 1–2 per completed game |

Racer and resolve counters are **separate on purpose**. A shared counter would
let a busy day of cheap Racer turns exhaust the budget and block adjudication of
games already played to completion — running out of money after all the cost is
already sunk. Both fail closed.

### The locked adjudication principle

> A final guess is correct when it identifies the same intended referent or
> concept as the immutable target, allowing different wording, synonyms,
> translations, and equivalent descriptions. A containing whole or component is
> never sufficient — Barkóba's granularity rule treats part and whole as
> genuinely distinct targets, regardless of phrasing. A broader category or
> general description is sufficient only if it uniquely picks out the same
> single referent as the locked target; if it could equally apply to something
> the target does not denote, it fails to identify the target and is incorrect.

**Part/whole and broader/narrower are two rules, not one.** They collapse into
each other under casual reading, and that collapse is the most likely way for
someone to "simplify" this into being wrong.

- **broader/narrower applies a uniqueness test.** Does this description pick out
  exactly one thing, and is that thing the target? "Earth's only natural
  satellite" survives. "A natural satellite" does not — it equally denotes Titan.
- **part/whole forecloses one particular way of passing that test.** A guess
  naming the lawnmower *does* pick out exactly one thing, unambiguously. It
  still fails, because the thing it picks out is not the target. The rule blocks
  the intuitive argument "I identified it, it's right there on the thing I
  named." **Containment is not identity.**

Uniqueness can rescue a broad description. Uniqueness can never rescue a
part/whole mismatch.

**Generosity / good sportsmanship.** When a guess plainly identifies the correct
referent but differs only in wording, register, colloquialism, or metonymy —
an activity named by its characteristic equipment, a well-known synonym, a
natural descriptive equivalent — resolve in the Racer's favour. Generous wins
are stated explicitly in `reasoning`.

Generosity forgives imprecise **wording** for a referent already identified. It
never forgives naming a **different referent**, however close or however
characteristic. It does not reach a containing whole, a component, or a
description that fails to resolve uniquely.

The failure mode is **leakage** — generosity stretched to excuse a granularity
error because the guess sounds like a natural way to refer to the thing.
`part-9` ("a violin" for "orchestra") exists solely to catch it: exactly the
shape generosity forgives elsewhere, and it must still fail. If it starts
passing, the clause needs tightening, not the fixture.

**Multi-candidate guesses are incorrect**, including when one named candidate is
the target. Naming several possibilities is several guesses, and the Racer gets
one — the same exploit class the Guess Detector closes, arriving at a later
stage.

The Adjudicator still returns `correct | incorrect` with no partial verdict: a
third state would need defined handling in the result table, and a state with no
defined handling is how games get stuck. `confidence` records how close the call
was.

### Evaluating the Adjudicator

The Guess Detector is a pure function, so its fixtures are unit tests. The
Adjudicator is a model call, so its fixtures **cannot be**. Putting them in
`npm test` would make the build fail on network blips and cost money on every
commit — a build people learn to ignore.

The split:

- **`npm run eval:adjudicator`** — 70 fixtures across 14 categories against the
  real API. Per-category pass rates, failure detail, `--repeat N` variance,
  `--category` filter, optional `--gate`. Not part of `verify`.
- **`npm test`** — hermetic structural checks over the fixture *data*: unique
  ids, well-formedness, reciprocal pairs, and assertions that encode the locked
  principle directly, so contradicting it fails the build.

**Borderline fixtures assert confidence, never a verdict.** They have no ground
truth, so asserting one would invent it. Instead they require confidence at or
below a ceiling: a model that rules borderline cases at 0.95 is broken even on
the runs where it happens to be right.

**Determinism, and why it is no longer `temperature: 0`.**

The requirement stands: a verdict that changes between identical re-runs cannot
be defended to a player who disputes it. The *mechanism* changed, because
`temperature: 0` stopped being available.

Claude Sonnet 5 and Claude 4.7+ **reject non-default `temperature`, `top_p`, and
`top_k` with HTTP 400**. Adaptive thinking requires the model to control its own
sampling during reasoning, and an external override conflicts with that. This
was found the hard way: the first real eval run failed every call.

Determinism is now carried by:

1. **An explicit determinism instruction** in the Validator, Adjudicator, and
   Integrity Review system prompts — Anthropic's documented replacement path for
   behaviour previously controlled through sampling. The Racer has none, because
   question variation between games is desirable.
2. **Measurement**, via `npm run eval:adjudicator -- --repeat N`. This was
   already the standing instruction — treat stability as an empirical
   expectation, not an architectural assumption — and it now carries more weight,
   since nothing in the request enforces it.

`lib/anthropic.ts` does **not** hard-code the assumption that sampling params are
unavailable, because model IDs here are env-configurable by design. It is
self-healing: send the parameter, and if the API rejects it as deprecated,
record the model, warn once, and retry without. Later calls for that model skip
sampling params outright, so the cost is one extra request per model per
process, not per call. Pointing `ANTHROPIC_MODEL_STRONG` at an older or newer
model both work with no config change.

The rejection detector is deliberately narrow and unit-tested
(`test/anthropicSampling.test.ts`): an unrelated 400 must still throw. Silently
retrying every bad request would mask real bugs as compatibility quirks, which
is worse than the failure it was written to fix.

**No pass threshold on the first run.** Baseline first, inspect per-category
results, set gates from evidence. Choosing a number beforehand would be
inventing a standard rather than measuring against one.

### Fixture corrections from the first baseline

Running the set for real surfaced two authoring error *classes*, recorded here
because the classes generalise beyond the individual fixtures:

**(a) Narrative detail mistaken for referent identification.** `inst-4` was
marked incorrect because the guess "a gold pocket watch" omits the grandfather
provenance. But the clarification establishes the Composer owns only one pocket
watch, so the referent resolves uniquely — which is precisely what `inst-5`
tests and passes. The locked principle asks whether the guess picks out the
right thing, never whether it recites everything said about it. Corrected to
`correct`.

**(b) Rule-governed cases parked in `borderline`.** Three fixtures were filed as
borderline when the existing rules in fact decide them: sun/sunlight is a
distinct referent; winter/January and morning-routine/waking-early are plain
part-for-whole. Reclassified with `incorrect` asserted (`cat-6`, `part-7`,
`part-8`).

This matters beyond tidiness. `borderline` is for cases with **no defensible
answer**, and those fixtures are the only thing measuring overconfidence. Filling
it with cases that are merely hard to think about both hides real rule coverage
and dilutes the calibration signal. `bord-4` (chess / "a chess set") later moved to `desc-6` as `correct` once the
generosity clause landed — metonymy is now rule-governed, not borderline.

`bord-2` (the Beatles / "John, Paul, George and Ringo") later moved to `desc-7`
as `correct`, once a **closed membership enumeration** rule was locked to resolve
the clause collision described below. The original reasoning for keeping it
borderline is retained here because the collision it identified is what the new
rule had to be written around: Two clauses of the locked
principle pull opposite ways: enumerating all four members reads as a natural
descriptive equivalent, which generosity forgives — *and* members are components
of the band, which generosity explicitly does not reach. `desc-6` has no such
collision: a chess set is equipment for an activity, not a part of it. A band is
also not identical to its membership; it survived a line-up change and exists as
a named entity beyond the four people.

That distinction is the working definition of borderline in this project: not
"hard to think about", but **the rules themselves conflict**. Cases that are
merely hard belong in whichever rule decides them.

### Closed membership enumeration

Complete enumeration of a **fixed, closed** membership may identify the
collective, when that membership constitutes its identity. It does not qualify
for **partial** enumeration, **variable/open** membership, or a **functional
whole** whose identity is not reducible to its components.

Separate rule from generosity and from uniqueness, and explicitly not a
softening of granularity. It is the most stretchable rule in the set: read
loosely, "naming members identifies the group" dissolves `part_vs_whole`
entirely. Four tripwires guard it — `part-9` (violin/orchestra), `part-10`
(partial: three Beatles), `part-11` (variable: this season's eleven), `part-12`
(functional: an exhaustive car parts list). If any starts passing, the **prompt**
needs tightening, never the fixtures.

### ⚠ The borderline category is nearly empty, and that is a finding

`borderline` has gone 6 → 1 (`bord-1`, coffee/espresso). One fixture cannot
measure overconfidence, so **calibration is effectively no longer under test**.

More importantly, look at *how* it emptied. Three cases were reclassified under
rules that already existed — healthy, that was miscategorisation. But two were
resolved by **writing new rules for them**: generosity for `bord-4`, closed
membership enumeration for `bord-2`.

That pattern deserves naming. If every borderline case triggers a new rule, the
rule set grows to fit the fixture set rather than the game, and "borderline"
stops meaning "the rules genuinely conflict" and starts meaning "we have not
written that rule yet". Both new rules look right on their merits. The trend is
still worth watching, because the natural endpoint is an adjudication prompt
with a special case for every hard example anyone happened to think of.

Two concrete consequences:

1. **Restock `borderline`** with cases nobody intends to write a rule for, or
   accept that overconfidence is no longer measured.
2. Before adding rule number three, ask whether the case is genuinely
   rule-shaped or whether it is the fixture that is unrepresentative.

**Unresolved residual:** `cat-6` (sun/sunlight) sits in `category_vs_instance`
because that is the nearest existing home, but sunlight is an *emission* of the
sun, not a broader category containing it. The verdict is not in doubt; the
filing is imprecise. A `related_not_identical` category would fit better and was
deliberately not created, because adding a fifteenth category is a scope
decision rather than a tidy-up.

### Reading variance honestly

Two harness corrections came out of this, both instances of the same mistake:
**infrastructure failure must never be reported as model behaviour.**

- Failed calls are excluded from pass-rate denominators, not scored as wrong
  verdicts.
- Failed calls are excluded from the instability calculation and reported
  separately as **tainted** — a fixture with an errored repeat has an incomplete
  stability result and must be re-run before being classified, not read as
  evidence of a non-deterministic Adjudicator.

Unstable fixtures now print **per-repeat reasoning**, because a bare
`correct / incorrect / correct` cannot distinguish "the model changed its mind"
from "the model applied a different rule each time" — and those need different
fixes.

`--repeat 3` detects gross flipping, not rare flips: a fixture that flips 10% of
the time has roughly a 27% chance of surfacing in three runs. A clean variance
line means "no obvious instability", never "proven deterministic".

### orth-5 investigation — isolated experiments

**Defect.** `orth-5` (`fogantyú` → `fogantyút`, an accusative inflection) returned
reasoning stating the guess matched the target apart from grammatical case,
while the structured `verdict` field said `incorrect` at 0.95 confidence.

Reasoning that contradicts its own verdict, at high confidence, is not simple
instability. It is the signature of a verdict committed **before** any analysis
existed: a surface-string judgment (`fogantyút` ≠ `fogantyú`), with reasoning
generated afterwards that does the real work and disagrees with the answer
already given.

Two hypotheses, tested **one version at a time**, never combined.

**Experiment 1 — field order (0.3.0.12).** The Adjudicator schema declared
`verdict` before `reasoning`. Models emit tool-call fields in schema order, so
the verdict was produced first and the reasoning was post-hoc narration.
Reordered to `reasoning → verdict → confidence`. No thinking or configuration
change.

*Honesty about the mechanism:* Anthropic does not document field order as
affecting generation order. This is an empirical expectation, which is why it is
an experiment rather than a fix.

**Experiment 2 — thinking configuration and token budget (not yet run).** Only
if the contradiction survives Experiment 1. Two documented facts make this a
strong candidate, and they were confirmed against current docs rather than
recalled:

- Adaptive thinking is **on by default**, at `high` effort, meaning Claude
  almost always thinks.
- **`max_tokens` is a hard cap on thinking *and* response text combined.** The
  docs state plainly that a `max_tokens` sized for a no-thinking response is
  often too small once the model starts thinking on hard requests, and that
  `stop_reason: "max_tokens"` is the tell.

The Adjudicator runs at `maxTokens: 512`. A hard case like Hungarian
morphological inflection is exactly where thinking would expand and crowd out
the tool call.

Also confirmed for whoever builds Experiment 2: manual
`thinking: {type:"enabled", budget_tokens: N}` now returns 400. The current
lever is `output_config.effort`, plus raising `max_tokens`. Building Experiment 2
against `budget_tokens` would fail the same way `temperature: 0` did.

**Instrumentation added with Experiment 1, deliberately not a behavioural
change.** `lib/anthropic.ts` now logs a warning whenever a response comes back
with `stop_reason: "max_tokens"`, including `output_tokens` and
`thinking_tokens`. If that warning fires during the Experiment 1 run, Experiment
2 is confirmed by evidence instead of reasoned about in the abstract.

**Not done, deliberately:** no Hungarian-specific morphology rule was added to
the Adjudicator prompt. Adding one would paper over whichever mechanism is
actually at fault, and would be untestable against the very fixture that
motivated it.

**Noted, not acted on:** native Structured Outputs (`output_format`) are now GA
and grammar-constrained, a different mechanism from the tool-call emulation this
codebase uses. Potentially relevant later; changing it now would add a third
variable to a two-variable investigation.

### Field order — the same defect, twice

`orth-5` was caused by the Adjudicator schema declaring `verdict` before
`reasoning`, so the verdict was committed before any analysis existed. That was
fixed in `0.3.0.12`.

**The identical bug survived untouched in `integrityReview.ts` for two more
versions**, because the fix was applied to one file and nothing tested for the
pattern. It surfaced only in live play.

It matters more there than anywhere else in the codebase: that verdict accuses a
person of cheating, and a snap judgment on a transcript — where the honest
reading of an awkwardly worded question is often the whole question — is exactly
how a false accusation gets made at high confidence.

Both schemas now declare `reasoning` first, and
`test/adjudicationFixtures.test.ts` asserts it against the **real exported
schemas** for both files. A future edit that reorders them fails the build.
Fixing an instance is not fixing a class; the test is what fixes the class.

### Private clarification is optional (`0.3.1.1`)

The Composer may leave it blank. `/api/game/create` no longer rejects the
request; the **Validator** still decides case-by-case, returning
CLARIFICATION_REQUIRED when a bare target does not resolve. The safety property
is unchanged — nothing ambiguous gets through — but the judgment sits with the
component that can actually make it rather than with a null check.

All three consuming prompts render the absence through one shared helper
(`lib/prompts/clarification.ts`). An empty string rendered straight into a
prompt leaves a dangling `Private clarification:` label, which reads as a
Composer who was asked and declined — subtly different from one who was never
required to answer.

Each prompt is told how to degrade, and the instructions differ on purpose:

- **Validator** — judge the target alone; absence is never grounds for INVALID.
- **Adjudicator** — same rules, target alone. Absence is not evidence in either
  direction: it neither narrows the target nor licenses a looser reading.
- **Integrity Review** — lean *further* toward upheld. With less information
  about what the Composer meant, more answers become defensible, not fewer.

### Mobile clipping — one mechanism, two symptoms

The landing screen lost the first character of its title while other text ran
off the right edge. Both came from one cause: `main` had `mx-auto max-w-xl`
without `w-full`, and flex rows lacked `min-w-0`. Flex items default to
`min-width: auto`, so a single long unbroken string forced the row wider than
the viewport, and `mx-auto` then centred that oversized box — pushing its left
edge off-screen where no scrolling reaches it.

Fixed at the source (`w-full`, `min-w-0`, `break-words`, inputs given explicit
`w-full min-w-0` since form controls carry an intrinsic width and refuse to
shrink), with `overflow-x: hidden` and `overflow-wrap: break-word` in
`globals.css` as a backstop so a future long string cannot reintroduce it.

### Authorship risk, again

Expected verdicts in `test/fixtures/adjudication.ts` are authored judgement.
Most categories are near-uncontroversial. **`part_vs_whole` and
`broader_narrower` are not** — they encode a game-design choice about how strict
Barkóba is, written to the locked principle above. The principle was a decision;
a different one was available.

Review protocol, same as the Hungarian fixtures: correct the expectation where
you disagree. If the Adjudicator then fails that case, that is a finding about
the prompt. **Never tune an expectation to make a run go green.**

Deliberately not encoded: whether a guess in question form ("Is it a hammer?")
naming the right target counts. Its content identifies the target; its form is
not a guess. That is a rules decision nobody has made, so no fixture asserts
either way.

### Accepted for V1: link sharing reveals the target

Guest games, no auth, UUID game IDs. Anyone holding a game URL sees the target
once the game completes. Unguessable in practice; a property of the design
rather than a defect, recorded so it is not rediscovered as a surprise.

---

## 8. Participant kinds — a record, not a switch

`GameRecord.composer_kind` and `GameRecord.racer_kind` are hardcoded to
`"human"` and `"ai"` in the `0.3.x` series.

**Nothing branches on them, and nothing should yet.** They exist so that a
stored game carries its own configuration explicitly, rather than having it
inferred from whatever the code happened to do on the day it was played. When
`0.6.x` introduces a second configuration, games from this series will still say
what they were, which matters for any later comparison of results across
configurations.

Pre-existing records backfill to `human`/`ai`, because every game played before
this field existed was human-vs-AI. That backfill is correct by construction,
not a guess.

Deliberately **not** built here: branching logic, an AI-Composer module, a
human-Racer turn flow, or any UI that offers a choice. Those are `0.6.x`.

---

## 9. The coupling `0.6.x` will have to break

An audit for role-coupling found that the **type names are already
role-neutral** — `RacerPublicState`, `toRacerPublicState()`, `QuestionLogEntry`,
`RacerAction`, and `ComposerAnswer` all describe seats rather than
implementations, and would serve a human Racer unchanged. That is not where the
problem is.

**The real coupling is control flow, in one place:**
`app/api/game/[id]/turn/route.ts` handles a full turn in a single request —
it records the Composer's answer and then, *unconditionally and synchronously*,
consumes budget and invokes the Racer model call before returning. The route's
entire contract is "prior answer in, next Racer action out".

That contract is only satisfiable when the Racer is a machine that can be
called. With a human Racer the request must **terminate after recording the
answer**, and the next question must arrive later, in a separate request that
the Racer initiates. That is a different endpoint shape, not a conditional
inside the existing one.

Specific things that will need to change, recorded so they are not rediscovered:

1. **`turn/route.ts`** — split the single "answer in, question out" handler into
   two independently-initiated halves. This is the substantive work.
2. **`GameClient.tsx`** — the mount-time auto-POST (`kickedOff` ref) assumes the
   Racer needs no human input to produce an opening question. A human Racer
   needs an input surface instead of an auto-fire.
3. **Guess-detector resolution** — `resolveGuessIntent()` re-prompts the AI Racer
   internally. A human Racer needs the confirmation UI preserved in §1, which is
   documented and deliberately unbuilt.
4. **Composer answering** — an AI Composer needs a model call where the current
   flow waits on a human's YES/NO/AMBIGUOUS button.

Things that will **not** need to change, worth knowing before anyone plans a
rewrite:

- `RacerPublicState` and `toRacerPublicState()` already produce exactly the view
  a human Racer should be shown, and the isolation guarantee behind them holds
  regardless of who occupies the seat.
- The idempotency guard in `turn/route.ts` already implements "return the
  pending question without generating a new one", which is most of the read path
  a human-Racer flow needs.
- The result table, Adjudicator, and Integrity Review are all indifferent to who
  played which seat.

**No fix is being applied now.** `0.3.x` is human-vs-AI and the current shape is
correct for it. This section exists so the cost is known before `0.6.x` is
scoped, rather than discovered inside it.

---

## 10. Seat authorization — `0.9.x` scope

`0.9` will require per-seat access authorization — distinct Composer and Racer
tokens or URLs — so that one human player cannot submit actions on the other's
behalf.

**Confirmed not urgent.** Current error paths never leak secret data
pre-completion regardless of who holds the link, so this is a `0.9`-scope
multiplayer-session requirement, not a `0.3` gap. **No code change now.**

Verified against the code at `0.3.0.11`, so the deferral rests on evidence
rather than recollection:

- `secret.target` is referenced in exactly three places in
  `app/api/game/[id]/resolve/route.ts`: twice passed *into* the Adjudicator and
  Integrity Review prompts, and once at `game.revealed_target = secret.target`,
  immediately before `phase = "complete"`.
- Every JSON response in the turn and resolve routes returns the public
  `GameRecord`, whose `revealed_target` is `null` for the entire life of the
  game until that single assignment (§7, Declassification).
- `ResultPanel` early-returns before rendering the target unless
  `phase === "complete"`.

Post-completion link sharing does reveal the target, which is separately
recorded as accepted for V1 (§7). That is a different exposure from the one this
section defers, and is not covered by it.
