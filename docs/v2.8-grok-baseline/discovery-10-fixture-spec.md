# V2.8.x — 10-Game Racer Integrity Discovery Batch: Frozen Spec

**Status: frozen before Game 1.** Nothing below may change once the first
discovery game starts. Any amendment found necessary after that point goes
in a dated addendum at the bottom of this file, never a silent edit above
it.

**Purpose, restated.** Not prompt tuning. Discover which reasoning failures
recur naturally across diverse Barkóba games under frozen `racer/4.0.0`, so
the next intervention (if any) is earned by cross-game evidence rather than
anecdote from one or two loud games.

## 0. What stays constant across all 10 games

| | Value |
|---|---|
| Racer Guidance | `racer/4.0.0` (`CORE_RACER_RULES`, unmodified — this branch was forked from the M3 baseline commit specifically so this is genuine, not the rejected M4 `racer/4.1.0` candidate) |
| Racer provider | `xai` |
| Racer model | `grok-4.20-0309-reasoning`, pinned in-process (mirrors the calibration games and the smoke test — never left to `XAI_MODEL_RACER`'s runtime default) |
| Server-side tools | None enabled — no web search, no X search, no code execution. Reasoning is drawn from the model's own knowledge and the game transcript only |
| Composer | `answerAsComposer`, the same function every existing fixture uses — answers are derived deterministically from each fixture's target/definition text, never manually scripted per question. This is standard, existing Barkóba machinery, not new logic written for this batch |
| Difficulty | `medium` |
| `max_questions` | 50 |
| `game_language` | `en` |
| Orchestration | Turn-by-turn stepping (`scripts/runGrokStep.ts`, `app/api/internal/benchmark/grok-step`) — the same mechanism validated across both calibration games, needed because Grok's reasoning latency does not reliably fit a whole 50-question game inside one Vercel function invocation |

## 1. The 10 frozen fixtures

Selected for deliberate coverage per the batch's own required categories.
None reuse Eiffel Tower, Mona Lisa, or Backpack as the primary target.

| # | Category | Target | Granularity | `benchmark_case_id` |
|---|---|---|---|---|
| 1 | Generic type #1 | a wristwatch | `generic_type` | `v2.8-discovery-01-wristwatch` |
| 2 | Generic type #2 (different domain) | a guitar | `generic_type` | `v2.8-discovery-02-guitar` |
| 3 | Specific instance #1 | the Great Sphinx of Giza | `specific_instance` | `v2.8-discovery-03-great-sphinx` |
| 4 | Specific instance #2 (different domain) | the Titanic | `specific_instance` | `v2.8-discovery-04-titanic` |
| 5 | Living thing | a platypus | `generic_type` | `v2.8-discovery-05-platypus` |
| 6 | Landmark / structure | the Golden Gate Bridge | `specific_instance` | `v2.8-discovery-06-golden-gate-bridge` |
| 7 | Artifact / artwork | the Rosetta Stone | `specific_instance` | `v2.8-discovery-07-rosetta-stone` |
| 8 | Abstract / conceptual | the game of chess | `specific_instance` | `v2.8-discovery-08-chess` |
| 9 | Wildcard #1 | a rubber duck | `generic_type` | `v2.8-discovery-09-rubber-duck` |
| 10 | Wildcard #2 (different reasoning path from #9) | Antarctica | `specific_instance` | `v2.8-discovery-10-antarctica` |

### Frozen definitions (exact text, verbatim to `answerAsComposer`)

1. **a wristwatch** — "A wristwatch as a general kind of object: a small timekeeping device worn around the wrist, secured by a band or strap. This refers to wristwatches as a category — any ordinary wristwatch counts, regardless of brand, whether analog or digital, mechanical or electronic, smart or simple. Not one particular wristwatch."
2. **a guitar** — "A guitar as a general kind of object: a stringed musical instrument with a neck and a body, played by plucking or strumming its strings, typically having six strings. This refers to guitars as a category — any ordinary guitar counts, regardless of brand, whether acoustic or electric, regardless of body shape or number of strings. Not one particular guitar."
3. **the Great Sphinx of Giza** — "The Great Sphinx of Giza: the specific, one-of-a-kind limestone statue of a reclining creature with a lion's body and a human head, located on the Giza plateau in Egypt, near the Great Pyramids. This refers to that exact statue — not sphinxes in general, not any other sphinx statue elsewhere in the world, and not a replica or scale model. There is only one Great Sphinx of Giza; this is it."
4. **the Titanic** — "The Titanic: the specific British passenger ocean liner that sank in the North Atlantic Ocean in April 1912 after striking an iceberg on her maiden voyage. This refers to that exact ship — not ocean liners in general, not any other ship, and not a replica, model, or a film/dramatization about it. There is only one RMS Titanic; this is it."
5. **a platypus** — "A platypus as a general kind of living creature: a semi-aquatic, egg-laying mammal native to eastern Australia, with a duck-like bill, webbed feet, and a beaver-like tail. This refers to platypuses as a category — any ordinary platypus counts. Not one particular platypus."
6. **the Golden Gate Bridge** — "The Golden Gate Bridge: the specific suspension bridge spanning the Golden Gate strait, connecting San Francisco to Marin County, California, completed in 1937 and known for its Art Deco towers painted 'International Orange.' This refers to that exact bridge — not suspension bridges in general, not any other bridge, and not a replica or model. There is only one Golden Gate Bridge; this is it."
7. **the Rosetta Stone** — "The Rosetta Stone: the specific granodiorite stele inscribed with a decree in three scripts (hieroglyphic, Demotic, and Ancient Greek), discovered in 1799 near the town of Rosetta in Egypt, now held in the British Museum. This refers to that exact stone — not inscribed stelae in general, not any other Egyptian artifact, and not a replica or cast. There is only one Rosetta Stone; this is it."
8. **the game of chess** — "The game of chess as a specific, singular thing: the two-player strategy board game played on an 8x8 checkered board with a defined set of pieces (king, queen, rooks, bishops, knights, pawns), each with fixed legal moves, where the objective is to checkmate the opponent's king. This refers to chess itself, as codified by its standard rules — not board games in general, not one specific chess match or tournament, not a physical chess set as an object, and not a single chess piece. There is only one game of chess; this is it."
9. **a rubber duck** — "A rubber duck as a general kind of object: a small, buoyant, duck-shaped toy typically made of rubber or soft plastic, commonly used as a bath toy for children. This refers to rubber ducks as a category — any ordinary rubber duck counts, regardless of size, exact color, or brand. Not one particular rubber duck."
10. **Antarctica** — "Antarctica: the specific, one-of-a-kind continent located at the southernmost point of the Earth, almost entirely covered by ice, surrounding the South Pole. This refers to that exact continent — not continents in general, not the Arctic (a different, northern region that is not a continent), and not any specific research station or expedition on it. There is only one Antarctica; this is it."

### Note on fixture 8 (abstract/conceptual slot)

A genuinely abstract concept (e.g. "justice," "gravity," "jealousy") was
rejected for this slot: many of the questions a Racer would ask about such a
concept resolve to contested or interpretive answers, which would make the
Composer's YES/NO/AMBIGUOUS calls unreliable as objective scientific
evidence — exactly the risk this batch's own governance flags. Chess is
non-physical (a system of rules, not a physical object one can hold — the
Racer must discover this itself, which is its own useful stress test) while
still being fully, objectively well-defined: every question about its rules,
components, or objective has a single correct answer. This satisfies "ONLY
if Composer answers can be frozen objectively enough for scientific
scoring," per the batch's own instruction, and is documented here rather
than silently substituted.

## 2. Scoring rubric — unchanged

`docs/racer-scorecard.md` (the M0 rubric), applied exactly as written, D1–D9,
no new levels, no threshold changes. Referenced, not restated.

## 3. Frozen failure-taxonomy definitions (verbatim from this batch's own
governing instructions — copied here so they cannot drift mid-batch)

**A. Hard-evidence contradiction — first-class incident, numbered, cited by exact turn.**
- **A1. Question contradiction.** A later question conflicts with a hard
  established YES/NO or exclusion.
- **A2. Final-guess contradiction.** A final candidate conflicts with
  established hard evidence. Carries higher release-blocking materiality
  than inefficient questioning alone.

**B. Evidence carry-forward.** Track forgotten exclusions, silently
abandoned hard facts, reopened settled dimensions, repeated testing of
already-established predicates, candidate sets inconsistent with the
ledger.

**C. Bad-branch recovery / D9 — frozen operational definition, unchanged for
this entire batch:** *after 3 related NOs within one sibling branch/axis, a
4th same-branch sibling probe is a D9 failure event.* Record streak start,
related-NO count, whether a 4th sibling occurred, when/if recovery happened,
and whether recovery changed dimension or merely renamed the same branch.

**D. Residual-uncertainty / dimension use.** Inspect whether the Racer keeps
walking one taxonomy while major unresolved dimensions (geography, era,
maker/origin, function, material, scale, role, living/nonliving, generic vs.
specific identity) remain unused. Observe only — no fix prescribed during
the batch.

**E. Candidate validation / guess discipline.** Before each final guess,
check retrospectively: did the candidate satisfy every hard `KNOWN` fact?
Violate any exclusion? Was a discriminating question still obviously
available? Did the guess follow immediately after `AMBIGUOUS`? Was
substantial budget still unspent?

**F. AMBIGUOUS handling.** Track whether `AMBIGUOUS` causes useful
reformulation, a dimension change, a repeated predicate, a premature guess,
or branch confusion. Record incidents; no new rule invented mid-batch.

**G. Generic vs. specific-instance discipline.** Track over-specialization
of an already-solved generic target, subtype guessing where the parent
category would suffice, reaching the correct class for a specific instance
but failing to identify the instance itself, and category/instance
confusion.

**H. D4 redundancy + D2 efficiency.** Recorded under the frozen M0 rubric.
Neither is automatically promoted to primary-failure status unless
cross-game evidence shows it materially drives a more serious failure.

## 4. Evidence locations (filled in as each game completes; never edited
retroactively — only appended)

| # | Fixture | Transcript | Status |
|---|---|---|---|
| 1 | wristwatch | `docs/v2.8-grok-baseline/discovery-10/01-wristwatch.transcript.json` | not yet run |
| 2 | guitar | `docs/v2.8-grok-baseline/discovery-10/02-guitar.transcript.json` | not yet run |
| 3 | great-sphinx | `docs/v2.8-grok-baseline/discovery-10/03-great-sphinx.transcript.json` | not yet run |
| 4 | titanic | `docs/v2.8-grok-baseline/discovery-10/04-titanic.transcript.json` | not yet run |
| 5 | platypus | `docs/v2.8-grok-baseline/discovery-10/05-platypus.transcript.json` | not yet run |
| 6 | golden-gate-bridge | `docs/v2.8-grok-baseline/discovery-10/06-golden-gate-bridge.transcript.json` | not yet run |
| 7 | rosetta-stone | `docs/v2.8-grok-baseline/discovery-10/07-rosetta-stone.transcript.json` | not yet run |
| 8 | chess | `docs/v2.8-grok-baseline/discovery-10/08-chess.transcript.json` | not yet run |
| 9 | rubber-duck | `docs/v2.8-grok-baseline/discovery-10/09-rubber-duck.transcript.json` | not yet run |
| 10 | antarctica | `docs/v2.8-grok-baseline/discovery-10/10-antarctica.transcript.json` | not yet run |

Analysis happens only after all 10 rows above are filled — per governance,
no interpretation, no tuning, and no intervention proposal between games.
