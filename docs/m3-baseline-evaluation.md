# M3 — RG-4.0.0 Baseline Scorecard Evaluation

**Status:** M3 baseline closure artifact. Scores two controlled benchmark
transcripts against [docs/racer-scorecard.md](racer-scorecard.md) exactly as
written. Does not modify Racer Guidance, does not implement any candidate
intervention, and does not make a promotion/rejection decision — that
remains M4's job, per `docs/racer-scorecard.md` §8 and the M0 scorecard's own
governing rule.

**Guidance under evaluation:** `racer/4.0.0`
([lib/prompts/racer.ts](../lib/prompts/racer.ts)). Confirmed unmodified
throughout M1–M3 (`git diff d75e605 -- lib/prompts/racer.ts` is empty).

**Frozen evidence:**

| | D-1 "Generic Backpack" | D-2 "The Eiffel Tower" |
|---|---|---|
| `benchmark_case_id` | `m1-d1-generic-backpack` | `m3-d2-eiffel-tower` |
| `benchmark_run_id` | `c1e02ec4-fedb-4583-9ef8-63dde24eed3a` | `3dd81fc2-a45d-460f-ba16-3ec7c2861b81` |
| `operational_game_id` | `76041765-4654-4eb1-8713-32591d396600` | `ad9274cd-f332-4e4e-ad48-b5ab208a4671` |
| `corpus_game_id` | `b9bce8bb-43e2-48f5-ab32-e0f284529793` | `fe7f88c2-01f0-44ca-b168-3365563cfbc4` |
| Full transcript | [d1-generic-backpack.transcript.json](m3-evidence/d1-generic-backpack.transcript.json) | [d2-eiffel-tower.transcript.json](m3-evidence/d2-eiffel-tower.transcript.json) |
| Target granularity | `generic_type` | `specific_instance` — the one deliberately varied experimental parameter; model, provider, `max_questions=50`, `difficulty=medium`, `game_language=en` all held identical |
| `question_count` / `max_questions` | 49 / 50 | 42 / 50 |
| `ambiguous_count` | 24 | 0 |
| `outcome` | `racer_correct` | `racer_correct` |
| `adjudicator_confidence` | 1.0 | 1.0 |

Both transcripts are full, reconstructed `qa_log`s (every `turn_index`,
`question_text`, `composer_response`, and `rationale`), not narrative
fragments — extracted via
[lib/corpus/transcriptExport.ts](../lib/corpus/transcriptExport.ts). No
dimension below is UNSCORABLE for missing-evidence reasons.

---

## Per-dimension scores

| Dim | D-1 | D-2 | D-1 citation | D-2 citation |
|---|---|---|---|---|
| **D1** Solve outcome | Excellent | Excellent | t50 | t43 |
| **D2** Question efficiency | Fair | Fair | t1–20 (arc) vs. t21–49 (plateau) | t17–24, t26–37 (sibling-enumeration pattern, net of D4/D9 below) |
| **D3** Evidence consistency | Excellent | Good | full transcript, no inconsistency found | t38→t39 (rationale misstates t38's actual `YES` as `NO`; one-off, harmless) |
| **D4** Redundancy | Poor | Poor | t12; t31, t41, t42 | t10→t35; t11→t34; t20→t21; t28→t37 (t37 self-acknowledged in the Racer's own rationale) |
| **D5** Contradiction handling | N/A | N/A | full transcript, no falsifying answer found | full transcript, no falsifying answer found |
| **D6** Category/instance discipline | Fair | Excellent | t21–49 (over-narrowing, self-corrected only at t50) | t42→t43 (identity-directed throughout, no category-level shortcut) |
| **D7** Ambiguity handling | Poor | N/A | t24 & t26 (paraphrase repeat) + t25/29/32/35/36/44–48 cluster | `ambiguous_count=0`, full transcript checked |
| **D8** Guess timing | Excellent | Fair | t49→t50 (named rival "school backpack" falsified before guessing) | t38–43 (no named rival tested; none clearly available either) |
| **D9** Recovery from a bad branch | Poor | Poor | t7–14→t15 (1 episode, 8 consecutive NOs) | t8–14→t15; t17–24→t25; t26–37→t38 (3 episodes, up to 12 consecutive NOs) |

### Notable negative result

The experiment was designed on the hypothesis that a `specific_instance`
target (D-2) would stress D6 harder than D-1's `generic_type` target.
**It did not.** D6 scored *better* on D-2 (Excellent) than D-1 (Fair).
Reported plainly rather than dropped — this tempers, not confirms, the
hypothesis the D-2 case was built to test.

---

## Citation-backed failure classification — ranked (materiality first, recurrence second)

1. **D7 Poor — ambiguity misuse (D-1 only).** Highest single-instance
   materiality in the baseline: 24 of 49 questions (49%) came back
   `AMBIGUOUS`, leaving only 1 question of headroom at the end. Zero
   recurrence yet (D-2: `ambiguous_count=0`). N=1 for this specific failure —
   flagged per the standing rule that not every failure becomes a candidate
   rule.

2. **D4 Poor/Poor — redundant question.** A high-materiality instance in D-1
   (t41/t42, inside the tightest 9-question window) **plus** full 2/2
   recurrence — D-2 independently produced four more redundant pairs with
   zero `AMBIGUOUS` answers to blame it on, one self-admitted by the Racer's
   own rationale. Combined high materiality + perfect recurrence makes this
   the strongest overall candidate in the baseline.

3. **D9 Poor/Poor — poor branch recovery.** Moderate per-instance
   materiality (never actually threatened either game's final budget), but
   **perfect recurrence** (2/2) and the pattern **worsened** on the second
   sample: 1 episode / 8 NOs (D-1) → 3 episodes / up to 12 NOs (D-2). The
   cleanest recurrence signal in the baseline.

4. **D2 Fair/Fair — question efficiency (net of D4/D9).** Lower materiality,
   recurs in both games for related but distinct proximate causes.

5. **D6 Fair (D-1 only) / D8 Fair (D-2 only) — no consistent signal.** Each
   appears in exactly one game and is clean (Excellent) in the other.
   Opposite results, not a recurring pattern — with N=2 this reads as
   target-specific variation, not yet a systemic weakness.

---

## Scope discipline

- No change to `CORE_RACER_RULES` / `RACER_PROMPT_VERSION`.
- No candidate intervention implemented.
- No promotion/rejection decision recorded against `racer/4.0.0` — it
  remains unevaluated in the governance sense (`corpus.racer_guidance_decisions`
  stays at zero rows for this version; nothing in M3 writes to that table).
- M3 measures and classifies. M4 intervenes.
