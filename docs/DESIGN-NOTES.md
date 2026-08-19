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

## 14. DEFERRED — cap the AI-Racer question budget before wider release

**Status: tracked, deliberately not implemented. Revisit before any wider
release, or sooner if field data warrants.**

`2.3.0.0` gave every human Composer the full `20 / 35 / 50 / 100` allowance,
including on the AI-Racer path. Difficulty recommends one; the Composer may
override it.

The consequence is a cost one, and it is real:

| Budget | Racer model calls per game | Games/day under `RACER_DAILY_CALL_CEILING=2000` |
|---|---|---|
| 20 (recommended, easy) | ~20–25 | ~80–100 |
| 100 (available) | ~100–125 | ~16–20 |

So a player who favours 100 costs roughly five times as much as one who takes
the recommendation, and the daily ceiling — which exists to bound spend, not to
ration play — starts behaving like a rationing mechanism.

Human↔Human is unaffected: no AI runs per turn there, so a 100-question
two-player game costs the same as a 20-question one.

**Why it was NOT capped now:** nobody has yet chosen a budget in the field. The
premise that players will reach for 100 is an assumption, and capping on an
assumption would remove a control the Composer legitimately owns — the whole
point of the override is that the person who set the target knows how far it is.

**Cheapest fix when the data says so:** restrict the AI-Racer path to `20 / 35`,
or lower `RECOMMENDED.hard` in `lib/questionBudget.ts`. Both are one-line
changes; neither needs a migration, and the Human↔Human range stays untouched.

**What would trigger it:** budget selection skewing high in real games, or the
daily Racer ceiling actually being hit.

---

## 13. V2.2 — durable game corpus (`2.2.0.0`)

V2.1 gave Barkóba persistent Players. V2.2 gives it persistent experience.
Before this, every game was destroyed 24 hours after it was created.

### Two stores, two jobs

PostgreSQL (Neon) is **durable memory**. Redis stays **operational state**.
Nothing that lived in Redis moved. Redis remains authoritative during play;
PostgreSQL is a write-behind mirror that no gameplay path ever reads.

### The corpus hook lives in `saveGame`, not in six routes

`/ask`, `/turn`, `/clue`, `/correct` and `/resolve` all end by calling
`saveGame()`, including the error paths that deliberately save a recorded answer
before returning 502. Wrapping that one funnel is the whole change — the same
argument `NamespacedKV` made for wrapping `getKV()`. Six copies of the call
would be six chances for a future route to silently stop recording history.

Redis is written and awaited **first**. Nothing after that line can change what
the player experiences.

### Incremental write was forced, not chosen

There is no abandonment signal anywhere in the engine: no heartbeat, no
`beforeunload`, no disconnect event, and on serverless no process to notice.
Abandoned, interrupted and stalled games all die identically and silently at the
TTL.

So a "finalise the record at the terminal transition" design would have captured
only cleanly completed games — and would have discarded exactly the failed and
abandoned games the milestone exists to preserve. Full-state incremental sync
follows from that, not from taste.

### Preservation threshold: one completed question/answer

A game enters the corpus once one question has actually been answered. Below
that there is no reasoning path to reconstruct. `complete` and `worth
preserving` are deliberately different questions — an abandoned three-question
game is preserved; a zero-turn game is not.

`lifecycle_state` and `outcome` are orthogonal columns so an unresolved game
never has to invent an outcome.

### Declassification was WIDENED, not duplicated

The corpus needs the target's definition and granularity — the evidence the
granularity-adjudication questions will eventually be answered with. Those live
in `SecretRecord` and died with its TTL.

Two options existed. Adding `lib/corpus/gameCorpus.ts` to
`PERMITTED_SECRET_IMPORTERS` was **rejected**: one deliberately widened seam is
auditable, two seams that each look reasonable in isolation are how an invariant
erodes. Instead the single declassification point in `/resolve` now copies
`revealed_definition`, `revealed_granularity`, `revealed_modifiers` and
`revealed_locked_at` alongside `revealed_target`, at the same instant under the
same rule. `lib/corpus/*` reads only public state and is listed in `QUARANTINED`
so that is mechanically enforced.

**Accepted cost:** a game that never resolves never declassifies, so abandoned
games carry no target metadata at all. Isolation outranks research completeness.

### Raw is separated from derived by schema, not by naming

`corpus.*` is append-only and immutable once finalized, enforced by a trigger.
`derived.*` is freely mutable and always references `corpus` by FK.

The dormant `QuestionLogEntry` fields (`quality_score`, `information_gain`,
`strategy_classification`) were **not** migrated into `corpus.game_turns`. They
are derived analysis wearing a raw-evidence costume — §6 says dormant fields stay
dormant, and the schema honours that by putting them where they belong. A test
asserts they never appear in the raw turns table.

`derived.analysis_runs` exists so two readings of the same turn can coexist and
disagree, each attributable to the model, prompt version or human that produced
it. That is impossible if a score is a column on the raw turn.

### `adjudicator_confidence` was already being generated and thrown away

`AdjudicatorResult.confidence` has been produced since M4 and documented as
"Recorded for tuning", and the resolve route dropped it. It is now stored raw —
not interpreted, not normalised, not turned into a quality metric.

### Reconciliation is opportunistic, and that is a trade

A failed corpus write queues the game id; the next game creation replays it from
Redis while the record is still alive. That turns a Neon outage into delayed
evidence rather than lost evidence, within the 24h window.

Known limits, stated rather than discovered later: the queue is one JSON array
under one key (because `lib/kv.ts` deliberately has no scan and widening it for
this would be the worse trade), so concurrent failures can race; it is bounded;
and reconciliation only runs when someone starts a game. The upgrade path is a
scheduled caller of the same function.

The sweep half needs no Redis at all — a row still `in_progress` long after its
`last_activity_at` is reclassified in pure SQL, and `last_phase` says honestly
whether it was abandoned mid-play or stalled in adjudication.

### Player deletion unlinks; it is not anonymization

Interim pre-public policy: deletion sets `player_id` to NULL and the game
survives as evidence. `/privacy` says plainly that this is **not** full
anonymization, because the questions and targets are the player's own words and
Barkóba's own benchmarks are "my left ear" and "MuShu". Claiming otherwise would
be the comfortable lie. The permanent public erasure model is explicitly
deferred; cascade deletion already works via `ON DELETE CASCADE` and
pseudonymization would be a column change, not a redesign.

`player_id` is one of only two fields the immutability trigger lets through on a
finalized game — erasure must remain possible on finished evidence.

### `collection_context`

Every row is stamped `pre_public_research`. Provenance, not consent. Retrofitting
a collection basis onto rows gathered before it existed is impossible; recording
it now costs one column.

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

## 24. V2.5 Game Intelligence benchmark — compound questions

Recorded from the MuShu field test on `2.1.1.2`. **Not addressed, and deliberately
so** — this is question-construction discipline, not a reasoning or adjudication
failure, and it belongs with the Racer-intelligence work deferred to V2.5
alongside the §18 benchmarks.

### What happened

The Racer produced questions that are not binary propositions at all:

    "Fish, amphibian, reptile, bird or mammal?"
    "Does the target live in the wild, or under human care, for example on a
     farm or at home?"

These force IS-IS by construction. No single YES or NO can represent them
faithfully, so the answer carries almost no information and the question is
spent.

### The Composer discipline this established

The human Composer did **not** repair the malformed questions by volunteering
which clause was true. A neutral IS-IS was given instead.

That is the correct behaviour and worth stating as a principle:

> A malformed compound question must not be rewarded with extra semantic
> information supplied by the Composer.

Repairing it for the Racer would hide the defect, hand over information the
question did not earn, and make the weakness unmeasurable — the Racer would
appear to handle compound questions well because a human quietly fixed them.

### The encouraging half

After the ambiguous answer the Racer recovered by decomposing the problem into
atomic questions, and its reasoning immediately improved:

    #11  lives wild?              NO
    #12  lives under human care?  YES
    #13  farm animal?             NO
    #14  horse?                   NO
    #15  domestic companion/pet?  YES
    #16  dog?                     YES  -> guess

So the capability is present; the discipline to use it consistently is not. That
distinction matters for V2.5: the work is constraining question FORM, not
teaching the Racer to reason.

### What a fix would have to demonstrate

That the Racer emits one proposition per question without being told which
clause a previous compound question failed on — and that it does so from the
first question, not only after an IS-IS has already cost it a turn.

### Status

Open. Does not block V2.1. Third entry in the deferred Racer-intelligence set,
after Red Citroën C4 and My Left Leg.

### Adjudication evidence from the same game

`cat-7` (MuShu → "dog") joins `inst-6` (My left ear → "ear") as the second
real-game confirmation that identifying the right category does not identify the
locked target. Two hard games, same principle, correct both times. The
adjudication architecture was not changed in response — it was working.

## 25. `2.1.2.0` — optional display name

### What it is, and what it deliberately is not

After choosing a role and before game setup, a first-time player is asked once:
*"Hogy szólítsunk?"* — enter a name, or skip. That is the whole feature.

It is **not** registration. No email, no password, no account, no recovery, no
profile page, no name editing. It gives the existing anonymous Player a
human-friendly label and nothing else.

### Storage: a second signed cookie, no record anywhere

`bk_player_name` = `<base64url(name)>.<HMAC(playerId + NUL + name)>`

The signature covers the id **and** the name together, which binds the name to
one identity: it cannot be edited client-side and cannot be lifted onto another
player. Base64url because Hungarian accents are guaranteed input and raw
non-ASCII in a cookie value is not safe.

Kept separate from `bk_player` on purpose. Identity and display data stay
independently replaceable — changing a name never re-issues the identity — and
the "identity is not a profile" separation then holds in the storage layout
rather than only in the prose.

**One cookie carries three states**, so there is no second flag to drift out of
sync:

    absent                never asked      -> ask
    present, empty name   asked, skipped   -> never ask again
    present, with a name  named            -> use it

The skip **writes the cookie too**. That is what makes skipping a real answer
rather than a dismissal that returns on every visit.

No players table, no durable record, nothing that forces the V2.2 persistence
decision. `GameRecord` deliberately does **not** gain a `player_name` field:
attaching a name to a game is historical-record design and belongs to V2.2.

### Where it is asked

`/compose` and `/play/ai` — the first screens after the role choice on `/play`.
Both were already `force-dynamic` server components, so the gate reads the
httpOnly cookies with no new plumbing. The middleware matcher gained
`/api/player/:path*`, without which the name route would see no acting player.

Skip is styled at the same weight as continuing: same size, same row, equal
width. A quiet grey skip beside a bright primary button is a dark pattern, and
this is the first thing a new player meets — before they have seen the game or
have any reason to give us anything.

### Privacy page: a correction, not an addition

`/privacy` stated that no cookie handling existed in the code. **That was true
of V1 and became false in `2.1.1.0`**, when the identity cookie shipped and the
page was not updated with it. The page now discloses both cookies, what each is
for, and that neither is analytics, advertising or cross-site tracking — because
neither is. A test asserts the old claim cannot come back.

The standard this restores is the one set when the page was written: never claim
we collect nothing unless the implementation proves it.

### Name handling

Optional, capped at 40 characters, trimmed, control characters stripped,
rendered through normal React escaping. No moderation, because the name is
currently visible only to the player who chose it.

**That changes at V2.3.** The moment Human↔Human ships, a chosen name becomes
visible to a stranger and impersonation and abuse become real concerns. The
trigger for moderation is V2.3, not V2.4 — recorded here so it is not
discovered late.

### Effect on later identity claiming

Mildly positive. Because the name is signed over the player id, it travels with
that identity when a credential eventually claims it — no orphan record to
reconcile, no schema to migrate. The only loss mode is the pre-existing one:
clear the cookies, lose the player and the name together.

## 26. `2.1.3.0` — claiming and recovering a Player

Completes V2.1. An anonymous Player can optionally protect their identity and
recover the SAME identity on another device. Still no registration, no email, no
password, no vendor.

### Why a recovery code and not a passkey

Passkeys were the better mechanism on friction and security, and were rejected
for one reason: a passkey is cryptographically bound to the domain it was
registered on. Barkóba's permanent production domain is not settled, so every
claimed identity would have been orphaned by a later move, with no migration
path. A printed string is bound to nothing.

If the domain settles, passkeys remain the natural upgrade — and can be added
alongside, since both resolve to the same `player_id`.

### The code

    BARKOBA-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX

15 random bytes = 120 bits. 24 Crockford base32 characters x 5 bits = 120 bits.
Those numbers are equal deliberately: 15 bytes divides evenly into base32, so
there is no truncation and no padding remainder, and the entropy quoted is the
entropy generated. An earlier draft of this design claimed 160 bits for a
25-character code that actually carried 125 — the arithmetic is now pinned by a
test.

Crockford excludes I, L, O and U, so nothing is ambiguous read aloud. The
`BARKOBA` prefix carries no entropy; it exists so a player who finds the string
in a note months later knows what it is.

### Storage

    player:<playerId>    { display_name, created_at, claimed_at, recovery_key }
    recovery:<sha256>    { player_id }

Both with NO TTL — the first thing in Barkóba that must never expire.

The raw code is never stored. The key IS the SHA-256 of the normalized code, so
recovery is a direct lookup rather than a search, and there is no comparison
step and therefore no timing side channel.

**Unsalted, unkeyed, and correct.** The usual objection to a fast hash applies
to LOW-entropy secrets that can be enumerated offline — the password problem. A
120-bit random code has no enumerable space, so hash speed is irrelevant. Salting
would break the design outright, since the hash must be derivable from the code
alone to serve as the key. And because no server secret participates,
**recovery survives any future rotation of `PLAYER_ID_SECRET`** — an earlier
draft used an HMAC and would have tied permanent recovery to a rotatable key.

`recovery_key` is stored on the player record so deletion can remove both
records directly. Redis cannot search values cheaply and a scan would degrade
with every player.

### Normalization

People retype these from paper: lowercase, no dashes, extra spaces, O/0
confusion. All of it is normalized before hashing. Rejecting a legitimate code
is the worst possible failure for a credential that cannot be reissued, so the
variants are pinned by test.

Order matters: the prefix is stripped BEFORE the O to 0 substitution, or
"BARKOBA" becomes "BARK0BA" and stops matching.

### Ordering in the two write paths

Claim writes the recovery record first: a crash between the writes leaves a code
resolving to a player that does not exist yet, and recovery simply reports "not
found". Delete removes the recovery record first: a crash leaves an unreachable
player record, which is inert. Both orders are chosen so the surviving artefact
is the harmless one.

### No rotation in V2.1

Re-claiming is refused rather than issuing a second code. Silently invalidating
a code the player may have written down is the fastest way to destroy trust in a
recovery mechanism. Rotation is a deliberate future decision, not an oversight.

### Name precedence

For a claimed Player the durable `display_name` is authoritative and the cookie
is cache — that is what makes the name travel to a new device. Anonymous players
keep the cookie-only name unchanged.

### Deletion

On the same small protected-player surface, not a profile page. Removes both
records and clears both cookies: the player asked to be forgotten, so the local
identity goes too and they return as a newcomer.

### Known limitation

V1 and V2 keys are separated by `KV_NAMESPACE=v2:`, but both lanes still share
one Upstash free-tier resource. That was acceptable for 24-hour game state. It
is less comfortable now that a lost key means a lost person rather than a lost
game. A dedicated V2 database is increasingly desirable — not a V2.1 blocker,
and no migration work is authorized.

### The honest risk

A bearer code is exactly as strong as the player's ability to keep it. There is
no reset, because there is nothing to reset it against. The UI says so before
generating the code rather than after.

---

## 27. `2.5.0.x` — Game Intelligence evidence foundation

**LINEAGE. This section was written at `2.5.0.0` and has been corrected since.**
The foundation froze at `2.5.0.0` / `3123275`; the work below it did not stop
there, and two claims in the original text became false. Current lineage:

| Build | What it did |
|---|---|
| `2.5.0.0` / `3123275` | evidence foundation: migration 0005, per-turn provenance |
| `2.5.0.1` | B4 — recoverable Racer turn failures (GROK-02 / GROK-03) |
| `2.5.0.2` / `5d76f12` | B5 — repaired `answered_at` and `branch_seq` capture |
| `2.5.0.3` | Racer seat configuration reported at `/api/version` |
| `2.5.0.4` / `c981504` | Guess Detector: `cél` added to the Hungarian candidate vocabulary (§31) |
| `2.5.0.5` / `637833e` | game language separated from the UI shell (§32) |

Between `2.5.0.0` and `2.5.0.2` the provider boundary and the xAI/Grok Racer
also shipped (B2, B3) — see §29. Migration `0005_intelligence_provenance.sql`
remains the only schema change; B4, B5 and the provider work are code-only.

V2.5 began as foundation, not as an attempt to solve Racer intelligence, and it
ends the same way. Nothing here makes the Racer better. It makes the Racer
**measurable**, which is the precondition for ever knowing whether a later
change helped.

### What the audit actually found

The V2.5-1 evidence audit was verified read-only against a real completed
AI-Racer game — `bd14b386-9837-4cd1-a293-0788aec77ce1`, `app_version` 2.4.0.0,
hard, 100-question budget, 84 questions used, 18 AMBIGUOUS, outcome
`racer_incorrect`.

The result was the opposite of the expected one. The transcript layer was
**sound**: `turn_index` contiguous 1–85, counters reconciling exactly, no
timestamp disorder, and raw Racer output preserved with a non-empty rationale on
86 of 86 stored turns. The reasoning was already durable.

What was missing was never the reasoning. It was everything needed to say
**whose** reasoning it was. Across every persisted `raw_output` object in that
game the only keys were `action`, `guess_text`, `question_text`, `rationale`.
No model, no provider, no version, anywhere in the record.

That is the finding the milestone rests on: an 84-question hard game against an
unknown model is analysable as reasoning and worthless as a benchmark. Every
game in the corpus before 2.5.0.0 is in that condition, permanently, and the
three named benchmarks (§18-A Red Citroën C4, §18-B My Left Leg, §24 compound
questions) are worse still — they predate the corpus entirely and exist only as
prose describing games nobody can now identify the player of.

### What was added, and what was deliberately not

Six nullable columns on `corpus.game_turns`, two on `corpus.games`. No trigger
change, no backfill, no default, no `NOT NULL`, no table rewrite.

- `model_id` — the model the **API reported having used**, not the alias the
  request asked for. Those differ whenever a configured id resolves to a dated
  snapshot, and only the resolved one is evidence. Recording the requested id
  would have been a half-fix.
- `model_provider` — constant today. The column exists now because adding it
  later would mean altering the schema in the middle of the first comparison
  that needed it, and a column added mid-experiment cannot describe the rows
  already collected.
- `prompt_version` — `app_version` and `commit_sha` locate the exact source
  text and are a working proxy **while one prompt exists per deployment**. They
  stop being one the moment two Racer variants run at a single commit, which is
  the entire point of benchmarking. The proxy expires exactly when it starts to
  matter.
- `answered_at` — `occurred_at` is when the *Racer's* turn row was created. The
  answer was written back onto that same row later with no timestamp of its own,
  so the only derivable quantity was an interval that also contained the model
  call. Composer think time and model latency were inseparable.
- `pre_revision_question_text` — a Guess-Detector flag destroyed the original
  question on **both** resolution branches: `confirm_guess` nulls it,
  `continue_questioning` replaces it. The corpus recorded the second question as
  though it were the first, beside `guess_detector_flagged=true` with no
  evidence of what was flagged. §18-B's question/guess-boundary observation was
  unmeasurable by construction until this column existed.
- `branch_seq` — `buildTurnRows` flattened `abandoned_branches` into one bucket
  with no marker, and `turn_index` legitimately repeats across branches.
  `occurred_at` does not separate them: an abandoned turn carries its original
  creation time, not its discard time.
- `benchmark_case_id` / `benchmark_run_id` — prospective only. See below.

Deliberately still absent, all logged as useful-later and none blocking: token
usage and per-call latency (the dependency `lib/questionBudget.ts` already names
for recalibrating the Play Credit curve), truncation events, failure/retry
events, and the guess-intent sub-call's raw output.

### Why model and prompt live on the turn, not the game

Identical reasoning to migration 0003's refusal of a game-mode column. A
game-level `racer_model_id` would restate what the turns already say and create
two sources of truth that can drift — and it would silently lie about a game
that straddled a configuration change, attributing every turn to whichever model
happened to be configured at the end.

### Why NULL had to stay meaningless

No column got a default and none got `NOT NULL`. `NULL` must keep meaning
"not captured", never "unknown model". A backfill would assert a fact about
historical rows that nobody observed. Analysis must **exclude** null-provenance
turns from model comparison rather than assume a model for them.

This is also why `COALESCE(existing, EXCLUDED.…)` was rejected in the writer's
upsert. It fails twice over: on a finalized row with a NULL `model_id`, filling
it in is still a change and still raises the immutability trigger — and it would
be wrong where it worked, because writing today's model id onto a turn played
before capture existed invents evidence.

### Benchmark identity is prospective, and that is a constraint not a choice

`corpus.reject_finalized_mutation` (0001, amended 0003) exempts exactly four
fields from the finalized-row lock: `player_id`, `composer_player_id`,
`racer_player_id`, `collection_context`. `benchmark_case_id` is not among them
and will not be added — widening an immutability exemption to buy a convenience
is how the guarantee erodes.

The accepted consequence: a game that has already finalized can **never** be
tagged. `bd14b386` is an excellent benchmark candidate and is permanently
untaggable in `corpus.*`. Retroactive designation of an existing game has one
legal home, `derived.*`, and populating it was explicitly out of V2.5 scope.

Ingress fails closed. `BENCHMARK_INGRESS_SECRET` unset means tagging is out of
service and every attempt is silently ignored — the game is still created, just
untagged. A benchmark set any client can write into is not a benchmark set, and
because the row is immutable once finalized, a mistag can never be removed.

### The acknowledged residual — READ THIS BEFORE CHANGING THE CORPUS WRITER

**The finalized-game re-sync mutation path remains unexercised in PostgreSQL.**

`reject_finalized_turn_mutation` (0002) permits a no-op re-sync of a finalized
game's turns and raises on any real change. The repair and replay passes re-sync
completed games routinely. If a new column's value could differ between the
original write and a later re-sync — and `model_id` can, because the env
override may move, and `prompt_version` can, because it is bumped on purpose —
the trigger would raise and roll back the **entire transaction**, taking the
repair pass with it.

**CORRECTED AT `2.5.0.2`. The original text said all eight new columns are
written on `INSERT` only and appear in no `DO UPDATE` set-list, and instructed
anyone adding a column to keep it that way. That rule was too broad, it was
wrong, and following it literally would re-break `answered_at`.**

The distinction is not whether a column is new. It is **when its value becomes
knowable**.

**Class A — known at row creation, and possibly different on a later re-sync.**
`model_id`, `model_provider`, `prompt_version`, `pre_revision_question_text`.
These are **INSERT-only** and must stay out of `DO UPDATE`. `model_id` can
differ because the env override may move; `prompt_version` because it is bumped
on purpose. Updating either would change a finalized row, raise, and roll back
the whole transaction with the repair pass inside it. `COALESCE` would be wrong
here even where it was safe: writing today's model id onto a turn played before
capture existed asserts a fact nobody observed.

**Class B — write-once-later: NULL becomes a value exactly once, during active
play, and never changes again.** `answered_at`, `branch_seq`. Neither is
knowable when the row is inserted — the answer arrives on the *next* request,
and the branch number is assigned when a rewind happens. These belong in
`DO UPDATE`, wrapped:

```sql
answered_at = COALESCE(corpus.game_turns.answered_at, EXCLUDED.answered_at)
branch_seq  = COALESCE(corpus.game_turns.branch_seq,  EXCLUDED.branch_seq)
```

Sweeping Class B into the Class A rule is why neither column was ever written.
Production proved it: `answered_at` appeared on `turn_index 001` alone — an
artefact of the preservation threshold inserting turn 1 after it was answered —
and `branch_seq` was NULL on 6 of 6 abandoned turns across 5 recorded
corrections. Both are confirmed working since `2.5.0.2`.

`branch_seq` needed a second fix as well: the demotion statement set `branch`
alone over `turn_id = ANY(array)`, a shape that **cannot** carry a per-turn
sequence number. It is now a per-turn `jsonb_to_recordset` join. The
demote-before-upsert ordering is unchanged and still load-bearing.

This is not a new pattern. `corpus.games.finalized_at` has used
`COALESCE(existing, EXCLUDED)` since V2.2 for exactly this reason. V2.5-3 had
the right idea and applied it to the wrong set.

The test that pins this was **correctly relaxed** into two: Class A absent from
`DO UPDATE`, Class B present *and* `COALESCE`-guarded rather than a bare
`EXCLUDED` assignment. Do not merge them back.

### The accepted residual, as it actually stands

Class B fills a NULL on re-sync, which on a **finalized** row is a real change
and would raise. In normal play this cannot happen: both fields are set while
the game is still in the questioning phase, so the transition always lands
before finalization, while the trigger is dormant.

The bounded exception, **accepted by decision rather than engineered away**: a
game finalized *before* B5, still resident in Redis (<24h TTL), re-synced
*after* B5 would attempt a NULL→value fill on a finalized row and fail. It is
non-destructive — nothing is written, the transaction rolls back, the failure is
logged, and the finalized evidence is untouched — and the window self-clears
with the Redis TTL. The alternative was a not-finalized guard permanently
complicating the statement that carries every turn Barkóba records. The bounded,
self-clearing, harmless failure was judged the better trade.

### Production acceptance — Field Test #1, "Air"

Deployed `2.5.0.0` / `3123275`. Verified on real production data:

- 21/21 turns captured `model_id`, `model_provider`, `prompt_version`.
- Recorded identity: `claude-haiku-4-5-20251001` / `anthropic` / `racer/2.5.0`.
  The model id is the dated snapshot, confirming the resolved-not-requested
  capture works rather than echoing configuration.
- Counter reconciliation exact: questions 20 = 20, ambiguous 1 = 1.
- Main turns 21 = highest `turn_index` 21. No gaps.
- `raw_output` impurity: **0 turns**. Provenance did not leak into the
  participant's own structured output, which is what the wrapper types
  (`RacerTurnResult`, `ComposerAnswerOutcome`) exist to guarantee.
- 13 pre-V2.5 completed games. **0** historical turns retroactively
  provenance-stamped — the additive migration touched no existing evidence.
- 0 incomplete historical records requiring repair.

### A process obligation, not a feature

`RACER_PROMPT_VERSION` is bumped **by hand**. A changed prompt with an unbumped
constant produces confidently mislabelled evidence, which is worse than no
label. Treat bumping it as part of editing the prompt, not as follow-up.

A hash was considered and rejected: it changes on a typo fix and says nothing
about whether the strategy changed. A deliberate label is a claim someone made
on purpose, which is what a benchmark comparison has to rest on.

---

## 28. Field Test #1 — "Air": two observations, NEITHER PROMOTED

First game played under `2.5.0.0`. Both entries below are **observations
only**. Neither is promoted to implementation work, and no Racer prompt or
strategy change was made for either — the same posture as §18 and §24.

What is different this time, and it is the whole reason the milestone existed:
**these observations are attributable.** They belong to
`claude-haiku-4-5-20251001` under `racer/2.5.0`, recorded per turn. Every prior
benchmark describes a game whose player cannot now be identified. This one can
be re-run against another model and compared honestly.

### RACER-INTELLIGENCE — elimination without narrowing

**Target:** air. **Budget:** 20 questions, fully consumed. **Outcome:** guessed
water.

**Observed:** the Racer spent its budget largely on serial category elimination
and failed to convert accumulated NO answers into positive narrowing of the
hypothesis space. Having excluded many ordinary categories, it did not pivot
toward substance, gas, or environmental questions, and ended by naming water.

**The failure is not any single question.** Each exclusion is defensible alone.
The failure is that a long run of NOs carried no cumulative inference: the
Racer treated elimination as progress in itself rather than as evidence
constraining what the target must be.

**Relationship to the existing set.** This is adjacent to §18-A (weak global
hypothesis management) but not identical. §18-A is about failing to maintain a
candidate set across a transcript. This is narrower and sharper: negative
evidence accumulating without ever being turned into a positive hypothesis.
Recorded separately rather than folded in, because a fix for one would not
obviously be a fix for the other.

**What a fix would have to demonstrate:** that after a run of NO answers the
Racer can state what the target must therefore *be*, and ask against that —
not merely continue proposing untried categories.

**Status: open. Not promoted.**

### LANGUAGE-CONTAMINATION — `химикус` in Q20

**Observed:** question 20 contained the Cyrillic, non-Hungarian token
`химикус`, rendering part of an otherwise Hungarian question unreadable to the
player.

**What worked, and is worth stating plainly.** The human answered AMBIGUOUS,
which is exactly correct: a question that cannot be read cannot be answered as
a binary proposition, and AMBIGUOUS means *the framing is wrong, not the topic*.
Integrity adjudication then recognised and contained the problem. Nothing about
the game's outcome was distorted, and no mechanism had to be invented — the
existing IS-IS channel absorbed it.

**Q20 is preserved as the reference specimen.** It is the first recorded
instance of the Racer emitting text outside the language of play, and it is
attributable to a specific model and prompt version. That makes it a usable
regression case rather than an anecdote.

**Deliberately not treated as a prompt bug to patch.** `RACER_SYSTEM_PROMPT`
already carries explicit language-of-play instruction and extensive Hungarian
phrasing guidance. A model that violated it anyway is evidence about the model,
and editing the prompt in response would destroy that evidence before anyone has
measured how often it happens or whether another model does it at all. The
§24 principle applies: repairing a defect for the Racer hides it and makes the
weakness unmeasurable.

**What a fix would have to demonstrate:** that the Racer emits only the language
of play, without the prompt being made more emphatic about a rule it already
states.

**Status: open. Not promoted.**

### The deferred Racer-intelligence set, as it now stands

| Ref | Case | Attributable? |
|---|---|---|
| §18-A | Red Citroën C4 — weak global hypothesis management | No — predates the corpus |
| §18-B | My left leg — no reconsideration of the parent abstraction | No — predates the corpus |
| §24 | Compound questions — question form, not reasoning | No — predates the corpus |
| §28 | Air — elimination without narrowing | **Yes** |
| §28 | `химикус` — language contamination | **Yes** |

All five are open. None is promoted. The first three can only ever be re-run as
*new* games under the new capture; they cannot be recovered as data. That is the
permanent cost of having built the corpus after the benchmarks, and it is the
reason V2.5 shipped provenance before anything else.

---

## 29. Field Test #2 — "Grok": the fast scout, and a new failure mode

First full game played by a non-Anthropic Racer.

| | |
|---|---|
| Build | `2.5.0.3` |
| Provider / model | `xai` / `grok-4.20-0309-non-reasoning` |
| Prompt version | `racer/2.5.0` — **identical to the Claude games** |
| Game | 20 questions, completed |
| Target | Grok |
| Final guess | Wolfram Alpha — **incorrect** |
| Server-side latency | ~1.8–3.5s per turn, measured from `answered_at` |

### GROK-01 — CLOSED

The Racer seat became provider-selectable in V2.5-B3, and the first Grok games
were unplayable. The Step 0 probe found why, and the number is worth recording
because it explains the entire GROK-01/02/03 cluster at once:

| Configuration | Median turn | Verdict |
|---|---|---|
| `grok-4.6`, effort unset (= `high`) | **69.3s** (57.8–102.6) | above the 60s function ceiling |
| `grok-4.6` + `reasoning_effort: low` | 10.0s | viable fallback |
| `grok-4.20-0309-non-reasoning` | 2.6s | chosen |
| `grok-4.3` + `effort: none` | 1.7s | reserve, untested for play |

All four cleared Barkóba's forced-tool contract 3/3 with the existing schema —
including the nullable `["string","null"]` unions, which xAI documents as the
correct form. No prompt or schema change was needed for any of them.

Barkóba had never sent `reasoning_effort`, and grok-4.6 defaults to `high`. So
the **median** Grok turn was being killed by Vercel before it could return. The
early Grok games did not stall; they were terminated. Field Test #2's production
timings (1.8–3.5s) confirm the probe independently.

**GROK-01 is closed for the fast-scout configuration.** No further latency work
unless field evidence reopens it.

### The Racer-intelligence specimen — observation, NOT a promoted rule

**Observed.** Strong early hierarchical narrowing: the Racer moved down the
ladder cleanly and reached "search engine" quickly and correctly. Then it locked
on that parent. It spent its remaining questions testing *siblings within the
branch* while negative and ambiguous answers accumulated against the branch
itself, never reopened the parent hypothesis, and guessed Wolfram Alpha.

**The failure is not the final guess.** Given "search engine", Wolfram Alpha is
defensible. The failure is that a run of contradictions never triggered a
re-examination of the category that generated the candidates.

**Relationship to the existing set.** Adjacent to §18-A (weak global hypothesis
management) and §28 (elimination without narrowing), but distinct from both.
§18-A is failing to *maintain* a candidate set; §28 is failing to convert
negatives into a positive hypothesis. This is the inverse: a positive hypothesis
held *too well*, with contradictory evidence absorbed as noise instead of
counted against the parent. Recorded separately because a fix for any one would
not obviously fix the others.

**The candidate principle, stated but not adopted:**

> Narrow aggressively while evidence supports a branch; reopen aggressively when
> accumulated contradictions weaken the parent hypothesis.

**Status: open, n=1, NOT promoted.** No prompt or strategy change was made. One
game cannot distinguish a pattern from a game, and the §18 rule holds: recording
beats fixing until there is something to measure a fix against.

**Attributable.** Like §28 and unlike §18/§24, this specimen names its player:
`grok-4.20-0309-non-reasoning` under `racer/2.5.0`, recorded per turn. It can be
replayed against Claude or against Grok 4.6 on the same prompt, honestly.

### V2.5 open items at this point

- **G3 — benchmark identity: built, never exercised.** The columns, the index
  and the secret-gated ingress all shipped at `2.5.0.0`.
  `BENCHMARK_INGRESS_SECRET` is unset and **no game has ever been tagged**. The
  three pre-corpus cases (§18-A, §18-B, §24) still cannot be re-run as data.
- **G4 — `pre_revision_question_text`: still unobserved.** The Guess Detector
  has not fired in any recorded game, so the column built to measure §18-B's
  question/guess boundary has zero rows. Shipped and unproven.
- **GROK-02 — recovery live, not production-exercised.** B4's guard reset and
  retry control work by test, but no production stall has exercised them, and at
  ~2.6s per turn the window that triggered them has largely closed.
- **`grok-4.6` at default/high remains incompatible with the 60s ceiling.** A
  standing precondition on any fast→strong routing design. Final guesses must
  not be routed to it without resolving the timeout separately.
- **Routing deliberately unbuilt.** Scout-quality evidence is n=1. The decision
  waits on evidence, not on the mechanism being available.

---

## 30. Verdict challenge and community review — DEFERRED

Recorded so it survives the session it was thought of in. **No V2.5
implementation commitment, and none is scoped.**

Either participant — human **or AI** — should eventually be able to challenge a
verdict, and to request community review of an adjudication that is borderline,
perspective-dependent, internally inconsistent, or simply wrong.

Barkóba already produces the raw material: `corpus.game_resolutions` stores the
Adjudicator's verdict, its confidence and its reasoning, the Integrity Review's
verdict and the turns it flagged, and `corpus.game_targets` holds the target and
the definition adjudication rested on. A challenge would be an interpretation of
that evidence, so it belongs in `derived.*` — a challenge is a *reading* of a
game, never a rewrite of it. `corpus.*` stays immutable; a contested verdict
gains a second opinion beside it rather than a correction inside it.

**Why it is deferred, not scheduled.** It needs durable community identity,
moderation, and a sharing surface — none of which exist — and it presupposes the
provenance work that only just landed. It is the same shape as §17's deferred
community layer and blocks on the same missing infrastructure.

The `derived.analysis_runs` / `derived.turn_annotations` tables created empty in
migration 0001 are already the right home: they can hold two contradictory
readings of the same turn, each attributable to the model, prompt version or
human that produced it. That was the point of creating them before anything
needed them.

---

## 31. Field Test #3 — the direct-guess leak, and `2.5.0.4`

Second full Grok 4.20 game. Build `2.5.0.3`, target **Grok**, final guess
**Windows**, lost at 20/20. Latency remained good; this test was not about speed.

### What happened

The Racer asked four candidate-identity questions as ordinary questions, and was
answered four times:

    A cél a Microsoft?   ·   A cél az Apple?
    A cél a Google?      ·   A cél a Linux?

Barkóba permits **one** guess. These were functionally four more.

### The investigation, and why it did not become a new subsystem

The obvious reaction — build a question gate, add an LLM referee, add a second
classifier — was refused until the existing machinery had been measured. That
measurement is the whole finding:

| | Score | Flagged |
|---|---|---|
| `A cél a Microsoft?` | 2 | no |
| `A célpont a Microsoft?` | 5 | **yes** |
| `A cél a fül?` | **0** | no |

`FLAG_THRESHOLD` is 3. The detector **ran on every question, was not bypassed,
and returned the correct answer for the rules it had.** `CANDIDATE_IDENTIFICATION_HU`
knew `célpont`, `válasz`, `megfejtés`, `megoldás` and `titok` — every natural
Hungarian word for the target **except the shortest and most common one**, which
is also the word the prompt and the interface both use throughout. Grok's four
questions scored 2 from `proper_noun` alone, one point short.

Worse, `A cél a fül?` scored **zero**: without a capitalised candidate, no rule
fired at all.

**Root cause: vocabulary, not architecture.** The fix was one token —
`(?:célpont|cél|válasz|…)`. No new classifier, no referee, no prompt change.

The fixtures had encoded the same blind spot: `CANDIDATE_QUESTIONS` already
contained `A célpont a fül?`, the identical frame using the word the rule knew.
The suite was green while production leaked. The four production strings are now
fixtures, and the tests assert **which rule fired**, not merely that the score
cleared the threshold — a future weight change could otherwise lift them over
without the candidate rule matching, and the suite would pass while the defect
returned.

### What the system already did, and still does

Investigation confirmed the enforcement path was never advisory:

- the detector runs on every AI question **before** it reaches the human;
- a flag re-prompts **the Racer itself** to declare intent;
- `confirm_guess` converts the turn and **consumes the single guess**;
- `continue_questioning` uses the **Racer's own** rewording — Barkóba never
  silently rewrites a question;
- `pre_revision_question_text` is captured on flag.

So the deferred product question "should a functional guess consume the single
guess?" was already answered in code. It simply never triggered.

### Two residuals recorded at `2.5.0.4`, both deliberately unfixed

**False positives on the same frame.** `A cél a konyhában található?`,
`A cél a szabadban van?`, `A cél a te tulajdonod?` all flag. This is
**pre-existing** — verified against the unmodified module, `A célpont a
konyhában található?` already flagged — so `cél` broadens *exposure*, not the
behaviour class. It is also the direction the module chose on purpose: a false
flag costs one cheap internal re-prompt, a miss hands out a free guess.
Tightening it means separating a naming noun phrase from a predicate in
Hungarian, which needs the native-speaker review this codebase has never had.

**Enforcement is fail-open on one path.** If a question flags but
`resolveGuessIntent()` cannot complete — budget exhausted, or the call throws —
the flagged question stands as an ordinary question. A functional guess can
still reach the human under that failure mode. Fail-closed has product
consequences (consume the guess / reject and regenerate / an explicit rule), so
it is scoped separately rather than patched in.

Both are documented in `lib/guessDetector.ts` itself, where the next person to
edit the pattern will actually look.

---

## 32. Field Test #4, `2.5.0.5`, and the V2.5 closure audit

### The language defect

Game language was **hardcoded `"hu"` at all three creation sites**. Not derived
from anything — there was no mechanism. Meanwhile the Validator reported the
submission's dominant language on every single game, and the value was **read
nowhere**.

Both that behaviour and the one it replaced made the same mistake in opposite
directions: an earlier build inferred language from the Composer's words alone,
so an English target turned the entire product English, and the fix pinned the
game to the interface. **Shell language and game language are separate.** The
Hungarian shell may host either.

`2.5.0.5` resolves one rule for both creation paths:

```
1. an explicit "hu" | "en" from the player   -> use it
2. a valid detected language                  -> use it   (null on the AI path)
3. otherwise                                  -> "hu"
```

Three-state control — **Automatikus / Magyar / English** — because a one-word
target (Grok, Apple, Tesla, Air) tells a detector nothing about which language
the human meant. AUTO restores the original intent; the explicit options handle
what detection provably cannot.

**No i18n layer, and none planned.** The buttons stay Hungarian. Only
model-generated, player-visible output follows the value. Inspection confirmed
the downstream plumbing was already complete and correct — Racer, Composer
answer and re-answer, clue, Adjudicator and Integrity Review all read
`game.game_language` — so setting it at creation was the entire fix. No schema,
no migration.

### Field Test #4 — PASS

Build `2.5.0.5` / `637833e`.

- Hungarian UI shell, selector left on **AUTO**.
- Human entered the target **"Grok"** in English.
- The entire Grok Racer game proceeded **in English**, with no manual selection.
- **No drift back to Hungarian** at any point in the game.
- Full 20-question game completed.
- Grok speed remained excellent — observed as faster than Claude in this run.

Dynamic game-language selection is **field-proven for this case**. GROK-01 stays
closed; do not reopen absent contrary evidence.

### Game Intelligence — separate from acceptance

**Parent-hypothesis lock-in repeated. That is now three consecutive Grok 4.20
games** (§29 "search engine" → Wolfram Alpha; §31 brand siblings → Windows;
§32). Strong early narrowing, an intermediate hypothesis becoming over-trusted,
accumulating contradictions absorbed as noise, sibling testing instead of
reopening the parent, failed final guess. **n=3 is a pattern, not a game.**

**New observation:** the game produced multiple IS-IS answers whose
*explanations* carried information beyond the categorical label. The Racer
receives `ambiguous_explanation` and appears not to use it as evidence. Recorded
as a distinct hypothesis from lock-in, though the two plausibly interact.

Candidate principle, still **NOT promoted**:

> Narrow aggressively while evidence supports a branch; reopen aggressively when
> accumulated contradictions weaken the parent hypothesis.

No prompt or strategy change has been made for any of this, per §18's standing
rule: record until there is something to measure a fix against.

### G4 — CLOSED, and closed by the residual it was meant to measure

Field Test #4 produced **10 turns at `app_version 2.5.0.5`** with
`guess_detector_flagged = true`, `pre_revision_question_text` populated, and
`guess_intent_outcome = continue_questioning`.

The instrument built at `2.5.0.0` to measure the §18-B question/guess boundary
has its first production rows, and the whole chain is verified end to end:
detect → capture the original → re-prompt the Racer → record the outcome. **G4
is closed with production evidence.**

It closed for an unplanned reason, which is worth stating plainly: **not one of
those ten was a real guess.** The column filled because the detector
over-flagged, not because the Racer tried to sneak a guess through. The
instrument works; what it caught was the residual next door.

### The false-positive residual — CONFIRMED IN PRODUCTION, and it is TWO defects

Field Test #4 flagged ordinary discovery questions:

    Is the target a physical object?     ·  Is the target a person?
    Is the target a concept or idea?     ·  Is the target a natural phenomenon?
    Is the target a company or corporation?

All resolved `continue_questioning`, so **no guess entitlement was wrongly
consumed** and no game was decided incorrectly.

**But these are English, and §31's residual is Hungarian. They are not the same
defect and must not be filed together.**

`CANDIDATE_IDENTIFICATION_EN` pattern 2 reads:

```
(?:is|was) the (?:target|answer|thing|object|word) (?:a|an|the) <noun phrase>
                                                    ^^^^^^
```

It admits the **indefinite** article — while this module's own documented
discriminator, three comment blocks above it, says the opposite:

> `"Is it a vehicle?"` indefinite → asks which CATEGORY. Not a guess.
> `"a"/"an"` is excluded — that is the category reading and must stay unflagged.

Pattern 1 obeys that rule. Pattern 2 contradicts it. The consequence is measured:

| Question | Score | Flagged |
|---|---|---|
| `Is it a physical object?` | −2 | no |
| `Is the target a physical object?` | **+3** | **yes** |

The same question, opposite verdicts, on phrasing alone.

**This is an internal inconsistency in English, not an ambiguity in Hungarian.**
The Hungarian residual is genuinely hard — separating a naming noun phrase from
a predicate needs native-speaker judgement this codebase has never had. The
English one needs no such review: the rule simply disagrees with its own stated
doctrine, and the fix is to stop pattern 2 accepting `a|an`. Scoped separately
and deliberately not patched here, but it is the strongest candidate for the
first change after the freeze.

### A confound this creates for the Game Intelligence evidence

**Ten of roughly twenty turns were flagged, and every flag re-prompts the Racer
to reword a question it had already framed correctly.**

That is not free. `resolveGuessIntent` asks for "a rephrasing that cuts the space
without naming a single specific candidate" — for questions that named no
candidate to begin with. So in Field Test #4 the Racer was pushed off its own
phrasing roughly half the time, and each flag also spent a second model call.

Any reading of §29/§31/§32's parent-hypothesis lock-in **must account for this**.
It does not invalidate the n=3 pattern — §29 and §31 were Hungarian games where
this English rule could not fire — but it means Field Test #4 is the weakest of
the three as evidence about the Racer's unaided reasoning, and a fourth data
point should be gathered after the English pattern is corrected.

Recorded here rather than in the deferred workstream because the confound is a
property of *this* build, and whoever next reads the lock-in evidence needs to
know before drawing a conclusion from it.

### V2.5 closure audit

| Item | Status | Evidence |
|---|---|---|
| G1 model/provider/version | **CLOSED** | 4 field tests, 100% per-turn coverage |
| G2 prompt_version | **CLOSED** | `racer/2.5.0`, identical across providers |
| G5 `answered_at` | **CLOSED** | B5 + Field Test #2 production timings |
| G6 `branch_seq` | **CLOSED** | populated on a real abandoned rewind branch |
| GROK-01 latency | **CLOSED** | 1.8–3.5s/turn, three consecutive games |
| GROK-03 correction stall | **CLOSED** | B4; a production correction completed and recorded |
| Game language vs shell | **CLOSED** | Field Test #4 |
| Guess Detector `cél` leak | **CLOSED** | `2.5.0.4`, unit-proven |
| G4 `pre_revision_question_text` | **CLOSED** | 10 production rows at `2.5.0.5`, full chain verified |
| G3 benchmark ingress | **DEFERRED** | built at `2.5.0.0`, secret unset, **zero tagged games** |
| GROK-02 recovery path | **ACCEPTED RESIDUAL** | live, never production-exercised; trigger window largely closed |
| Guess Detector FP — English | **ACCEPTED RESIDUAL** | **confirmed in production**, ~10/20 turns; internal inconsistency, no review needed |
| Guess Detector FP — Hungarian | **ACCEPTED RESIDUAL** | pre-existing family; needs native-speaker review |
| Guess Intent fail-open | **ACCEPTED RESIDUAL** | §31; product decision pending |
| B5 finalized re-sync window | **ACCEPTED RESIDUAL** | §27; bounded, self-clearing |
| Grok 4.6 / 60s ceiling | **DEFERRED** | precondition on routing; nothing routes to 4.6 |
| Fast→strong routing | **DEFERRED** | deliberately unbuilt |
| Parent-hypothesis lock-in | **DEFERRED** | n=3; Game Intelligence workstream |
| IS-IS explanations as evidence | **DEFERRED** | new at §32 |
| Verdict / community review | **DEFERRED** | §30 |
| English UI shell | **DEFERRED** | later scope; game language is now independent of it |
| Hungarian native-speaker review | **DEFERRED** | §5, §31 |

**Nothing in this table blocks the freeze.** V2.5's aim was an evidence
foundation, and the foundation is production-proven: who played, under which
prompt, at what speed, through which branch, in which language. What remains is
either a bounded residual that is written down where it will be found, or a
*use* of the foundation that belongs to the milestone which uses it.

---

## 33. V2.5 post-freeze governance addendum

**Documentation and classification only. No V2.5 engineering is reopened.**
Written after the milestone-boundary review confirmed the freeze. Everything
below records how decisions were made and how evidence should be weighed — none
of it changes what was built.

### 33.1 Grok was a deliberate scope expansion, not part of the original charter

The V2.5 charter **explicitly excluded** Grok integration and multi-AI
comparison. Every task brief through the evidence-foundation work carried the
guardrail *"do not start Grok integration"* alongside no-RAG, no-agents and
no-fine-tuning.

That changed by an explicit **Mission Sovereign decision**: Zsolt authorised
Grok/xAI to move out of an external feasibility harness and into the production
Racer architecture, and the provider boundary (B2), the xAI adapter (B3) and
everything downstream followed from that authorisation.

Recorded because the record would otherwise read as though multi-provider work
had always been in scope. It was not. It was added on purpose, by decision, in
the middle of the milestone. **The implementation remains accepted and frozen —
this documents the decision, it does not reconsider it.**

### 33.2 Two-provider capacity — §14 carry-forward

§14 defers capping the AI-Racer question budget before wider release, and its
arithmetic rests on `RACER_DAILY_CALL_CEILING=2000`. Both were reasoned under
**substantially single-provider, Claude-shaped assumptions**.

V2.5 ended with two providers whose measured characteristics differ materially —
`grok-4.20-0309-non-reasoning` at ~2.6s per turn against Claude Haiku's ~8.5s
median, at different per-token prices, with `grok-4.6` at default effort
unusable at 69.3s. The ceiling counts **calls, not cost or latency**, and it is
shared across providers.

Carried forward as an explicit requirement to reassess, **not solved in V2.5**:

- whether the ceiling should stay combined or become provider-specific;
- the pre-launch AI-Racer budget-cap decision in §14, now that per-game call
  volume and per-call cost vary by provider;
- provider-specific economics and capacity assumptions generally.

Note that `lib/questionBudget.ts` already flags a related dependency: the Play
Credit curve is explicitly arbitrary and awaits token-level telemetry. These
should be reassessed together rather than separately.

### 33.3 English Guess Detector — DIAGNOSED / UNFIXED DEFECT

Reclassified from "accepted residual" to a **diagnosed, unfixed defect**.

`CANDIDATE_IDENTIFICATION_EN` pattern 2 accepts `a|an` in a
target-identification frame, contradicting the discriminator this module
documents three comment blocks above it: *"`a`/`an` is excluded — that is the
category reading and must stay unflagged."* Pattern 1 obeys the rule; pattern 2
does not. Measured consequence: `Is it a physical object?` scores −2 and passes,
`Is the target a physical object?` scores +3 and flags.

**This is distinct from the Hungarian false-positive problem**, which is a
genuine ambiguity between naming and predicating and stays deferred for
native-speaker review. The English one requires no linguistic judgement — the
rule simply disagrees with itself.

**It should be the first engineering cleanup after the V2.5 boundary, and it
should land before any serious English benchmark run**, because each false flag
re-prompts the Racer to reword a question it had already framed correctly and
therefore contaminates the question trajectory being measured.

### 33.4 Parent-hypothesis lock-in — corrected evidence accounting

Status: **REPEATED FIELD EVIDENCE / WORKING HYPOTHESIS.** Not an established
causal diagnosis, and not a licence to change Racer strategy.

The evidence is **two games, not three**:

- **Field Test #2** (§29) — strong early hierarchical narrowing → "search
  engine" parent → repeated sibling/candidate exploration despite accumulating
  negative evidence → failed final guess, Wolfram Alpha.
- **Field Test #3** (§31) — technology/software/brand branch → repeated
  sibling/candidate exploration → failure to reopen the parent → final guess
  Windows, while the target was Grok.

**Field Test #4 is excluded from the evidentiary count.** Approximately ten
Guess Detector interventions in that game re-prompted the Racer to reword
questions it had framed correctly, so its question trajectory was not natural
and cannot be read as unaided reasoning. It must not be used to strengthen the
hypothesis.

The hypothesis does **not** fall back to n=1: the two earlier games were
Hungarian, where the English pattern-2 defect could not fire, and both show the
pattern independently.

Candidate principle, still not promoted:

> Narrow aggressively while evidence supports a branch; reopen aggressively when
> accumulated contradictions weaken the parent hypothesis.

### 33.5 The V2.5-2A reconstruction gate — EXECUTED, not superseded

**Correcting the premise: this gate was run.** It was not forgotten, and its
evidentiary purpose was not superseded by later field testing.

The read-only reconstruction was executed against a real completed AI-Racer
game, `bd14b386-9837-4cd1-a293-0788aec77ce1` (`app_version` 2.4.0.0, hard,
100-question budget, 84 questions used, 18 AMBIGUOUS, outcome
`racer_incorrect`), using SELECT-only queries against production Neon. Its
findings are recorded in §27 and are load-bearing rather than historical: that
reconstruction is what established the transcript layer was sound, that G1 was
the blocking gap, and — through the follow-up queries on the same game family —
that G5 and G6 were broken.

Later field testing **strengthened** those findings with independent evidence;
it did not replace them. Nothing here was skipped, and no test is claimed that
did not run.

### 33.6 Grok Build CLI — UNCONFIRMED, and the original note is not in this repository

**I could not locate the earlier note.** Searching `docs/`, `lib/`, `app/`,
`scripts/` and `README.md` for "Grok Build", "grok-build", "build CLI" and
"CLI" returns **no matches**. If that observation was recorded, it lives outside
this repository — Notion, or another session — and this is the first time it
appears here. It is written down now rather than left to memory.

**The claim, carried forward as UNCONFIRMED:** Grok Build CLI capability was
described by Grok itself and has never been independently verified.

**What V2.5 does and does not verify.** V2.5 verified the **xAI HTTP API**:
`POST https://api.x.ai/v1/chat/completions`, bearer auth, forced function
calling, 3/3 contract compliance, and production games. That is the entire
extent of the verification. It says nothing whatsoever about a Grok Build CLI —
different product, different surface, different claim. **Do not treat the
production API integration as evidence for the CLI.**

Remains UNCONFIRMED unless independent evidence resolving it is added.

### 33.7 Freeze status

**V2.5 FREEZE REMAINS CONFIRMED.**

This addendum changes documentation and governance classification only. No V2.5
engineering is reopened, no code, schema, version, environment or deployment is
affected, and every item above is either a record of how a decision was made or
a requirement carried forward to a later milestone.

---

## 34. V2.6 opens — `2.6.0.0`, the English candidate-identification correction

**First change after the V2.5 freeze.** Scope: `lib/guessDetector.ts`,
`CANDIDATE_IDENTIFICATION_EN` pattern 2, and its regression fixtures. No prompt,
no schema, no strategy change. `RACER_PROMPT_VERSION` stays `racer/2.5.0` —
nothing the Racer reads was touched.

### 34.1 Why this had to be first

§32 measured the defect in production and named it the strongest candidate for
the first post-freeze change. The reason is not the false flags themselves —
none consumed a guess entitlement, and no game was decided incorrectly. The
reason is **contamination of the evidence base**.

Every flag re-prompts the Racer through `resolveGuessIntent()` to reword a
question it had already framed correctly. In Field Test #4 that happened on ten
of roughly twenty turns. Any English benchmark run on the uncorrected build
measures a Racer that is being pushed off its own phrasing half the time, and
spending a second model call each time it happens. The V2.5 milestone existed to
build a durable evidence foundation; running English benchmarks against this
defect would have poured contaminated data into it on day one.

### 34.2 Two changes, in opposite directions

**Change 1 — narrowing. The indefinite article is rejected.**

```
before:  (?:is|was) the (?:target|answer|thing|object|word) (?:a|an|the) <NP>
after:   (?:is|was) the (?:target|answer|thing|object|word)
                                     (?:the|your|my|his|her|its|their) <NP>
```

Pattern 2 admitted `a|an`, contradicting the definiteness discriminator stated
in the module's own comments and obeyed by pattern 1. Measured effect:

| Question | before | after |
|---|---|---|
| `Is it a physical object?` | −2, no flag | −2, no flag |
| `Is the target a physical object?` | **+3, FLAGGED** | **0, no rule fired** |

All five Field Test #4 production strings now score 0 with no rule firing.

**Change 2 — widening. The possessives are accepted.**

Found while correcting the first. Pattern 1's own comment has always read *"'the'
and the possessives are equally identifying"* — but only pattern 1 acted on it.
`Is the target your left ear?` scored **1 and did not flag**: an unambiguously
identifying question read as an ordinary narrowing one. That is the precise miss
this module's header says it exists to catch, sitting inside the rule being
edited.

**The two changes pull in opposite directions, and were bundled by explicit
Mission Sovereign decision after the alternative — scoping the widening
separately — was put and declined.** The consequence is recorded rather than
argued: **the next English field test's flag rate measures their combined
effect, not the removal of `a|an` alone.** A rate that does not fall is not
evidence that change 1 failed; it is evidence that change 2 replaced some of
what change 1 removed. Whoever reads that number needs this paragraph first.

### 34.3 Verification

- **618 tests pass**, `tsc --noEmit` clean, isolation invariant holds
  (134 files, 10 permitted call sites, 30 quarantined modules).
- Five new fixture blocks in `test/guessDetector.test.ts`, built on the **five
  Field Test #4 production strings, verbatim**.
- The fixtures assert **`candidate_identification` does not fire**, not merely
  that the question does not flag. A later weight change could drop these under
  the threshold while the rule still fired, and the suite would stay green while
  the defect survived invisibly — the same trap §31 fell into, where "A célpont
  a fül?" passed while production leaked four functional guesses.
- One fixture pins the pair `Is it a bicycle?` / `Is the target a bicycle?`
  against `Is it the bicycle?` / `Is the target the bicycle?`, so patterns 1 and
  2 cannot silently disagree on definiteness again.
- One fixture re-checks the Field Test #4 strings **after** the widening, so the
  determiner expansion cannot quietly readmit the indefinite reading.

### 34.4 Version

`VERSION` moves `2.5.0.5` → **`2.6.0.0`**.

Not cosmetic. §32 requires a fourth Game Intelligence data point gathered after
this correction, and `app_version` is the only column in the corpus that
separates a post-fix game from Field Test #4. Leaving the tag at `2.5.0.5` would
have made the two indistinguishable in exactly the data V2.5 was built to
produce.

### 34.5 What this does NOT close

- **Hungarian false positives** (§31, §32) — untouched. Genuinely hard,
  needs a native-speaker pass. Do not narrow that pattern by guesswork.
- **Guess Intent fail-open** — if `resolveGuessIntent()` cannot complete, the
  flagged question still stands. A product decision, still open.
- **G3 benchmark ingress** — built at `2.5.0.0`, still never exercised, still
  zero tagged games.
- **Parent-hypothesis lock-in** — n=3 across §29, §31, §32, with §32 the
  weakest of the three for the reason given there. No prompt or strategy change
  has been made for it, per §18's standing rule.

---

## 35. V2.6 Task 2 — Contest Verdict foundation

**Scope: capture only.** A completed game's verdict can be contested by a
participant, once, immutably, with the evidence preserved as it stood. Nothing
reviews, votes on, moderates or reverses a contest. Result Dispute is homed
here as the user-facing mechanism; its adjudication is not built.

### 35.1 Two ratified decisions, and why each was escalated rather than assumed

Both surfaced during investigation and were referred to Mission Sovereign
before any code was written, per Task 2 §10's stop rule.

**A. Durable participant identity — the strict rule.**

`lib/seats.ts` `resolveSeat()` falls back for single-human modes: an unassigned
Composer seat belongs to whoever is asking. That is correct and safe for a LIVE
game, which has exactly one human by construction. Applied to a HISTORICAL
game it would hand any authenticated visitor a seat on every game recorded
before durable seats existed (pre-`2.3.0.0`) or created while identity was
unconfigured.

**Ratified:** contest authorization requires a **non-null durable seat id on the
corpus row equal to the requesting player**. No fallback, no backfill, no
inference. Games without durable participant identity are **not contestable in
V2.6** — an accepted compatibility boundary, recorded as one rather than
discovered later as a bug.

Only the REQUESTING participant's seat must prove durable ownership. An AI
Racer seat is null and always will be; that must not stop the human Composer
contesting, and it does not.

This mirrors an existing precedent rather than inventing a rule:
`getSecretForComposer()` already refuses unless `composer_player_id` is non-null
and matches. Contest authorization is the same shape, applied to the corpus.

**B. Privacy unlink — contests follow the corpus erasure model.**

`unlinkPlayer()` NULLs all three id columns, and migration 0003 widened the
immutability trigger specifically so erasure still works on finalized evidence.
A contest holding a `player_id` outside that sweep would make the erasure
guarantee quietly false.

**Ratified:** `unlinkPlayer()` clears contest linkage in the same call.
`player_id` becomes NULL; the contest, the argument, the snapshot, the seat, the
captured verdict and the timestamps all remain; the original game is untouched.
No fallback re-identifies a former contestant.

**This is the only permitted post-creation mutation of a contest.** The trigger
enforces it, and enforces a second thing the first rule alone would not: that
`player_id` may only ever travel toward NULL. Permitting the column to *change*
would allow a contest to be reassigned to a different player — worse than the
edit the trigger exists to prevent.

### 35.2 Evidence visibility — the rule, and the one reading that needed stating

**Ratified:** use the existing completed-game participant visibility rule.
`revealed_target` may be included, because the result screen already exposes it
symmetrically to both participants (`GameView.revealed_target`, written at the
single declassification point in `/resolve`). `corpus.game_targets` stays out —
a separate grant surface, intersecting the parked target-validator authority
question.

**The reading that had to be made explicit:** `revealed_target` has exactly one
durable home, and it is `corpus.game_targets.target`. Redis is TTL-scoped, so
the field the decision permits and the table the decision excludes are the same
table. Implemented as: **select `target` and nothing else**. Definition,
granularity, modifiers and locked_at are not read, not copied, and not
reachable. The snapshot stops precisely where the result screen stops.

Recorded rather than resolved silently, because a later reader comparing the
decision to the SQL would otherwise see a contradiction.

**Two further omissions, decided here on §8's do-not-weaken-isolation rule:**

- `raw_output` is **not** copied. It carries the Racer's own `rationale` —
  private reasoning that no live projection shows the Composer. Filing a
  contest must not become the route by which one seat reads the other's
  thinking.
- The snapshot contains **no player identifiers at all**. Seats appear as roles
  plus `*_seat_recorded` booleans. Had ids been embedded, erasing player B would
  leave B's identifier inside player A's snapshot, out of reach of the sweep,
  and decision B above would be false in practice while true in the schema.

Neither is absent from the evidence base — both remain reachable through the
corpus via `corpus_game_id`, under whatever grant a review runs with. They are
absent from the SNAPSHOT, which is a participant-readable artefact.

### 35.2a Retrieval is contestant-owned, not participant-shared

**Frozen V2.6 product decision, ratified as a pre-production correction to the
first implementation.** The first cut authorized retrieval against the source
game's durable seats — either participant could read either contest. That is
broader than V2.6 supports and was corrected before migration 0006 was applied.

**The rule now:**

| Operation | Authorization |
|---|---|
| POST create | durable seat on the corpus row matches the caller |
| GET list for a game | durable seat gates the response; only the caller's OWN contest is returned |
| GET one contest | authenticated player equals a **non-null** `contest.player_id` |

**Creation and retrieval deliberately ask different questions.** "May you
contest this verdict?" is a question about the game. "Is this yours?" is a
question about the contest. The asymmetry is intentional, not an inconsistency.

**The ownership test lives in the SQL**, not in the route. A route can forget a
guard; a query that cannot return another player's row has no guard to forget.
Same reasoning that put the identity check inside `getSecretForComposer()`
rather than in the route calling it.

**Accepted consequence, stated rather than patched.** Privacy unlink sets
`player_id` to NULL, and a NULL matches no requester. An erased contest
therefore remains durable historical evidence — argument, snapshot, seat,
captured verdict and timestamps all intact — **with no end-user retrieval
path**. This is intended. It is not approximated with a fallback, and V2.6 adds
no reviewer, admin or community door. A test greps the module and both routes
for `admin`, `reviewer`, `moderator`, `is_staff` and `bypass` outside comments,
so the gap cannot be quietly filled later without that showing up as a failure.

Reviewer and community authorization are separate scope.

The list endpoint returns an empty array both for a participant who never
contested and for one whose contest was erased. V2.6 provides no way to tell
those apart, deliberately — distinguishing them would leak the existence of a
record the erasure was meant to detach.

### 35.3 Why a new table, and why in `corpus.*`

`corpus.games` is immutable once finalized. A contest is created long after
finalization, so it could not be a column on that row without weakening the
guarantee the corpus exists to provide.

`corpus.*` rather than `derived.*` because a contest is not an interpretation of
evidence. It is a new observable event — a named participant said this, at this
time, about this verdict — plus a preserved copy of what the evidence was. That
is raw record.

### 35.4 One contest per participant, keyed on the SEAT

`UNIQUE (corpus_game_id, contestant_seat)`, not `(corpus_game_id, player_id)`.

`player_id` is nullable and actively nulled by erasure, and NULLs are distinct
in a unique index — so a player_id key would silently stop enforcing anything
the moment a player was unlinked, and the same seat could file again. A game has
exactly one Composer seat and one Racer seat, so one row per seat IS one row per
participant, and it holds whether or not the identities behind those seats still
exist.

Enforcement is at the durable layer and race-free: `ON CONFLICT DO NOTHING`
plus `RETURNING`, so a second simultaneous submission returns no row and is
reported as a duplicate. No read-then-write check decides it.

The two seats are independent — a Composer contest does not block the Racer.

### 35.5 Contestability is narrower than "any game record"

`lifecycle_state = 'completed'` **AND** `outcome IS NOT NULL`. Both, because
the two are orthogonal by schema design and §27's completeness invariant
documents a real production row marked completed whose resolution never landed.

`in_progress`, `abandoned_inferred`, `stalled_resolving` and `expired_unresolved`
are all non-contestable. Each means the game stopped without producing a
verdict, and contesting one would be contesting an absence.

### 35.6 Status and residual concerns

**V2.6 TASK 2 — PROVISIONALLY CLOSED.** Implemented, deployed and migrated.
**Live authorized Contest end-to-end verification is OUTSTANDING and has NOT
been executed.** Final closure requires it.

**What is verified in production:**

- Deployed at `2.6.1.0` / `72a99cb`, confirmed by `/api/version`.
- Migration 0006 applied successfully against production Neon.
- **Route resolution confirmed**: `/api/game/[id]/contest` returns
  `403 not_a_participant`. That proves Next resolves the path segment, the
  handler executes, and the deny branch answers — which a successful deploy on
  its own does not, since a wrong directory name would deploy just as cleanly.
- 662 tests pass, `tsc --noEmit` clean, isolation invariant holds.

**What remains unverified, stated precisely rather than assumed:**

- **Zero contest rows exist in production.** No contest has ever been created,
  so no authorized path has run end to end.
- **The unique index has never fired.** Duplicate rejection is untested against
  PostgreSQL.
- **The immutability trigger has never fired.** Nothing has attempted a contest
  UPDATE, and ordinary use never will — only the privacy unlink would.
- **The evidence snapshot has never been assembled from real corpus rows.**
  `buildContestEvidence()` has only ever run against fabricated fixtures. Column
  shapes returned by the Neon HTTP driver — timestamps, `integer[]`, jsonb — are
  inferred from how `gameCorpus.ts` handles them, not observed.
- **Only the deny path of one route has been exercised.** `/api/contest/[id]`
  has no production observation of any kind.

Applying the migration proves the schema exists. It proves nothing about
behaviour: the trigger and the index only act when rows arrive, and none have.

**Why it is blocked:** the smoke test requires a freshly played game, and the
test account holds zero entitlement. A supported `complimentary_grant` insert
was attempted; the INSERT reported a returned grant row while an independent
`SUM(amount)` still read 0. **That discrepancy is separately parked and
uninvestigated** — it is an entitlement question, not a Contest Verdict
finding, and it was deliberately not debugged inside this task. It belongs on
the V2.6 open list in its own right.

**Do not treat the contest routes as production-verified in any later handoff,
and do not build on the assumption that a contest has ever been written.**

Residual concerns beyond status:

- **The trigger and the unique index are unproven in this environment.** There
  is no PostgreSQL in the test run; the tests assert what the application does
  plus static guards that the SQL still says what the application assumes. This
  is the same honest limit `test/corpusPersistence.test.ts` states.
- **Contestability depends on corpus completeness.** A game whose corpus write
  was deferred or partial is not contestable until reconciliation repairs it.
  Correct, but it means eligibility is a property of the corpus rather than of
  the player's memory of having finished a game.
- **No UI exists**, so the only way to reach these routes today is a direct
  request. Deliberate — Task 2 is foundation.
- **Erased contests accumulate with no reader.** A direct consequence of
  §35.2a, accepted on the record. If reviewer authorization is never built,
  these rows are write-only forever. That is a scope decision to revisit, not a
  defect to fix inside V2.6.
- **`evidence_schema_version` has one value and no reader that branches on it.**
  That is the intended shape: it is a fact recorded for a future reader, not a
  migration framework.

---

## 36. `2.6.2.0` — developer / tester unlimited play

Two designated identities may start games without a balance and without
spending one, so development and field testing are never blocked by credits.
Granted by hand in the database; **no grants have been issued yet**, pending
separate confirmation of each production `player_id`.

### 36.1 Why this is not a ledger construct — the decisive argument

`balance` is `SUM(amount)` over `accounts.entitlement_ledger`, and
`getStatus()` buckets that same sum into `complimentary_granted` / `purchased`
/ `consumed`. **Any expression of unlimited play as a ledger row lands in one of
those buckets and corrupts the Play Credit curve** — a live workstream awaiting
token-level telemetry, which will be calibrated against exactly these numbers.

A large artificial balance was rejected for the same reason and one more: it is
a bigger number, not a different kind of thing. It would be indistinguishable
from a real grant in every provenance query, and it would decay.

Unlimited play is not an amount of value. It is a **property of an identity**,
so it gets its own table. Same reasoning that keeps `corpus.game_targets`
separate from `corpus.games`: a different kind of fact, with a different access
profile, gets a different table rather than a column on someone else's.

### 36.2 The exemption's exact boundary

It bypasses **two things and nothing else**: the balance test in
`canStartGame()` and the charge in `consumeForGame()`.

**Game-creation rate limiting and `RACER_DAILY_CALL_CEILING` remain fully in
force.** Unlimited PLAY must never become unlimited SPEND — a field-testing loop
on an exempt identity could otherwise exhaust the provider budget and take
production down for ordinary players, turning a convenience into an
availability incident. A test asserts structurally that no module outside
`lib/entitlements.ts` and `/api/player/entitlement` mentions the grant at all,
so rate limiting and the call ceiling cannot have been made conditional on it.

The V2.4 invariant is restated and re-asserted against the new code: no turn,
answer, clue, correction or resolution route consults entitlement. Neither
exhaustion nor an exemption can affect a game already under way.

### 36.3 Checked before the cost is derived

The short-circuit sits **above** `playCreditCostForBudget()`. That position is
what makes the grant budget-*independent* rather than budget-*exempt*: no price
is ever computed for an exempt identity, so a 100-question game and a
20-question game take an identical path. Proven by the absence of any balance
read on that path, not merely by the outcome.

It also means **no consumption row is written** — the ledger never learns the
game happened. That is the analytics guarantee, and it is asserted as a
negative, because a test that only checked "the game starts" would pass just as
happily against an implementation that silently granted itself credits.

`ensureInitialComplimentary()` skips exempt identities for the same reason: a
developer collecting the first-contact allowance would leave an unspendable
`complimentary_grant` row permanently overstating `complimentary_granted`.

### 36.4 Failure posture — fails closed, into ordinary enforcement

Every failure mode of `hasUnlimitedPlay()` — no client, a throwing query, a
missing table on a runtime whose migration has not been applied — returns
`false`, and `false` means *carry on as normal*, never *refuse*.

Both halves matter and both are tested. An outage of a two-row table must not
become free play for everyone; and it must not lock a developer out of ordinary
credits they also hold.

### 36.5 Revocation is a timestamp, never a delete

`UNIQUE (player_id) WHERE revoked_at IS NULL` — partial, so a player can be
granted, revoked and granted again as several rows with at most one active. A
plain `UNIQUE(player_id)` would have forced revocation to be an update-in-place
and destroyed the history.

That history is the point: *"was this identity ever exempt, and between which
dates"* has to stay answerable. An unattributable privilege grant is one nobody
dares revoke, which is also why `label` is `NOT NULL`.

Revocation takes effect on the next request. There is no cache to invalidate.

### 36.6 Security

- **This is a privilege-escalation surface**, but it creates **no new trust
  boundary**: whoever can write this table can already insert ledger grants.
- **No API grant path.** Database access only, which satisfies "no admin panel
  now" *and* makes self-grant impossible. Do not add an endpoint later without
  a secret at least as strong as `ENTITLEMENT_GRANT_SECRET`.
- **`player_id` is unvalidated** — there is no players table to reference, so a
  typo grants unlimited play to an identity that will never appear. Inert, but
  it is why identity must be confirmed by round trip before a row is written,
  never inferred.
- **Traceability is preserved.** Exempt players still write `corpus.games` rows
  with their `player_id`, so their games remain fully auditable. Monetization
  analysis should exclude them with a `LEFT JOIN` on this table — recommended as
  standard in any future Play Credit curve query.

### 36.7 Residual concerns

- **The partial unique index is unproven in this environment.** No PostgreSQL in
  the test run; static guards assert the SQL still says what the application
  assumes. The same honest limit every database-facing suite here states.
- **Up to three lookups per game creation on the create path** — one each in
  `ensureInitialComplimentary`, `canStartGame` and `consumeForGame`. Indexed,
  against a table with two rows, on a path that already makes a Validator model
  call costing seconds. Negligible in context; the obvious fix if it ever
  matters is to thread the boolean through the route rather than re-query.
- **No grants exist.** The mechanism is inert until two rows are inserted, which
  is deliberate — identity confirmation is a separate, evidence-based step.

---

## 37. `racer/2.6.0` — the canonical trailing CORE RACER RULES block

The first deliberate Game Intelligence intervention in Barkóba's Racer
guidance, and a **specific, non-generalisable exception to §18**.

### 37.1 The mechanism is position and explicitness — NOT repetition

The obvious reading of this change is wrong, and the field-test interpretation
depends on getting it right.

**The Racer is stateless.** Every turn is a fresh single-shot call:
`RACER_SYSTEM_PROMPT` is re-sent in full, and the entire history is flattened
into one rendered string inside a single user message. There is no accumulating
conversation, no assistant turns carried forward, and therefore **no context in
which earlier instructions lose salience**. The original framing of this task —
"long conversational context causes strategic instructions to decay" — does not
describe this architecture, and implementing against it would have produced a
change whose stated rationale was false.

What actually changes is two things:

- **POSITION.** The block is the last content before the instruction to act, so
  a growing transcript never pushes strategy further from the point of decision.
  The system prompt necessarily sits above the transcript; this sits below it.
- **EXPLICITNESS.** Rule 2 — the two-consecutive-NO pullback — is genuinely new.
  Nothing in `RACER_SYSTEM_PROMPT` has ever stated it.

### 37.2 The canonical text

Reproduced verbatim. Editing it without bumping `RACER_PROMPT_VERSION` breaks
the database claim in §37.4, and a test fails if this text and the constant in
`lib/prompts/racer.ts` diverge.

```
CORE RACER RULES — APPLY EVERY TURN

1. Stay broad on attributes early. Prefer questions likely to produce informative YES answers.
2. After two consecutive NO answers within the same hypothesis path, pull back and open a genuinely different axis. Do not keep drilling into sibling candidates.
3. Narrow aggressively only inside a branch supported by affirmative evidence.
4. Never lock onto one promising clue. Reopen higher-level hypotheses when follow-ups repeatedly produce NO or AMBIGUOUS.
5. Naming a specific candidate is a final-guess action. Do not spend ordinary question slots enumerating candidate identities.
```

Inserted immediately before `Take your turn.` — or `Make your final move.` on
the final turn, where Rule 5 governs precisely that moment. **Unconditional**:
a branch would make `racer/2.6.0` true of some turns and not others, which is
the ambiguity the version exists to remove.

**Deliberately NOT copied into `RACER_SYSTEM_PROMPT`.** One experimental
variable, not two simultaneous prompt edits.

### 37.3 The §18 exception — specific, and not a repeal

§18's standing rule is to record an observed intelligence weakness rather than
patch the prompt against it, and it was cited as recently as §32 to justify
changing nothing. **It is not repealed.** This one intervention is authorised
because the same failure class has now been observed across three consecutive
field tests and because Rule 2 names a concrete, observable behaviour a field
test can measure:

- parent-hypothesis lock-in (§29 → Wolfram Alpha, §31 → Windows, §32);
- sibling and category enumeration despite repeated NO;
- candidate-name questions consuming ordinary question slots;
- failure to reopen after accumulated NO / AMBIGUOUS evidence.

Future Racer strategy changes remain governed by the evidence-first rule unless
separately authorised.

### 37.4 Why `prompt_version` can be trusted to prove this

`racer/2.6.0` is a **load-bearing database claim**, not a label: corpus queries
will be run against it as proof that a turn was played under the canonical
guidance. A constant stamped beside an assembly it does not inspect would be an
assertion about the code, made by the code, checked by nobody.

So it is verified against the assembled message. `assertGuidanceApplied()`
inspects the actual content immediately before the call and **throws** if the
block is absent. A turn cannot be stamped with this version unless the guidance
was genuinely present, because the call fails first.

It throws rather than warning or silently downgrading the stamp. This can only
fire on a code defect, and a loud, recoverable turn failure — B4 handles it,
with a human retry control — is strictly better than a corpus quietly
accumulating turns that claim guidance they never received. **Mislabelled
evidence is worse than missing evidence.**

No new column was needed. `prompt_version`, `model_provider` and `model_id` have
been written per turn since `2.5.0.0`; provider and model identity are
unchanged by this work, so post-change turns are auditable by provider and model
against a single guidance version.

### 37.5 Provider parity

`buildRacerTurnMessage()` **takes no provider argument.** The parity guarantee
is in the signature rather than in a comment: there is one assembly, so Claude
and Grok cannot be handed different strategy text. Adapters transport it — the
xAI adapter moves the system prompt into the first message position — but none
authors, suppresses or differentiates it, and a test fails if any fragment of
the block appears in a provider module.

A second test captures what each transport is actually handed and asserts the
two are byte-identical.

### 37.6 How to read the field test

**Rule 2 is the only rule carrying new information.** Rules 4 and 5
substantially restate guidance the system prompt already contains — *"A question
that names one specific candidate IS a guess"* and *"FALSIFY BEFORE YOU
COMMIT"*.

So if candidate enumeration persists, the honest reading is **"the model was
already told and is not complying"**, not "the block was absent". Watch for:
two-NO sequences producing a genuine axis change; late-game candidate naming;
whether an AMBIGUOUS explanation visibly informs the next question; and whether
the block over-corrects into mechanical axis-jumping.

### 37.7 The claim covers BOTH question-authoring paths

The first implementation applied the block only to `runRacerTurn()`, and that
was not sufficient. **Two paths can author the question the human actually
sees:**

1. `runRacerTurn()` — ordinary generation.
2. `resolveGuessIntent()` resolving `continue_questioning` — the returned
   `revised_question` **replaces** the original in `question_text`, so it, not
   the first attempt, is what is presented and recorded.

Covering only the first would have made `racer/2.6.0` true of a draft and false
of the record. §32 measured 10 of ~20 turns flagged in a single game, so the gap
was material rather than theoretical.

Both paths now assemble the same constant and both call
`assertGuidanceApplied()`. A test asserts there are exactly **two** guard sites
and exactly **one** definition of the canonical text — two divergent literals
under one version string would make the audit claim unfalsifiable.

The guidance is honestly applicable on the revision path rather than merely
pasted in: a revision *is* question authoring, and Rule 5 is the very rule whose
apparent violation triggered the flag. The Guess-Intent **system** prompt is
unedited; only the assembled user message gained the trailing block, and a test
pins that.

**`racer/2.6.0` is therefore a trustworthy statement about the AI-authored
question presented to the human**, not about the first attempt. No new
provenance field and no schema change were required.

### 37.8 Residual concerns

- **The revision path now carries strategy text it did not before**, which could
  shift the balance between `confirm_guess` and `continue_questioning` — Rule 5
  states plainly that naming a candidate is a guess. That is consistent with the
  existing prompt rather than in tension with it, and the fairness requirement
  demanded it, but it is a second behavioural change riding on this deployment
  and should be watched in field play alongside Rule 2.
- **`resolveGuessIntent()` still stamps no provenance of its own.** It does not
  need to — the turn's `prompt_version` now describes both paths truthfully —
  but it means the corpus cannot distinguish a revised question from an original
  one by provenance alone. `pre_revision_question_text` already records that
  distinction and is the field to use.
- **No behavioural claim is made or testable here.** The tests prove the block
  reaches the model on both paths, reaches both providers identically, and never
  touches stored answers or the visible transcript. Whether the Racer plays
  better is a field question.

---

## 38. `2.6.4.0` — the bare proper-noun candidate

**A detector defect, not a strategy question.** Recorded separately from §37 for
that reason: guidance and enforcement are different layers and must not be
read as one change.

### 38.1 What was observed

Production `2.6.3.0` / `racer/2.6.0`, Grok Racer, 50-question game, target
**Grok**. Four consecutive question slots, late game:

```
Q24  Is the target GPT-4?    NO
Q25  Is the target Claude?   NO
Q26  Is the target Llama?    NO
Q27  Is the target Grok?     YES
```

Every one scored **2** — `proper_noun` alone — against a threshold of 3. None
flagged. **The single guess entitlement was never consumed**, and the final YES
confirmed the target as an ordinary free question. That is precisely the harm
`lib/guessDetector.ts`'s own header says the module exists to prevent.

### 38.2 The defect, and the third occurrence of one pattern

The asymmetry that makes it legible:

| Question | Score | Flagged |
|---|---|---|
| `Is the answer Grok?` | 5 | yes — `is the answer` is an explicit frame |
| `Is the target Grok?` | **2** | **no** — `target` has no frame |
| `A cél a Grok?` | 5 | yes — Hungarian catches it |

Both `CANDIDATE_IDENTIFICATION_EN` patterns require a **determiner** before the
noun phrase, because definiteness is this module's discriminator. An English
proper noun takes no article, so a bare name falls straight through. The
Hungarian sibling requires a second article too, and catches these anyway, only
because Hungarian *does* use a definite article with proper nouns.

**The rule was never wrong. English simply has no article to test.**

This is the third time the same shape has appeared: §31 (Hungarian knew
`célpont`, not `cél`), §32 (English pattern 2 admitted the indefinite article),
and now this. Each time the surrounding rule was correct and its coverage was
one case short.

### 38.3 Why a purely syntactic discriminator is not available

Investigated and rejected rather than approximated. There is **no** syntactic
signal separating `Is the target Grok?` from `Is the target American?` — both
are `is the target <Capitalised>?`. What separates them is lexical: the second
is a predicate adjective from a bounded, enumerable class.

So the class is listed, in the same spirit as the existing
`PROPER_NOUN_STOPWORDS`. **The list is incomplete and always will be**, and it
fails in the safe direction: an unlisted predicate adjective flags, costing one
internal re-prompt, which is the module's stated BIAS. Do not grow it
speculatively — every addition is a name this rule stops catching.

### 38.4 The gap was exactly one token wide

The finding that made a narrow fix possible. A **multi-word** name already
flagged before this change, on `proper_noun` + `proper_noun_multiple` (2 + 1):
`Is the target Wolfram Alpha?` was already caught. Only a **single** capitalised
token escaped.

The rule is therefore restricted to that case rather than generalised over noun
phrases. A broader pattern would have added false-positive surface for nothing.

Two further narrowings: the match is **case-sensitive** (capitalisation is the
whole signal, so the pattern carries no `i` flag), and **a digit settles it
ahead of the stopword test** — no nationality, language or religion contains
one, so `GPT-4`, `GPT-3.5` and `Llama-2` are names with certainty and cannot be
suppressed by a list entry added later.

The new rule sits inside the same `namesACategory` guard as its siblings, so
`Is it the kind of Grok?` is still disqualified by category vocabulary rather
than needing its own exception.

### 38.5 What this does NOT change

- **`racer/2.6.0` is unchanged.** This is enforcement, not guidance. The Racer
  prompt is untouched.
- **Explore → Narrow → Confirm → Guess is recorded and NOT implemented.** The
  principle — once a hypothesis is strong, discriminate with an independent
  property, provenance or relationship test (`Is it developed by xAI?`) rather
  than enumerating named candidates, before a formal final guess — is a
  strategy change and remains governed by §18. Bundling it with this defect fix
  would make neither effect readable in field play.
- **The Hungarian rules are untouched**, in either direction, and a test pins
  that.

### 38.6 What the field observation means for §37.6

§37.6 predicted that if candidate enumeration persisted, the honest reading
would be *"the model was already told and is not complying"* rather than *"the
block was absent"*. The first field result confirms the prediction: `racer/2.6.0`
was present on all four turns via the guarded `runRacerTurn()` path, no revision
path was involved, and Rule 5 was not followed.

**But it is worse than non-compliance**, because the detector was supposed to be
the backstop and it failed silently. Guidance asks; the detector enforces. Only
the second was defective, and only the second is fixed here.

---

## 39. Block 1 — Digital Ice Cream bridge: open UX requirements

**IMPLEMENTED IN `2.6.7.0` (TASK 3).** The four-state server model, established-
identity query guard, global header presentation and exhausted-only acquisition
path are complete.

### 39.1 Play Credit status must be discoverable before commitment

**Field finding, production `2.6.4.0`.** Play Credit state is buried too deep. A
player makes one or two navigation choices — enter Play, choose a game mode,
fill in a setup form, submit — before discovering they have zero credits. The
refusal arrives after the commitment, not before it.

**Frozen requirement.** Balance must be visible on the **first actionable
screen**, before the player commits to a game path. A zero or insufficient
balance must expose the credit-acquisition path **there**, not several screens
in.

**Placement, as specified:** on the landing page, directly beneath the
profile/player control in the upper-right account area.

### 39.2 Two implementation constraints found while recording this

Both are real and neither is obvious from the requirement text.

**(a) The placement anchor is currently a painted control.** The upper-right
"profile/player control" is the `👤 Login` button in
`app/components/SiteHeader.tsx`, and it does not do anything — it routes to the
Coming Soon dialog, as the header's own comment says: *"Real controls, not
painted ones... both route to the honest Coming Soon treatment rather than
pretending to work."* The visual anchor exists; the account behaviour behind it
does not. Attaching a live balance beneath a non-functional Login is
implementable but reads oddly, and whether Login becomes real in the same task
is a scope decision, not an implementation detail.

`SiteHeader` is already a client component, so `useEntitlement()` can be used
directly. But it renders on **every** page, so "landing page only" versus
"global header" is a second scope decision.

**(b) THE NEW-PLAYER TRAP — this requirement could make the experience worse
before it makes it better.**

The first-contact complimentary allowance
(`ENTITLEMENT_COMPLIMENTARY_GRANT`, default 10) is granted **lazily**, by
`ensureInitialComplimentary()` inside `/api/game/create` — not at first contact
with the site. A visitor who has never started a game therefore has an **empty
ledger**, and `getStatus()` correctly reports a balance of **0**.

Show that on the landing page and a brand-new player is greeted with
`Játékkereted 0 — elfogyott` **and a prompt to buy credits**, when in fact their
first game is free and already paid for. That is a worse first impression than
today's silence, and it would be entirely self-inflicted.

**RESOLVED in §39.4** by the four-state model, without moving the grant. The
option of granting at first contact was considered and **rejected**: it would
put a ledger row against every visitor, including bots, and would change grant
semantics to make a badge easier to render.

### 39.3 Identity caution for the purchase proof

**William likely played only on his phone.** A desktop browser he has used is
therefore probably carrying a *different, anonymous* identity — the cookie is
per-browser and nothing links them.

**Do not use a desktop William session for the purchase proof** unless his
identity has been explicitly recovered and confirmed. A `purchase_ref` minted
from the wrong session would credit an identity nobody is watching, and the
proof would appear to fail while having succeeded against a stranger.

**William, on the same phone session throughout, is the manual purchase-proof
identity.** Mint the `purchase_ref` and read the resulting balance in that one
session. The same caution applies to any later test.

### 39.4 The four-state play model — RATIFIED

Server-authoritative. Evaluated in this order:

| State | Condition | Presentation |
|---|---|---|
| `unlimited` | `hasUnlimitedPlay()` | `korlátlan — fejlesztői hozzáférés` |
| `has_balance` | `balance > 0` | the number |
| `introductory_available` | allowance configured **and** no `initial_complimentary` row | welcoming / free-play indication — **no `0`, no exhausted language, no purchase CTA** |
| `exhausted` | none of the above | `0 — elfogyott` **+ Digital Ice Cream acquisition CTA** |

**The authoritative marker is the `initial_complimentary` grant key**, not
`complimentary_granted`. This is a hard requirement, not a preference: the sum
is satisfied by *any* complimentary grant — the V2.6 smoke-test grant would
have satisfied it — whereas the grant key identifies the introductory allowance
specifically. `ensureInitialComplimentary()` is its only production writer, and
`entitlement_grant_key_once` makes it at-most-once per player permanently, so
the marker is already durable and authoritative. **Nothing needs to be built to
make it so.**

**The server resolves `play_state`; the client never reconstructs it.**
Returning raw flags and letting the badge derive the state would break the rule
`app/components/Entitlement.tsx` already states — *"No balance or price is
computed on the client — the server stays the sole authority."* The resolution
belongs in `lib/entitlements.ts`, the quarantined module that already owns every
entitlement decision.

**The derivation stays honest under every configuration.** With
`ENTITLEMENT_COMPLIMENTARY_GRANT=0` there is no allowance,
`introductory_available` is false, and a brand-new player correctly reads as
`exhausted` — because they genuinely cannot play.

**The introductory grant does not move.** It remains lazy, inside
`/api/game/create`. The marker makes relocation unnecessary, and relocating it
for UI convenience was explicitly rejected.

**No schema work.** One additional `bool_or(...)` inside the existing
`getStatus()` aggregate — no extra round trip, no new index, no migration.

### 39.5 Placement and query discipline

Balance and status belong **globally** in the upper-right account area,
beneath or associated with the player/profile control — not landing-only.
`SiteHeader.tsx` is already a client component, so the existing
`useEntitlement()` hook is reused with an enable guard. A small server wrapper
verifies an authorised guest or account on the incoming request before enabling
the hook. A first-contact request on which middleware is only now issuing the
guest cookie therefore does not query the ledger; the next player-facing
navigation can show the status.

**Historical §39 scope note:** Login was out of scope for TASK 3 and remained a
painted control in `2.6.7.0`. §42 later supersedes that UI boundary with the
minimum real account control; the four-state entitlement model is unchanged.

**Only query entitlement once Barkóba has an established player identity.**
Global placement otherwise puts a Neon aggregate on every page view — landing,
`/rules`, `/about`, `/privacy`, every game page — for every visitor including
bots, converting a load proportional to *games* into one proportional to
*traffic*. The gate already short-circuits without touching Neon when
entitlement is disabled; this adds the second condition.

### 39.6 Frozen scope — what this section does and does not authorise

**Authorised:** the four-state model, the `play_state` field, the `bool_or`
addition to `getStatus()`, badge presentation for all four states, `CreditGateway`
on `exhausted` only, and global placement in the header behind an
established-identity check.

**Not authorised here:** making Login functional, moving the introductory grant,
any schema or migration work, the package allowlist, the storefront, the return
leg, and pricing. Each is separately scoped.

---

## 40. Block 1 — the commercial credit bridge is FIELD-PROVEN

**Manual production proof completed on `2.6.4.0`.** The Barkóba-side purchase
bridge works end to end against a real zero-credit player. No code was written
to achieve this — the V2.4 contract was already complete and had simply never
been exercised.

### 40.1 What was proven

A human acted as the Ice Cream Stand. The full chain:

```
0 credits
  → CreditGateway
  → claim player
  → POST /api/entitlement/intent  → purchase_ref
  → POST /api/entitlement/grant   (bearer, server-to-server)
  → grantPurchase → accounts.entitlement_ledger
  → player balance
```

| Field | Value |
|---|---|
| package concept | `test_scoop_5` |
| credits | 5 |
| `external_order_id` | `test_scoop_5_manual_001` |
| grant response | `granted=true`, `duplicate=false` |
| player UI after refresh | `Játékkereted 5` |

A balance moving from 0 to exactly 5 also demonstrates that **one** ledger row
was written; a duplicate would have shown 10.

### 40.2 What this retires, and what it does not

**Retired:** every doubt about the Barkóba half. `ENTITLEMENT_GRANT_SECRET` is
live and correct in the deployed runtime; the intent route mints a real
reference for a claimed player; the grant endpoint authenticates, resolves the
reference, and credits the right identity; `getStatus()` and the badge reflect
it. All of that had been asserted only by unit tests until now.

**REPLAY is also field-proven.** The identical callback was re-sent with the
same `external_order_id`; production returned `granted=false, duplicate=true`
and the player's balance remained unchanged. `entitlement_grant_key_once` has
therefore been exercised in production, not merely asserted by unit tests.

**Also unexercised:** the *"same reference, different order"* refusal, which is
the guard against a reference being turned on a second order.

### 40.3 The UX finding has direct field confirmation

The player **had to configure a game and attempt to start it** before the
acquisition CTA appeared. §39.1's earlier-visibility requirement is therefore no
longer a design intuition — it was observed in the one real purchase journey
this product has ever had.

### 40.4 Historical finding; superseded by §41 and the Task 5 bridge

At the time of this proof, what stood between a zero-credit player and Play
Credits was a human with a shell. §41 subsequently selected ordinary DICS
purchases and the separate payment-side Vercel adapter; Task 5 implements that
software path. The `test_scoop_5` values above remain historical evidence only,
not an active catalogue or commercial rule.

---

## 41. DICS stays unchanged — provenance, and a refined money boundary

**RATIFIED. Foundation implemented after `2.6.5.0`; classification and reward
conversion frozen for the Task 5 bridge.** This supersedes the `test_scoop_5`
product design proposed before it, and amends what shipped at `2.6.5.0`.

### 41.1 The product decision that forced the redesign

**Everything available to an ordinary Digital Ice Cream Stand customer is
equally available to a customer arriving from Barkóba.** Same stand, same
offers, same prices, same Stripe products, same experience. DICS does not care
where the customer came from, and **does not sell Play Credits**.

A customer buys Digital Ice Cream. Play Credits are an **internal Barkóba
entitlement resulting from a reconciled purchase** — a consequence, not a
product.

So `purchase_ref` is **provenance, not a product selector**, and the proposed
"Barkóba Play Credits" Stripe product is cancelled. No existing Stripe product,
price, quantity, flavour or commercial meaning changes.

### 41.2 What survives, and what does not

**Cancelled:** `test_scoop_5` as a customer-facing product; any Barkóba-specific
Stripe product or Payment Link.

**Survives, and matters more than before:** *the caller never states the
amount.* The caller is now a payment webhook rather than a stand, which makes
the rule more important, not less.

**Frozen decision 10 holds exactly as written** — the payment-side Vercel
adapter maps Stripe price ID → `package_id`, Barkóba independently maps
`package_id` plus validated economic `quantity` → internal Play Credits. Only
what `package_id` *names* changed: not a Barkóba product, but a neutral DICS
**economic class**.

```
Stripe paid purchase → (payment-side Vercel adapter) → economic class + quantity
  → (Barkóba) → internal Play Credits → player-facing RACES
```

Two mappings, neither knowing the other's vocabulary. Swap the processor and
only the payment-side adapter's table changes. For scoop offers, **a price ID is
a name, not an amount**. Custom is the deliberate exception at the payment
boundary: the adapter classifies completed €10 steps from Stripe's verified
paid total, then sends only an economic step count. Barkóba never reads money
to calculate entitlement.

**Ownership, stated once:** the payment-side Vercel adapter owns *Stripe
purchase → package classification*. Barkóba owns *package → credit
calculation*. Neither reaches into the other.

### 41.3 Provenance is captured, and never read

Flavour is not an entitlement input and must not be discarded. Three layers,
deliberately separated:

| Layer | Contents | Read by |
|---|---|---|
| **Entitlement inputs** | `package_id`, `quantity` | the grant calculation, and nothing else |
| **Identity / idempotency** | `purchase_ref`, Stripe session id | reconciliation |
| **Attested provenance** | `purchase_facts` | **nothing today** |

**Migration `0008` adds a nullable, immutable `purchase_facts jsonb`** to
purchase ledger rows — written at insert, never updated. The append-only trigger
already refuses UPDATE and DELETE, so immutability needs no new mechanism.

Contents: flavour/product, Stripe price ID, quantity, currency, `amount_total`,
`purchased_at`, `livemode`, plus `provider: "stripe"`, `source: "dics"` and
`purchase_facts_schema_version: "dic-purchase/1"`.

**No customer PII and no payment credentials.** No email, no name, no card data,
no address. That is also why this is a column rather than a sibling table: with
no PII there is no separate access profile to protect, so the
`corpus.game_targets` precedent does not apply.

**VALIDATED versus ATTESTED — the distinction must not blur.** `package_id` and
`quantity` are checked against Barkóba's catalogue and refused if unrecognised.
`purchase_facts` **cannot be verified by Barkóba** — it stores what the
payment-side Vercel adapter asserts. The chain still holds (the adapter read
them from a signature-verified Stripe payload), but it is one link weaker, and a future analyst must not
mistake attested facts for verified ones. Shape validated, size capped, stored
verbatim, never interpreted.

**Structural tests are required, not optional:** no code path in the
entitlement or grant calculation may read `purchase_facts`. Without that
enforcement the third layer becomes an input the first time someone finds it
convenient.

### 41.4 The money boundary, deliberately refined

**Old:** *Barkóba learns nothing about money.*

**Refined:** **Barkóba stores attested transaction provenance, but does not
price, does not verify, and does not derive entitlement from money fields.**

This is the first money ever stored in Barkóba's database. It is a conscious
crossing rather than a side effect, made in the weakest available form —
recorded as fact, never read as input — which is exactly how
`corpus.game_resolutions.adjudicator_confidence` is stored raw and never
interpreted.

The alternative, omitting amount and currency and depending on Stripe forever,
was considered and rejected: it would leave the purchase history unjoinable in
SQL, subject to a vendor's retention policy, and split in half the day the
processor changes.

### 41.5 `purchase_ref` TTL: 30 minutes → 24 hours

The 30-minute TTL was sized for the old flow, where a player clicked one package
and paid immediately. Under §41.1 they arrive, watch, browse eight flavours and
choose — a **shopping session, not a checkout**. A reference expiring mid-browse
would produce a completed purchase the adapter cannot attribute: real money, no
credits, manual repair.

**Single-use semantics are unchanged.** The marked-on-use design stands: a spent
reference is marked rather than deleted, so a redelivered webhook stays
decidable. Only the *fresh* window widens.

Two consequences, recorded rather than discovered later: a reference may now be
resolvable up to ~48h after minting in the worst case (24h fresh, then 24h
consumed measured from use); and unspent references accumulate for a day rather
than half an hour. Neither is a security concern — **a reference authorises
nothing on its own**, since the grant additionally requires the server-to-server
secret.

### 41.6 Frozen DICS reward mapping and RACE normalization

The player-facing unit is **RACE / RACES**. Play Credits remain the internal
append-only accounting unit. Every future playable run costs exactly one Play
Credit at all four frozen question budgets (20 / 35 / 50 / 100), so one RACE
means one run without a lossy display conversion.

All legitimate DICS purchases qualify. Flavour, design and product semantics
remain provenance only and never decide the reward.

| Paid DICS economic class | Barkóba grant input | RACES / Play Credits |
|---|---|---:|
| 1 scoop | `dics_scoop`, quantity `1` | 5 |
| 2 scoops | `dics_scoop`, quantity `2` | 15 |
| 3 scoops | `dics_scoop`, quantity `3` | 30 |
| Custom €25 base | `dics_custom`, quantity `1` | 100 |
| each completed additional €10 | increment `dics_custom` quantity by `1` | +50 |

The caller cannot send a credit or RACE amount. Barkóba validates the economic
class and quantity, then resolves this table in code. `purchase_facts` remains
structurally excluded from that calculation.

### 41.7 Task 5 bridge boundary and remaining operations

The Barkóba implementation creates a 24-hour `purchase_ref` and hands the
player to DICS. DICS forwards it invisibly as Stripe
`client_reference_id` without changing any offer, and carries the same opaque
reference through Stripe's supported UTM redirect propagation. A neutral DICS
completion page returns only Barkóba-originated buyers to Barkóba; ordinary DICS
buyers remain in DICS. A separate Vercel adapter verifies Stripe's raw-body
signature, requires a paid session in the configured mode, safely ignores
ordinary sessions with no Barkóba reference, classifies the allowlisted Stripe
Price, and calls Barkóba's authenticated idempotent grant route.
`/play?purchase=return` remains display-only and re-reads the server-resolved
balance.

Deployment remains operationally separate: deploy the DICS provenance patch;
configure every legitimate Stripe Price ID in the adapter; deploy the adapter
with its Stripe and Barkóba secrets; register its Stripe events; set the
existing Payment Links' post-payment redirect; apply migration `0008`; and
deploy Barkóba. Unattributable paid purchases (expired or absent reference)
remain manual repair; automated reconciliation stays deferred.

## 42. Module 1 account ownership (TASK 6B)

Purchased RACES belong to a registered player account, not to a browser. The
account deliberately retains the existing `player_id`, so entitlement rows,
games, seats, purchase provenance and the introductory-grant marker require no
copy, transfer or rewrite.

Guests still use the signed `bk_player` cookie for frictionless play. Registering
converts that guest in place and uses the existing high-entropy recovery code as
the login credential. A login creates a fresh opaque server-side session; only
its SHA-256 hash is stored in `accounts.player_sessions`, and the browser holds
the raw value in a Secure, HttpOnly, SameSite=Lax cookie. Logout revokes the
server row. Once `player_id` exists in `accounts.players`, `bk_player` alone is
never authority for it.

There is no automatic merge. Logging into an account ignores an unrelated local
guest and does not copy its ledger or game ownership. Existing Upstash protected
players migrate idempotently when they register or log in. New purchase intent
requires an authenticated account session. A database trigger also rejects new
purchase ledger rows for unregistered players; only references minted before
this cutover retain their original 24-hour grant authority through an explicit
transaction-local exception.

Registered-account deletion is not exposed in Module 1. Profiles, e-mail,
passwords, magic links, passkeys, history dashboards and social surfaces remain
out of scope.
