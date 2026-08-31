# Failed / partial xAI-backed executions — D-1 calibration

Preserved per this batch's own governance: a failed/partial run that consumed
API calls is tracked separately, never silently discarded, and never counted
as a game result.

## Attempt 1 — whole-game timeout (discarded as a fixture design, not just this run)

- **Route:** `app/api/internal/benchmark/d1-grok-calibration` (whole-game-per-request runner, `maxDuration=300`)
- **Time:** 2026-08-31T16:32:22Z request start → 2026-08-31T16:37:25Z client gave up
- **Result:** `HTTP 504 FUNCTION_INVOCATION_TIMEOUT` (Vercel platform timeout, not an application error)
- **What happened:** the entire D-1 game (create + full turn loop + resolve) ran inside one serverless invocation. Grok's reasoning latency per turn meant the game did not resolve within the 300s ceiling. The function was killed mid-game; no `game_id` or usage data was ever returned to this session.
- **Cost:** real xAI API calls were made before the kill (at least the opening Racer turn, plausibly several more); **exact token/cost figures are unavailable** — the request never returned a response, so no `diagnostics` payload exists for this attempt. This is reported as a known gap, not estimated or fabricated.
- **Disposition:** this whole-game-per-request *pattern* was retired for Grok entirely after this attempt — replaced by the turn-by-turn stepping driver (`scripts/runGrokStep.ts`, `app/api/internal/benchmark/grok-step`). No game record from this attempt was used as evidence.

## Attempt 2 — single-step timeout under the stepping driver's initial (too low) ceiling

- **Route:** `app/api/internal/benchmark/grok-step` (turn-by-turn driver, `maxDuration=60` at the time)
- **Time:** step 8 of the D-1 stepping run, immediately following the 7th successfully logged step
- **Result:** `HTTP 504 FUNCTION_INVOCATION_TIMEOUT`
- **What happened:** a single turn-cycle (one Composer answer via Anthropic, one Grok Racer turn) exceeded the initial 60s ceiling set on the stepping route. `game_id=11cff3a1-1e8b-4369-bd5a-462047c48c3d` (`benchmark_run_id=a907336a-5e0e-488f-b6b4-5b3813a61035`) — the 7 prior steps were already persisted and unaffected.
- **Cost:** one real Grok Racer-turn attempt was made and killed before returning; **exact token/cost figures are unavailable** for this specific call, same reason as Attempt 1.
- **Disposition:** `maxDuration` raised to 300 on the stepping route (matching every other internal/benchmark route); the same `game_id` was then resumed from its persisted state (question 7) via `grok-loop`'s resume mode and completed successfully. **This game's own final, valid evidence is [d1-generic-backpack.grok.transcript.json](d1-generic-backpack.grok.transcript.json)** — the game itself is real, valid evidence; only this one intermediate step attempt failed and is recorded here separately.

## Accounting note

Both failed attempts are excluded from the successful-game cost buckets in the
batch report. Their real, non-zero API cost is acknowledged but cannot be
itemized from this session's own data — only Zsolt's Anthropic/xAI Console
readings capture it. This is flagged explicitly rather than guessed at.
