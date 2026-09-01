# V2.8.x — Candidate Validation / Final-Guess Granularity Gate: Evaluation

**Status: complete.** All 5 frozen regression games ran under genuine
`racer/4.0.0` (unmodified), provider `xai`, pinned `grok-4.20-0309-reasoning`,
via the same turn-by-turn architecture as the valid Grok discovery baseline.
Verdict rendered strictly against the criteria pre-registered in
`docs/v2.8-grok-baseline/candidate-validation-gate-spec.md` §7, before any
candidate result existed.

## 0. Evidence index

| Fixture | Role | Control (already collected) | Candidate (this run) |
|---|---|---|---|
| guitar | mandatory failure-regression | `racer_incorrect`, 12/50 — [discovery-10/02-guitar.transcript.json](discovery-10/02-guitar.transcript.json) | `racer_correct`, 13/50 — [candidate-validation-gate/disc-02-guitar.candidate-evidence.json](candidate-validation-gate/disc-02-guitar.candidate-evidence.json) |
| Golden Gate Bridge | mandatory failure-regression | `racer_incorrect`, 14/50 — [discovery-10/06-golden-gate-bridge.transcript.json](discovery-10/06-golden-gate-bridge.transcript.json) | `racer_incorrect`, 16/50 — [candidate-validation-gate/disc-06-golden-gate-bridge.candidate-evidence.json](candidate-validation-gate/disc-06-golden-gate-bridge.candidate-evidence.json) |
| chess | mandatory failure-regression | `racer_incorrect`, 34/50 — [discovery-10/08-chess.transcript.json](discovery-10/08-chess.transcript.json) | `racer_correct`, 28/50 — [candidate-validation-gate/disc-08-chess.candidate-evidence.json](candidate-validation-gate/disc-08-chess.candidate-evidence.json) |
| platypus | must-not-regress control | `racer_correct`, 12/50 — [discovery-10/05-platypus.transcript.json](discovery-10/05-platypus.transcript.json) | `racer_correct`, 13/50 — [candidate-validation-gate/disc-05-platypus.candidate-evidence.json](candidate-validation-gate/disc-05-platypus.candidate-evidence.json) |
| Eiffel Tower | must-not-regress control | `racer_correct`, 32/50 — [calibration/d2-eiffel-tower.grok.transcript.json](calibration/d2-eiffel-tower.grok.transcript.json) | `racer_correct`, 17/50 — [candidate-validation-gate/d2-grok.candidate-evidence.json](candidate-validation-gate/d2-grok.candidate-evidence.json) |

Control transcripts are reused unmodified, per the spec's §6 decision not
to re-run control (already-collected evidence, avoids spending budget to
reproduce what exists, avoids adding fresh stochastic noise to the control
side).

## 1. Every attempted final guess and every gate activation

Five games, five guess attempts, five gate activations — the gate fired
exactly once per game, on the first (and, in every game, only) guess
attempt.

| # | Fixture | Turn | Proposed guess | Gate decision | grain_ok | unused_discriminator | hard_evidence_violation | Replacement question installed | Final outcome |
|---|---|---|---|---|---|---|---|---|---|
| 1 | guitar | t10 | "musical instrument" | **block** | false | "Is the target a string instrument?" | none | "Is the target a string instrument?" | Racer continued (bow/frets/six-strings), re-guessed "guitar" at t14, gate **allowed** → `racer_correct` |
| 2 | Golden Gate Bridge | t17 | "bridge" | **allow** (gate miss) | **true** | none | none | — | → `racer_incorrect` |
| 3 | chess | t29 | "chess" | allow | true | none | none | — | → `racer_correct` |
| 4 | platypus | t14 | "platypus" | allow | true | none | none | — | → `racer_correct` |
| 5 | Eiffel Tower | t18 | "Eiffel Tower" | allow | true | none | none | — | → `racer_correct` |

Full reasoning text for every activation is in each game's
`.candidate-evidence.json` under `gate_activations_this_step`; the two most
load-bearing are quoted below.

**Guitar, t10 — correct block, replacement behavior installed and
followed through (§1 of the two mandatory cases the gate actually
worked on):**
> "The proposed guess 'musical instrument' is a bare parent category
> rather than a specific member or exact referent (per the instructions'
> explicit example), so grain_ok is false. A high-value unused
> discriminator also exists to split the broad family of instruments. No
> contradiction with the transcript."

The Racer asked the installed replacement ("Is the target a string
instrument?"), then two more of its own questions (frets, six strings),
then guessed "guitar" — which the gate allowed at t14 with: *"guitar" is a
specific member of the string instrument family that fits every
established fact... no obvious unasked discriminator remains that would
separate it from other plausible referents at this grain.* This is the
gate working exactly as the spec's §4 replacement-behavior requirement
describes: not merely blocking, but producing a game that continues to
discriminate and reaches a correctly-grained answer.

**Golden Gate Bridge, t17 — the gate's own miss:**
> "The proposed guess 'bridge' is at the correct grain given that the
> questions and answers align precisely with the characteristics and
> purpose of a bridge (outdoors, man-made, spans obstacles for
> transportation purposes, not a vehicle or container, etc.). It does not
> contradict any established fact, and no unasked yes/no question would
> still usefully distinguish it from other remaining possibilities at this
> point."

This is the same category-for-referent error the underlying discovery
batch identified in the Racer itself, reproduced by the gate — not
inherited passively, but actively re-derived: the gate was shown the same
transcript, asked the same grain question, and reached the same wrong
conclusion. This game's transcript genuinely never asked a
location/color/era/name-recognition question that would have made "which
specific bridge" a live, checkable discriminator — the same underlying gap
(an unused high-value dimension) the discovery batch's evaluation already
flagged in general (§3 of `evaluation.md`, unused-dimension observations),
here defeating the safeguard built specifically to catch it.

## 2. Hard-evidence compatibility

**Zero violations across all 5 games.** `hard_evidence_violation` was
`null` on every one of the 5 gate activations, and the Integrity Review
that ran on Golden Gate Bridge (the one incorrect result — adjudicator
verdict `incorrect` triggers Integrity Review under
`needsIntegrityReview()`) returned `upheld`: no contradiction was found in
that game's answers either. The Golden Gate Bridge failure is a pure grain
miss, not an evidence-consistency problem.

## 3. Must-not-regress outcomes

Both hold. Platypus: `racer_correct` in both control (12q) and candidate
(13q). Eiffel Tower: `racer_correct` in both control (32q) and candidate
(17q, notably fewer — this run's line of questioning reached the tower
faster, unrelated to the gate since it only activated once, correctly, on
the already-correct final guess). No new hard-evidence contradiction
anywhere. No catastrophic latency/cost regression — see §5; each gate
activation added one additional xAI call and a median ~7-11s to the game,
not an order-of-magnitude change.

## 4. The chess result — a causal correction, not a second win

Chess flipped from `racer_incorrect` (control, "tradition") to
`racer_correct` (candidate). It is tempting to count this as a second
success for the gate. **It is not, and crediting it as one would misstate
the evidence.**

The gate activated exactly once in this game, at t29, on the guess
"chess" — already at the correct grain — and allowed it. It never blocked
anything. The actual difference between this run and control is that this
run's own line of questioning, entirely independent of the gate, asked
"Is the target related to a sport, game, or competition?" at t19 — a
question the control run never asked in 34 turns. That is ordinary
run-to-run stochastic variance in what Grok chooses to ask next, the same
variance any two independent games of the same fixture would show even
under identical guidance and identical (absent) gate. **Nothing in this
experiment's mechanism caused that difference.** It is reported here in
full, including the evidence that rules the gate out as the cause, rather
than silently folded into a "2 of 3 mandatory cases fixed" count that the
data does not actually support.

## 5. Telemetry

Per-game totals across every xAI call this driver made (Racer turns, gate
checks, guess-intent resolutions — Composer calls stay on Anthropic and
are excluded, per the spec's §8 scope note):

| Fixture | Calls | Prompt tok | Completion tok | Reasoning tok | Total tok | Cached tok | Median latency | Max latency | `cost_in_usd_ticks` (raw, unit unconfirmed) |
|---|---|---|---|---|---|---|---|---|---|
| guitar | 29 | 30,508 | 1,366 | 35,776 | 67,650 | 5,504 | 7.6s | 89.4s | 1,252,108,000 |
| Golden Gate Bridge | 34 | 34,590 | 1,518 | 48,031 | 84,139 | 14,336 | 9.1s | 63.8s | 1,520,572,000 |
| chess | 58 | 61,698 | 2,598 | 67,076 | 131,372 | 32,640 | 7.5s | 144.1s | 2,170,355,000 |
| platypus | 28 | 28,115 | 1,230 | 27,863 | 57,208 | 17,920 | 7.8s | 65.1s | 890,602,500 |
| Eiffel Tower | 36 | 36,990 | 1,704 | 31,522 | 70,216 | 21,376 | 11.1s | 34.0s | 1,068,577,000 |
| **Total (5 games)** | **185** | **191,901** | **8,416** | **210,268** | **410,585** | **91,776** | 7.6s (all-call median) | 144.1s | **6,902,214,500** |

**Dollar cost: not computed.** Per the standing rule from the discovery
batch (never invent a conversion), `cost_in_usd_ticks`' unit was never
confirmed against a real invoice, so no per-game or total dollar figure is
reported — only the raw provider field, in full, for every call. The
reliable source for actual spend is the xAI Console for this key, filtered
to this run's window.

Full per-call diagnostics (including `rawUsage` verbatim) are in each
game's `.candidate-evidence.json` under `step_diagnostics`.

## 6. Facts vs. interpretations vs. hypotheses

**Observed facts:**
- 4/5 candidate games `racer_correct` (guitar, chess, platypus, Eiffel
  Tower), 1/5 `racer_incorrect` (Golden Gate Bridge).
- The gate activated exactly 5 times (once per game), never more than
  once in a single game.
- Exactly one block occurred (guitar), and the replacement behavior it
  installed was followed through to a correct, gate-approved final guess.
- Exactly one gate miss occurred (Golden Gate Bridge): the gate approved
  a guess ("bridge") that was the same bare-category shape as the target
  failure this whole experiment exists to catch, on one of the three
  mandatory failure-regression fixtures.
- Chess's improvement over control is not attributable to the gate — the
  gate never blocked anything in that game; the improvement traces to a
  different, unprompted question the Racer itself chose to ask this run.
- Zero hard-evidence violations across all 5 gate activations and all 5
  games' Integrity outcomes.
- Both must-not-regress controls held.

**Plausible interpretations:**
- The enforcement *architecture* — refusing to commit a guess action
  without independent gate approval, and installing a genuine replacement
  question when blocked — worked exactly as designed in the one case
  where it was actually exercised as the causal factor (guitar). The
  mechanism itself is not what failed on Golden Gate Bridge.
- What failed on Golden Gate Bridge is the gate's own semantic judgment:
  given a transcript that never developed a specific-referent
  discriminator (location, color, era, name), the gate reasoned the same
  way the Racer did and reached the same wrong conclusion. A second call
  with the same transcript and a similar underlying model is not
  guaranteed to be adversarial to that transcript's own blind spot.
- N=1 per fixture cannot distinguish "the gate has a systematic weakness
  on transcripts that never surface an identity-level discriminator" from
  "this was one unlucky roll." Both are consistent with the data.

**Unproven hypotheses, explicitly not acted on:**
- That a stronger or differently-worded gate prompt would have caught the
  Golden Gate Bridge case (untested — no second gate variant was built or
  run).
- That the gate's false-allow rate is representative beyond N=1 on this
  specific failure shape.
- Any claim about whether this approach would generalize better or worse
  than a prose-only fix — no prose-only variant was run in this
  experiment for comparison.

## 7. Verdict, rendered strictly against the pre-registered criteria (spec §7)

**Targeted success required:** eliminate the wrong-grain final-guess
defect on all three mandatory failure-regression cases (guitar, Golden
Gate Bridge, chess), with genuine replacement behavior, not merely a
blocked guess.

- guitar: **met**, and cleanly attributable to the mechanism.
- chess: outcome improved, but **not attributable to the mechanism** —
  the gate did not act as the cause (§4).
- Golden Gate Bridge: **not met**. The defect persisted, and the gate
  itself endorsed it.

**REJECT condition explicitly pre-registered:** *"Wrong-grain guesses
persist materially (the gate fails to catch what it was built to catch on
the mandatory regression cases)."* This condition is met — on one of the
three mandatory cases, the gate was shown the exact failure shape it was
built to catch and approved it anyway.

**Must-not-regress:** held cleanly (§3). No hard-evidence violations
(§2). No latency/cost blowup (§5).

**Rendered verdict: REJECT**, on the strict letter of the pre-registered
criteria — one of three mandatory failure-regression cases was not fixed,
and the gate was directly, actively complicit in that miss rather than
merely inheriting it. This is not a verdict that the enforcement
architecture is unsound: the one case where the gate's own judgment was
correct (guitar) shows the block-and-replace mechanism working exactly as
specified, end to end. It is a verdict that this specific gate prompt's
semantic reliability is not yet good enough to promote — the same
discipline this project applied to `racer/4.1.0` in M4 (REJECT despite a
partial improvement, because the target dimension was not cleanly fixed)
applies here for the same reason.

Per governance, this stops here: no second gate variant is proposed,
designed, or implemented in this session. `racer/4.0.0` is untouched.
`CANDIDATE_VALIDATION_GATE_VERSION` is not written to
`corpus.racer_guidance_versions` or `corpus.racer_guidance_decisions` and
is not eligible for promotion. This is a completed, REJECTED bounded
experiment, not a paused one.
