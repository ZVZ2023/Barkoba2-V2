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

Note on `package.json`: npm requires three-part semver, so it carries only the
first three components. The four-part build tag lives in the `VERSION` file and
should be the git tag.

### What bumps `VERSION`, and what does not

**Standing convention.** `VERSION` moves on **feature and behaviour changes
only**. Infrastructure-only commits — tooling, build config, observability,
docs — do not bump it.

Ground-truth deployment identity is the **commit SHA**, reported as
`commit_short` by `/api/version` and injected by Vercel from the actual pushed
commit. It cannot go stale, because nobody has to remember to update it.
`VERSION` is a human label for what changed in the game; the SHA is the answer
to "what is actually running".

The consequence is intended: two consecutive deployments can report the same
`VERSION` and different `commit_short`. That is not ambiguity — it is the label
correctly saying "the game did not change" while the SHA says "the deployment
did".

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

## 2. AMBIGUOUS: unlimited in count, but not free

**Current rule.** Every question the Racer asks costs one of its 20, whatever
answer comes back. YES, NO and AMBIGUOUS are all worth exactly one question.
AMBIGUOUS has no quota and can be used for the whole game.

`ambiguous_count` is tracked separately as the input to ambiguity-abuse
detection, which is deliberately not implemented here. It is telemetry, never a
discount.

**Two superseded designs, recorded so neither is reinvented.**

*First*, a quota: the first N AMBIGUOUS answers free, a question credit charged
thereafter (`MAX_FREE_AMBIGUOUS_ANSWERS`, default 3). Removed because it charged
the Racer for the Composer's imprecision, and because the positional
free-tier arithmetic was a real source of counting bugs on rewind.

*Second*, and briefly, unlimited **and** budget-neutral — AMBIGUOUS costing the
Racer nothing at all. That went too far in the other direction. A question is
spent when it is asked; whether the Composer could answer it cleanly is a
property of how well the question was cut, and asking an unanswerable one is
not free. Budget-neutrality also gives the Composer an unpriced way to stall,
which is the exact problem the original quota existed to prevent.

The flat cost keeps what both attempts were reaching for: the Composer is never
forced into a misleading YES/NO, and the Racer's 20 questions mean 20 questions.

`QuestionLogEntry.ambiguous_consumed_credit` stays **retired, always false**.
Under a flat cost it carries no information — every answered question consumes a
credit, so a per-entry record of "did this one?" is a constant. It is kept only
so records written under either earlier rule deserialize during their TTL, and
`recomputeCounters()` clears it on read.

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

---

## 11. Answer correction and rewind (`0.3.2.0`)

Found in live mobile play: a mistapped YES is unrecoverable, and the whole
remaining game proceeds from a false answer.

### Counters are recomputed, never decremented

`question_count` and `ambiguous_count` are incremented by the turn route, but
they are **fully derivable from `qa_log`**. A rewind therefore truncates the log
and recomputes both from what survives. Subtracting would mean reversing
arithmetic across an arbitrary span of turns, which is where this class of
feature usually goes quietly wrong — and quietly is the problem, since the
failure changes how many questions the Racer has left without ever erroring.

**The subtlety that would otherwise miscount:** `ambiguous_consumed_credit` is
*positional*, not intrinsic. With a free allowance of 3, if turns 1–3 were
AMBIGUOUS (free) and turn 4 AMBIGUOUS (charged), correcting turn 1 to YES
promotes turn 4 into the free tier — its stored flag is now wrong. So the flags
are **rewritten** across the whole retained log rather than trusted. This is
asserted directly in `test/rewind.test.ts`.

### The resume needs no new Racer logic

After truncation the game is in a state the system already handles: last entry
answered, nothing pending. `POST /turn` with no answer generates the next
question through the existing path, so budget accounting, guess detection, and
the idempotency guard are all untouched. **The correction endpoint makes no
model call at all.**

### Correction closes when the Racer commits

Allowed in `questioning` only. Once the Racer guesses or concedes, the Composer
can see the guess on screen, and a rewind at that point would let them read the
guess and retroactively invalidate it. That is not recovery, it is a cheat, and
no audit trail makes it acceptable — so the window is closed rather than
watched.

**Accepted cost:** a mistap on the very answer that triggered the guess is
unrecoverable. That is the price of closing the vector, and it is the honest
trade rather than a gap.

### The audit trail is internal

`corrections[]` and `abandoned_branches[][]` are kept for diagnostics and are
**deliberately not shown to the Integrity Review**, which judges the corrected
branch as the only branch. Correcting a mistap is ordinary play; a reviewer told
about it would be inclined to read it as evidence of something.

Invisibility is structural, not promised: the Racer reads only `qa_log` via
`toRacerPublicState()`, and the Integrity Review reads only `qa_log`. A test
asserts a discarded question cannot reach the Racer by any path.

### Concurrency

KV has no compare-and-swap, so a correction racing an in-flight turn would
interleave two read-modify-write cycles and corrupt the log. The client sends
`expected_log_length`; a mismatch returns 409 and the client refetches.

### No confirmation dialogs

Accidental taps are occasional; confirming every YES/NO would tax every turn to
guard against a rare event. Instead the cost of a rewind is shown inside the
correction control itself — "discards the 14 turns after it" — so it is visible
at the moment of choosing, without a modal in the main loop.

---

## 12. OPEN DECISION — the Validator ambiguity gate is a UX problem, not a bug

**Status: undecided. Not a defect. Do not fold this into a Pass scope silently.**

Diagnosed during Test #8, which was reported as "the optional clarification
field blocked progression". It did not. Reproduced against the deployed path:

| Case | Result |
|---|---|
| Empty clarification, unambiguous target | VALID |
| Clarification omitted entirely | VALID |
| Empty clarification, target the Validator finds ambiguous | CLARIFICATION_REQUIRED |
| **Same ambiguous target *with* clarification supplied** | **still CLARIFICATION_REQUIRED** |

That last row is the point: the gate fires on the **target**, and supplying
clarification does not clear it. The clarification field is not a blocker and
never was. `/api/game/create` has no clarification check, and the submit button
gates on `!target` alone.

**What makes it feel like a blocker** — three surfaces contradicting each other:

1. The field is labelled **"(optional)"**.
2. The response panel says **"Refine your private clarification above and submit
   again"**, which states the opposite.
3. From that panel the only affordance is **"Back to entry"**. There is no
   "proceed anyway", so a Composer who cannot guess what the Validator wants has
   no exit except changing the target.

**Why this is a decision and not a fix.** The gate's purpose is to stop a game
starting on a target that cannot be adjudicated fairly. Any escape hatch trades
that guarantee for Composer autonomy, and how much to trade is a product call:

- Reword only — say the *target* needs disambiguating, not that clarification is
  required. Cheapest, removes the contradiction, keeps the gate absolute.
- Add a "use my target as written" override — restores autonomy, and accepts
  that some games will be adjudicated against a genuinely ambiguous target.
- Show the Validator's clarifying question inline with the target field so
  refining the *target* is the obvious next move rather than a dead end.

Recorded here because a decision left in a chat log gets rediscovered as a bug.

---

## 13. Milestone 2 — AI Composer vs Human Racer (`0.6.x`)

### What §9 predicted, and what it got wrong

§9 said the coupling to break was `turn/route.ts`, whose contract is "prior
answer in, next Racer action out". That was right. What it got wrong was the
implied remedy: it read as though the route needed splitting.

The actual minimum was to leave it alone and add a sibling, `/api/game/[id]/ask`,
whose contract is the mirror image — "question in, Composer's answer out". The
two differ in which participant the server has to synthesise, which is precisely
what role inversion changes and the only thing it changes.

Branching inside one handler would have produced a route whose contract depends
on a stored field, so anyone changing either game would have to hold both in
their head. Two small honest routes beat one route with a mode flag.

### What was reused unchanged

Everything below the turn: `secretStore`, `gameStore`, `kv`, `callBudget`,
`rateLimit`, `resolveResult`, `adjudicator`, `integrityReview`, the resolve
route, declassification, the result table, `/api/version`. None of it needed to
know who occupied which seat, which is the payoff from `RacerPublicState` and
the seat fields added in `0.3.0.1`.

**`secretStore` turned out to be the load-bearing piece.** The brief asked that
the locked target be held independently rather than relying on the AI's later
recollection — and that module already did exactly that. The AI's chosen target
goes through `createSecret` and `lockSecret` identically to a human's, and
`getSecretForAnswering` hands it back on **every single turn**. The Composer
never answers from memory of what it picked; it answers against the stored
record. "Never silently change the target" is therefore structural, not an
instruction the model is asked to honour.

### What could not be reused

**The Guess Detector.** It exists to infer an AI Racer's intent from its prose.
A human Racer presses a button, so intent is declared rather than inferred, and
the whole detect-then-re-prompt path is inert. Not deleted — `0.3.x` still needs
it.

**The correction/rewind path.** Corrections let a human Composer fix a mistyped
answer. With an AI Composer there is no human answer to mistype. `/correct`
remains for `0.3.x` and is simply unreachable in `0.6.x`.

### Difficulty is deductive distance, never obscurity

The Composer prompt is explicit that the AI must not use its knowledge advantage
to win. Hard means specificity, abstraction, or unusual combinations of familiar
concepts — not specialist terminology or deep trivia. The stated test: on hearing
the answer the player should think "that was hard and I should have got there",
never "how could anyone know that?".

### Clue modes

Offered on Hard only; Easy and Medium are forced to `none` **server-side**, not
merely hidden in the UI. `progressive` scales help as the budget shrinks, with a
floor: never name the target, never leave one word to say. A clue that removes
the deduction removes the game.

### Deliberately not built

Profiles, personalization, adaptive difficulty, monetization, AI-vs-AI, model
selection, multiplayer. Recorded, not implemented.

---

## 14. `0.6.0.1` — corrections from Milestone 2 Test 1

### AMBIGUOUS was being used where the Composer had already decided

Observed: target `a bicycle`, question "Is it one particular thing?", answered
AMBIGUOUS with the explanation *"the target is a type of object rather than one
specific individual bicycle"* — an explanation that answers the question.

The rule added: **an explanation that resolves the question proves the question
was answerable.** AMBIGUOUS is now reserved for cases where two materially
different but equally reasonable readings give *different* answers, with an
explicit self-test — name both readings, or answer YES/NO. Nuance and edge cases
are not grounds.

### Semantic drift is prevented by storage, not by instruction

The same game answered as a category at Q2 and as a narrower subtype later
("does it have an electric version?" -> NO, which is only right if the target
was secretly "a conventional bicycle").

`granularity` and `modifiers` are now locked into `SecretRecord` alongside the
target and handed to the Composer **on every single turn**, in the same call
that supplies the target. The Composer cannot drift between readings because it
is never asked to remember which reading it chose. Same mechanism that already
stops target drift, applied one level down.

`generic_type` carries an explicit consequence: subtypes and variants are
instances of the target, so "is there an electric version?" is YES. And the
target-selection prompt forbids locking a generic word while privately meaning
something narrower — whatever narrows the target must be *in* the target.

### Ordinary language over technical defensibility

"Is this a tool?" about a bicycle was answered YES. Defensible, and misleading.
The Composer now classifies as an ordinary speaker would: a bicycle is a
vehicle. A technically-true YES that sends the player down a branch no ordinary
speaker intended is the wrong answer.

No ontology was added. This is a policy sentence, not a taxonomy.

### Question correction, and why the bar is asymmetric

Mobile autocorrect turned "Do the wheels have spokes?" into "The weeks have
spikes?", which was answered and cost a question.

The most recent question can now be corrected. A cheap model judges whether the
edit repairs *how the question was written* or changes *what it asks*. Accepted
edits keep the turn number, spend no extra question, and are re-answered against
the history as it stood **before** that turn — not against the Composer's own
first reply, which would let a stale answer anchor the new one.

The judge is told to **reject when unsure**, deliberately: a wrong rejection
costs one question, a wrong acceptance hands out a free question every turn and
dissolves the budget the whole game rests on.

Only the latest question is editable. Anything earlier would mean re-answering a
turn the player has already reasoned onward from.

---

## 15. `0.6.0.2` — non-disclosure, and why it is code

### The defect

Field Test #2, target `dog`, Q15 "Does it have long hair?" answered AMBIGUOUS —
correctly — with "Hair length varies enormously by breed, some dogs have long
hair...". The classification was right. The explanation handed over the answer
with five questions still unspent.

### The prompt was already told not to do this

That is the important part. `0.6.0.0`'s Composer prompt said the definition is
never shown to the player, and the model disclosed anyway. **A rule the model is
asked to follow is not an invariant.**

So `0.6.0.2` uses both, in this order:

1. **Prompt (prevention).** An explicit non-disclosure section naming the actual
   trap: explaining *why* a question is unanswerable by describing the target.
   "Say that the property varies within the category, never what the category
   is." Instruction to write every explanation as if read by someone who has not
   yet guessed — because it will be.
2. **`lib/disclosureGuard.ts` (guarantee).** A pure, deterministic check applied
   to every piece of visible model text before it is stored. Catches the target,
   its inflections, accent-folded forms, and the content words of a multi-word
   target.

The guard is what makes the invariant hold. The prompt is what stops it firing.

### Redaction shape, chosen deliberately

**An explanation that discloses is replaced wholesale, not edited.** Cutting the
word out leaves "…some ___ have long hair", whose shape is nearly as
informative as the word.

**A disclosing clue is dropped, not replaced.** A clue is optional help; a
generic one is noise dressed as assistance.

**The answer itself is always kept.** Only the prose is touched — the
classification was right in the observed failure and there is no reason to
discard it.

### Two bugs the tests caught before deployment

Both would have shipped a guard that silently did nothing:

- The combining-diacritics range was mangled into raw bytes, so accent folding
  never worked.
- A single-word target below the multi-word length floor got no inflections
  generated, so `dog` never matched `dogs` — **precisely the Field Test #2
  case**.

There is also a deliberate word-boundary test: `cat` must not match inside
`category`, or the safe replacement text would itself trip the guard.

### AMBIGUOUS — governing rule, locked

> Answer YES or NO when one is reasonably defensible under the ordinary meaning
> of the Racer's question. Use AMBIGUOUS only when committing to either YES or
> NO would materially mislead the Racer.

Nuance alone is not enough. The existence of edge cases is not enough.
`dog` + "does it have long hair?" remains a correct AMBIGUOUS.

### Deferred, recorded, not built

**AI self-correction of its own most recent answer.** Rule locked for future
use: correctable only before the Racer submits the next question; always visible
and logged; no silent history rewriting; immutable once the next question
arrives; older errors handled by integrity review rather than rewriting history.
Not implemented — the architecture does not support it trivially, and the
failure has not been observed in real play.

**Duplicate-question warning** ("You already asked this. Submit anyway?").
Deferred; not a Milestone 2 blocker.

---

## 16. `0.6.0.3` — generic-category AMBIGUOUS (provisional Milestone 2 sign-off)

### The defect

Medium game, target `penguin`, budget 35, Racer lost 35/35 guessing
`diving-petrel`. Questions like "Africa?" were answered YES because *some*
members of the category fit — sending the Racer down a branch most of the
category does not support.

### The correction, and the trap in making it

`0.6.0.1` pushed hard AWAY from AMBIGUOUS after the bicycle game. This pushes
back TOWARD it. Appending the new rule without reconciling the two would simply
swing the model back to over-using AMBIGUOUS, and we would have traded one
defect for the one we just fixed.

So the prompt now names **exactly two** justifications, and a test that
separates them from everything else:

1. **Two readings of the question disagree.**
2. **The category itself splits** — the question is true of some members and
   false of others.

> The test that separates these: does the split fall INSIDE the locked target,
> or have I merely found the question hard?

Members of the category disagreeing is a real split. Nuance, caveats and edge
cases are not. The `0.6.0.1` rule survives intact: a question the granularity or
definition settles must be answered, and an explanation that resolves the
question proves the question was answerable.

### Ordinary language, extended

"Does it spend most of its time over open water?" about a bird is most naturally
about flying above water. The prompt now forbids stretching wording toward
whichever reading yields the more convenient answer. If two genuinely reasonable
readings materially change the answer, that is AMBIGUOUS — not licence to pick.

### Non-disclosure, extended to the split case

A category-split explanation must say that members differ **without naming what
differs**: species, regions and subtypes identify a category as surely as its
name. The permitted shape is "some members of the target category fit that
description while others do not".

### A fallback that could itself leak

Testing the recommended wording against the guard surfaced something real: the
standard replacement text contains "category" and "characteristic". If the
locked target were one of those, substituting it would have handed over the
target **while purporting to protect it**.

There is now a two-stage fallback — a minimal replacement carrying no content
words, used whenever the ordinary one would disclose. Degenerate targets, but a
fallback that can leak is not a fallback.

### No new architecture

No taxonomy, no category schema, no all/most/some fields, no species data, no
ontology, no probabilistic scoring, no external lookup, no new granularity
types. `locked target + granularity + YES/NO/AMBIGUOUS + explanation` was
sufficient. This is a decision-policy change to one prompt.

---

## 17. Deferred after the 0.9.4.0 field test — NOT V1 scope

### Adjudication provenance (recorded, not changed)

Hidden target `bicycle`, human guess `stationary bicycle`, ruled incorrect. The
verdict was defensible, but the explanation leaned on distinctions — transport,
roads, trails — that had **not been established in the visible Q&A**.

That points at a real question nobody has answered yet: an adjudication
explanation currently mixes three different things without distinguishing them.

1. Facts inherent in the hidden target and its definition.
2. Facts established during play, in the transcript.
3. Inference the Adjudicator brought itself.

A player can only check the second. When a verdict rests on the third and is
narrated as though it rested on the second, the result feels arbitrary even when
it is correct.

**Nothing was changed.** No adjudication policy, integrity review, winner
determination, result semantics, scoring or related prompt was touched in TASK 7.
The V1 principle stands: **AI adjudication is procedurally final for the game
without claiming epistemic infallibility.**

### Disputed adjudication / community appeal (product concept)

Post-V1 concept from the same session: after a result, the player either accepts
it or disputes it; a disputed game can optionally be published with its history
and the player's argument, for community discussion or voting.

Possible value: transparent edge-case discussion, engagement, sharing, challenge
content, organic promotion.

**Not V1.** It needs accounts, publishing, moderation and a sharing
architecture — none of which exist — and it presupposes the provenance work
above, since a community cannot usefully argue about a verdict whose basis is
not visible.

Recorded so it survives the session it was thought of in.

---

## 18. Racer intelligence benchmarks — observed, recorded, NOT fixed

Two field games exposed reasoning weaknesses in the AI Racer. They are
recorded here as **benchmarks**, not as defects being repaired in `0.9.x`.
No Racer prompt or strategy change was made for either. Any future attempt to
make the Racer smarter should be measured against these two cases first,
because both are cheap to re-run and both fail in an obvious, visible way.

The reason for recording rather than fixing: Racer strategy is the single
highest-variance surface in the system. Changing it invalidates every previous
field observation, and we have no regression harness for question quality —
only for adjudication. Tuning strategy now would trade a measurable system for
an unmeasurable one right before V1.

### Benchmark A — "Red Citroën C4": weak global hypothesis management

**Target:** a specific red Citroën C4.

**Observed:** the Racer established the broad frame correctly and early —
man-made, vehicle, car — and then spent its remaining questions on locally
plausible but globally uncoordinated probes. It did not maintain a running
candidate set, did not visibly track which attributes were already pinned, and
re-tested territory that earlier answers had already settled.

**The failure is not any single question.** Each one is defensible on its own.
The failure is that the sequence has no memory of its own shape: the Racer
optimises the next question against the last answer rather than against the
whole transcript.

**What a fix would have to demonstrate:** that after N answers the Racer can
state its live candidate set and choose the question that best halves *it* —
not the question that best follows the most recent answer.

### Benchmark B — "My left leg": no reconsideration of the parent abstraction

**Target:** the player's own left leg.

**Observed:** the Racer repeatedly received containment-flavoured signals —
answers indicating the target was *part of* something, and specifically part of
a person — and did not revise the abstraction level it was searching at. It
kept asking questions appropriate to a whole object while the evidence said
"component of a body". Repeated IS-IS answers, which in this game mean *the
framing is wrong, not the topic*, were treated as noise rather than as the
signal they are.

**The related observation — the question/guess boundary.** In this game the
Racer also produced inputs that sit ambiguously between a narrowing question
and a guess ("Is it your leg?"). The Guess Detector resolves these by asking
the player to confirm intent, which is the correct mechanism and worked. But it
means the Racer can spend its single guess by accident of phrasing, and it means
question-shaped guesses are a live category rather than an edge case. Worth
watching; not changed.

**What a fix would have to demonstrate:** that a run of AMBIGUOUS answers causes
the Racer to re-ask *at a different level of abstraction*, not merely to re-cut
the same level along a different line.

### Status

Both benchmarks are **open**. Neither blocks V1. Neither has been fixed,
mitigated, or worked around in prompt text. If a later version claims to
improve Racer reasoning, these are the first two games to replay.

---

## 19. `0.9.8.0` — SÚGÓ, the explicit clue action

### Why the feature needed an action at all

The clue system shipped in `0.6.x` and worked exactly as designed: `clue_mode`
of `minimal` or `progressive` put a clue policy into the Composer's prompt, and
the Composer could attach `clue_text` to any answer.

Field play showed the flaw, which was not in the policy but in the trigger. A
clue could only ride along with an answer, and the model volunteered one
unreliably. A player who wanted help had no way to ask for it: typing "give me
a clue" into the question box is correctly rejected, because it is not a yes/no
question. The assistance existed and was unreachable.

`0.9.8.0` adds the trigger and changes none of the policy. `CLUE_GUIDANCE`,
the granularity rule, the transcript renderer and `scrubClue` are the same ones
answering has always used. There is deliberately no second clue architecture.

### Credits are derived, never stored

`lib/clueCredits.ts` computes everything from state the engine already keeps:

    earned    = floor(question_count / 10)
    used      = number of qa_log entries with turn_type "clue"
    available = earned - used

No counter is persisted. A stored counter is a second source of truth that can
drift from the transcript, and drift in a scarce resource is precisely the bug
a player notices and remembers. Deriving also makes the feature backward
compatible at no cost: a record written before `0.9.8.0` contains no clue turns,
so it reports zero used and behaves correctly without migration.

Credits accumulate. Not spending the credit earned at question 10 does not
forfeit it — at question 20 the player holds two.

### One route, two directions

`POST /api/game/[id]/clue` serves both, because the credit rule and the
transcript entry are identical and only the author of the text differs.

**AI Composer → human Racer.** The human presses SÚGÓ. The route checks
eligibility, calls `requestClueFromComposer`, and passes the result through
`scrubClue` — the same deterministic guard as every other Composer-authored
visible string. A clue is the one output whose entire purpose is to narrow the
search, which is exactly why it must not be the one output that skips the
check. The credit is spent by writing the log entry, so a failed model call
costs the player nothing.

**Human Composer → AI Racer.** The Racer chooses `action: "clue"` on its own
turn, which appends a clue entry with no text. That entry blocks the Racer in
`turn/route.ts` the same way an unanswered question does — without that block
the Racer would take another turn immediately and the human would never get to
write the clue. The human's text is stored unscrubbed: the guard exists to stop
the model revealing a secret it was entrusted with, and a human deciding how
much to give away about their own target is playing the game, not breaching it.

### Eligibility is not obligation

The Racer's action enum contains `clue` only when a credit exists, and the
prompt says plainly that being allowed to ask is not a reason to ask. If the
model returns `clue` when none was offered, the code refuses it rather than
minting a credit that was never earned.

No other part of Racer strategy was touched. The two deferred benchmarks in §18
remain open and unaddressed.

### What a clue costs

One clue credit. Zero questions, zero guesses. `question_count` is not
incremented on a clue turn, the single final guess is untouched, and a clue is
never recorded as an answer to anything.

---

## 20. `0.9.9.0` — one help channel

### What the first Hard/Progressive field test found

Ordinary IGEN and NEM answers arrived carrying explanatory text that materially
narrowed the target: that it was not a physical object, that it concerned a
bodily reaction, that emotion was involved. The text was accurate, well judged
and genuinely useful. That is what made it a defect. It was unlimited free
assistance running outside the earned clue-credit system, and it dissolved the
deduction the game is made of.

At question 10 the SÚGÓ button unlocked correctly and produced a proper clue —
proving these were two independent pathways, and that only one of them was
rationed.

### Root cause

Not model misbehaviour. The system was doing exactly what `0.6.x` specified.
`answerAsComposer` injected `CLUE_GUIDANCE` into every ordinary answer, and its
tool schema listed `clue_text` as a REQUIRED field. The progressive text said,
in as many words, "you may add a short helpful clue to any answer, and your help
should grow as the player's remaining questions shrink."

Asked for a clue on every turn, the model supplied one. It was answering the
question we kept putting to it.

### The rule now

    YES / NO   classification only. The answer is the whole reply.
    IS-IS      explanation, scoped to why neither binary would be accurate.
    SÚGÓ       deliberate strategic help. The only place it belongs.

`minimal` and `progressive` now govern the strength of an EXPLICIT clue and
nothing else. They no longer authorise anything on an ordinary answer.

### Why the field was removed rather than the instruction

A prompt rule saying "do not add a clue" while the schema still demands
`clue_text` leaves the invitation standing and relies on the model declining it.
`clue_text` is gone from the answer schema, `CLUE_GUIDANCE` is gone from the
answer call, and `answerAsComposer` no longer accepts a `clueMode` at all — a
parameter that steers nothing is an invitation to reconnect it later. The
per-answer clue slot was removed from the transcript for the same reason.

The AMBIGUOUS explanation survives, deliberately. Without it a genuine split is
indistinguishable from evasion. It is now scoped: say THAT the category splits,
not WHICH members fall on which side — the second is a clue wearing an
explanation's clothes.

### Note on how this shipped

No test asserted that ordinary answers carry no clue, because until the field
test that behaviour was the specification rather than the bug. The boundary is
now pinned in `test/cluePolicy.test.ts`, including the schema shape — the thing
that actually caused it.

---

# V2 — development lane

Everything above documents V1, which is signed off and frozen at commit
`8792b83` (`VERSION` 0.9.10.0). V1 remains the lifeboat: a known-good fallback
that V2 work must never destabilise. V2 runs from its own branch, its own Vercel
project, its own Upstash database and its own Anthropic key, so a V2 failure
cannot consume V1's state or its model budget.

## 21. `2.1.1.0` — anonymous persistent Player identity

### What exists after this increment

A visitor arrives and is silently given a stable Player identity. No
registration, no username, no password, no profile. They play immediately. On
returning from the same browser they are recognised as the same Player. From a
different browser they are someone new. Clearing cookies loses the identity, and
at this stage that is acceptable.

### The Player is a signed cookie, not a record

There is no `players` table, no player store, and no durable identity data
anywhere. The identity IS the cookie:

    bk_player = <128-bit hex id>.<HMAC-SHA256(id)>

The signature is what makes it real. A bare random id in a cookie is
client-asserted — anyone can set it to anything. Today nothing is attached to a
Player so forging one gains nothing, but `V2.4` attaches credits and
entitlements to this identifier, and an id that was ever forgeable is a bad
foundation for that. Signing costs a few lines now; retrofitting it later would
invalidate every player already in the wild.

This also keeps V2.1.1 out of the persistence decision that belongs to `V2.2`.
Nothing durable is written, so nothing has to be migrated when that decision is
made.

### Web Crypto, not node:crypto

`lib/playerIdentity.ts` is imported by `middleware.ts`, which Next runs on the
Edge runtime where `node:crypto` does not exist. `crypto.subtle` and
`crypto.getRandomValues` do, and are also present in Node 22, so one
implementation serves middleware, route handlers and tests.

### Two trust boundaries

**The cookie is verified, never assumed.** A tampered, truncated or
foreign-signed value returns null and is treated exactly like no cookie: the
visitor gets a fresh identity rather than an error. A cookie signed by the V1
deployment's key does not validate here, which is what keeps the two lanes'
identities from mixing.

**The inward header is stripped before it is set.** Middleware sets the cookie
on the RESPONSE, so on a visitor's very first request the browser has not
received it yet and a route handler would see nobody. Middleware therefore also
forwards the id inward on `x-bk-player`. That header is trustworthy only because
middleware unconditionally deletes any inbound copy first — before every return
path, including the one taken when identity is unconfigured.

### Missing secret disables identity rather than weakening it

With no `PLAYER_ID_SECRET` the middleware mints nothing and every game runs with
`player_id: null`. The alternative — minting unsigned ids — would produce
exactly the forgeable identifier this design exists to prevent. A misconfigured
deployment loses identity and keeps a working game.

### Where the acting Player is recorded

One nullable field, `GameRecord.player_id`. It is a reference, not a foreign
key: there is nothing for it to point at. It lives inside game state that
already expires on its own schedule.

Null is normal and always will be — identity may be unconfigured, and games
created before this increment never had it.

### The attachment point, and nothing else

The stable, unforgeable, server-verifiable Player ID is the attachment point.
Later milestones hang credentials, player type (Human/AI/Hybrid), profiles,
durable game records, relationships and entitlements off it. None of those are
built here, and no table, service, screen or abstraction was created in
anticipation of them.

### Matcher scope

Middleware runs on `/`, `/compose`, `/play/ai`, `/game/*` and `/api/game/*`.
`/about`, `/contact`, `/privacy`, `/rules` and `/play` are statically rendered
and are deliberately excluded — running middleware over them would make them
per-request for no benefit. `/` was already dynamic, so including it costs
nothing.

### Deliberately unchanged

Rate limiting still keys on IP. Moving it onto `player_id` would make the limit
resettable by clearing a cookie. The game engine, adjudication, SÚGÓ, budgets
and Racer behaviour are untouched.

## 22. `2.1.1.1` — KV namespace isolation

### Why this was not optional

Upstash would not permit a second free database, so V1 and V2 share one. That
was accepted as a temporary infrastructure compromise, and sharing the STORE was
tolerable — game and secret keys are UUID-scoped and cannot collide.

Sharing the COUNTERS was not tolerable, and separate Anthropic API keys did not
cover it. Two of the four key families are counters:

    ratelimit:create:<ip>:<hour>     guest limit, shared per IP
    budget:racercalls:<date>         daily AI spend ceiling
    budget:resolvecalls:<date>       daily AI spend ceiling

The ceilings live in KV, not at the vendor. `callBudget` fails closed. So V2
traffic could drive the shared counter to its limit and V1 would then refuse to
start games — with V1's own Anthropic key untouched and full. The binding
constraint was never the vendor quota; it was Barkóba's own counter.

That directly contradicted the lifeboat rule that V2 must not be capable of
degrading V1's AI availability.

### The fix, and why it is one wrapper

Every KV operation already funnels through `getKV()`. Wrapping the returned
client is therefore the entire change: `NamespacedKV` prefixes the key and
delegates. The four key builders in `gameStore`, `secretStore`, `rateLimit` and
`callBudget` are untouched and structurally cannot forget to apply it — a fifth
key family added later inherits the namespace for free.

`KV_NAMESPACE` defaults to empty, which reproduces V1's key shapes byte for
byte. **V1 therefore needs no change and no redeploy**, which is what made this
safe to land in the V2 lane alone. V2 sets `v2:`.

The prefix is read on every call rather than captured at construction, because
`getKV()` memoizes its client — a captured prefix would freeze the namespace for
the life of the process and silently ignore configuration. There is a test for
exactly that.

### Known limitation — deliberately not solved

This separates the DATA, not the ACCOUNT. Free-tier command and storage quotas
remain shared, so V2 can still exhaust V1's database allowance. Fixing that
requires a second Upstash database and is recorded here as an open
infrastructure item, not a code problem.

Existing V2 keys written before this change are orphaned. They expire on the
normal 24-hour TTL; nothing needs migrating.

## 23. `2.1.1.2` — candidate identification in the Guess Detector

### The gap

The "My left ear" field test ended with the Racer asking, in sequence, whether
the target was the eye, the nose, then the ear. Each cost one question. None was
flagged.

The detector is a pure function, so this was provable without recovering the
game record: every plausible phrasing scores **zero**. Not near the threshold of
3 — no rule fires at all. "Is it the ear?" has no proper noun, no quoted span,
no possessive construction and no explicit guess frame, which was the entire
basis on which the detector scored guess-likeness.

That contradicted the module's own stated purpose — catching an output declared
as a question whose text is functionally a guess — and its stated bias that
over-flagging is the safe direction.

**No rule was violated.** The `confirm_guess` / `continue_questioning` machinery
behaved correctly; it was simply never reached. The gap was in detection.

The harm in this particular game was nil: the Racer went on to declare a real
guess and adjudication correctly rejected "ear" as insufficiently specific. The
risk is the inverse case. With a common-noun target, "A bicikli az?" scores zero,
is answered YES, and the Racer has confirmed the target for the price of one
ordinary question with no adjudication ever run.

### The rule

The discriminator is **definiteness**, not interrogative form:

    "Is it a vehicle?"      indefinite  -> which CATEGORY. Not a guess.
    "Is it the bicycle?"    definite    -> which ONE. Functionally a guess.

Hungarian marks the same distinction with the same two words — "egy" for the
category reading, "a"/"az" for the identifying one — so one idea covers both
languages instead of two rule sets.

Weight 3, which reaches the threshold alone. Three limits keep it narrow:

1. **The noun phrase must end the question**, at most three tokens. "Is it the
   kind of tool used in gardening?" runs past that and does not match.
2. **Strong category vocabulary disqualifies the shape outright.** Relying on
   the -2 hedge was not enough, because other rules can suppress hedging.
3. **It is not counted as naming evidence**, so hedges still apply to it.

Possessive determiners count as identifying alongside "the": "Is it your left
ear?" names which one just as definitely. On the Hungarian side the same
pattern absorbs adjectives and possessive suffixes, which closes the observed
"A bal füled az?" weakness without a separate rule.

### What did not change

Detection only. A flag still costs nothing but an internal re-prompt, still
never reaches the human Composer, and `resolveGuessIntent` remains authoritative
over whether the guess is consumed. Racer strategy is untouched. The
compound-question / IS-IS observation stays deferred to V2.5.

### Bare fragments are deliberately excluded

"Fül?" and "Élőlény?" are the same shape — one is a candidate, one is a
category — and nothing lexical separates them. Flagging fragments would also
break the tolerance added in 0.9.5.0.

### Regression fixture

`inst-6`: target "My left ear", guess "ear", expected **incorrect**. The live
adjudicator got this right in the field; the fixture exists to keep it that way.
Note that the fixture corpus is exercised only by `npm run eval:adjudicator`,
which has still never been run against a real key.
