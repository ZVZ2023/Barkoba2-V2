# Barkóba — V1

Next.js (App Router) + Vercel, full-stack single deploy, per the approved architecture.

**Version `0.3.0.1`** · series `0.3.x` — Human Composer → AI Racer.

## Two games, one engine

- **`/`** — `0.6.x`: the AI picks a secret, you ask the questions.
- **`/compose`** — `0.3.x`: you set the secret, the AI guesses.

They share the store, the secret module, the budget ceilings, adjudication, and
integrity review. They differ only in which participant the server synthesises
on a turn: `/api/game/[id]/turn` (AI Racer) versus `/api/game/[id]/ask`
(AI Composer).

## Versioning

| Series | Configuration | Status |
|---|---|---|
| `0.3.x` | Human Composer → AI Racer | current |
| `0.6.x` | remaining configuration | not started |
| `0.9.x` | remaining configuration | not started |

Which remaining configuration lands in `0.6.x` versus `0.9.x` is not yet fixed.
`package.json` reads `0.3.0` because npm requires three-part semver; the
four-part build tag lives in `VERSION` and should be the git tag (`v0.3.0.1`).

Ad-hoc `M`-numbers are retired. Historical notes keep their original labels as
provenance only; everything shipped to date is consolidated as `0.3.0.1`.

## What `0.3.0.1` contains

- **M0 — Scaffold**: Next.js, TypeScript, Tailwind, KV binding, rate-limit config.
- **M1 — Data layer**: `GameRecord` / `SecretRecord` types, KV read/write, isolated secret access functions.
- **M2 — Validator**: target-entry UI → `/api/game/create` → Validator call → VALID / CLARIFICATION_REQUIRED / INVALID handling.
- **M3.1 — Detector language coverage**: Hungarian fixture set + targeted rules; two-tier hedge model; `index` → `turn_index`.
- **M3 — Racer loop**: `/api/game/[id]/turn`, Racer prompt on narrowed public state, deterministic Guess Detector with internal intent resolution, per-game language detection, Q&A thread UI, global spend ceiling, build-time isolation check.

- **M4 — Resolution**: `/api/game/[id]/resolve`, Adjudicator, Integrity Review, pure result-derivation table, single-point declassification, result screen, allowlist isolation check.

**Not yet built**: M4.1 adjudication fixture set; Hungarian fixture native-speaker pass.

**Explicitly not in scope**: Z-Score and Warning Triangle (schema-ready, dormant — require an explicit go-ahead). Phase 2 human-vs-human, accounts, persistence beyond guest TTL.

## Local setup

```bash
npm install
cp .env.example .env.local
# fill in ANTHROPIC_API_KEY at minimum
npm run dev
```

Verify everything before committing:

```bash
npm run verify   # isolation check → tests → typecheck → build (hermetic, no API key)
```

Evaluate the Adjudicator against its fixture set — **not** part of `verify`,
because it calls the real API:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run eval:adjudicator
npm run eval:adjudicator -- --repeat 3            # measure verdict stability
npm run eval:adjudicator -- --category part_vs_whole
npm run eval:adjudicator -- --concurrency 2      # lower for new / low-tier API keys
```

Transient failures (429, 529, 5xx) are retried with backoff. Calls that still
fail are **excluded from the pass-rate denominator**, not scored as wrong
verdicts — an infrastructure failure is not an adjudication failure. Any errors
are reported in an `ERR` column and the run refuses to describe itself as a
readable baseline.

The first run is a baseline with no pass threshold. Inspect the per-category
table, then set gates with `--gate` from evidence.

### Upstash is required from M3 onward, not optional

M0–M2 handled one request per game, so the in-memory KV fallback masked the
problem. M3 runs a ~20-turn loop across multiple requests: on Vercel those land
on different serverless instances, and an in-memory store will lose the game
between turns. The fallback is now for `npm run dev` on a single process only.
**Provision Upstash before deploying anything with M3 in it.**

## Isolation invariant (do not weaken)

`lib/secretStore.ts` is the only module permitted to read or write `SecretRecord` data (target + private clarification). It exports exactly four functions: `createSecret`, `lockSecret`, `getSecretForValidation`, `getSecretForAdjudication` — no generic getter. `lib/gameStore.ts` has no dependency on it, so anything built against public game state structurally cannot see the secret.

As of M3 this is enforced in three layers rather than promised in one:

1. `lib/prompts/racer.ts` does not accept `GameRecord`. It accepts `RacerPublicState`, an explicit narrowing built only by `toRacerPublicState()` in `lib/racerState.ts`. A new field on `GameRecord` is not inherited silently.
2. `scripts/check-isolation.mjs` walks the import graph from every Racer-facing module and **fails the build** on any path — direct or transitive — that reaches `lib/secretStore.ts`.
3. The check runs as part of `npm run build`, so it cannot be skipped by forgetting to run it.

See `docs/DESIGN-NOTES.md` for the full reasoning, plus the AMBIGUOUS rule, guess-flag resolution, and the Phase 2 human-Racer confirmation UI that is deliberately documented and not built.

## Configuration

Everything tunable lives in `lib/env.ts` — model IDs, rate limits, TTLs. No game logic reads `process.env` directly. See `.env.example` for the full list.

## Cost controls — two of them, doing different jobs

**Per-IP** (`lib/rateLimit.ts`): fixed-window, per-hour, on `/api/game/create`. Default 5 games/hour/IP via `RATE_LIMIT_GAMES_PER_HOUR`. `RATE_LIMIT_DISABLED=true` is local/dev only — never in a deployed environment with a real API key behind it.

**Global Racer** (`lib/callBudget.ts`): per-UTC-day counter on Racer model calls across all users and IPs, via `RACER_DAILY_CALL_CEILING` (default 2000; a full 20-question game costs ~20–25 calls). Per-IP limiting bounds the worst individual actor and says nothing about aggregate traffic or one actor across many IPs.

**Global resolve** (`lib/callBudget.ts`): separate per-UTC-day counter on Adjudicator + Integrity Review, via `RESOLVE_DAILY_CALL_CEILING` (default 300). Strong model, 1–2 calls per completed game. Kept separate so a busy day of cheap Racer turns cannot block adjudication of games already played to completion.

The global ceiling **fails closed**: if the counter cannot be read, calls are denied rather than allowed through. A KV outage that silently disabled the only global spend ceiling is the exact failure it exists to prevent.

## Language of play

`game_language` (`hu` | `en`) is detected once, at creation, by the Validator call that already runs — no extra model call, no setup question, no language picker. It flows into `RacerPublicState`, and the Racer plays in that language.

Detection never alters the Composer's target or private clarification; those stay canonical verbatim. There is deliberately **no i18n framework, translation layer, or UI locale architecture** in M3 — Hungarian UI is a separate frontend matter.

The Guess Detector covers English and Hungarian (M3.1). Hungarian needs its own possessive-suffix and specific-instance rules because it marks "your X" with a suffix rather than a separate word — see `docs/DESIGN-NOTES.md` §5.

⚠ Hungarian rules are tuned against `test/fixtures/hungarian.ts`, which has **not had a native-speaker pass**. The fixtures are grammatical but unvalidated against real play. Review protocol is at the top of that file: correct the phrasing, never the expected classification.

## Correcting an answer

`POST /api/game/[id]/correct` replaces a previously given answer. Correcting the
latest answer just replaces it; correcting an earlier one rewinds the game to
that turn, discards everything generated after it, and gives back the question
and ambiguous credits those turns consumed.

Counters are **recomputed** from the surviving log rather than decremented.
`question_count` is simply the number of YES/NO answers that survive.

Allowed in the `questioning` phase only — once the Racer has committed a guess,
correcting would let a Composer read the guess and invalidate it.

The endpoint makes no model call: the rewind leaves exactly the state
`POST /turn` already resumes from.

## Resolution

`POST /api/game/[id]/resolve` decides the game. Idempotent — a completed game returns its stored result with zero model calls, which matters because the client auto-fires it and each real invocation spends strong-model calls. On failure the phase stays `resolving` and the route returns 502: a game is never decided by an error path.

A correct guess costs **one** strong call — the Integrity Review is skipped entirely, not run and discarded. See `docs/DESIGN-NOTES.md` §7 for the full result table.

`revealed_target` is the single declassification point: the one place secret text enters public state, written only at completion. It is what lets the result screen show the target while the game page stays quarantined from `secretStore`.

## The turn loop

`POST /api/game/[id]/turn` is one route handling both halves of a turn. The optional `answer` field records the Composer's response to the pending question; the same request then generates the Racer's next question. One round trip, one KV read-modify-write.

If a request arrives with no answer while a question is already pending, the route returns the existing question **without calling the model**. KV has no compare-and-swap, and `reactStrictMode` double-fires effects in development, so this guard is what keeps a double-fire from burning a call and desynchronising the log.

## Model routing

`ANTHROPIC_MODEL_RACER` (fast/cheap, fires up to 20×/game) and `ANTHROPIC_MODEL_STRONG` (fires once/game for Validator/Adjudicator/Integrity Review) are independently configurable. Per your note: don't switch the Racer to the cheaper model in practice until its question quality has been benchmarked against the stronger model — the config supports the swap, it doesn't endorse it yet.

## Deploying

1. Push to a GitHub repo, import into Vercel.
2. Set env vars in Vercel project settings (from `.env.example`).
3. Provision an Upstash Redis database, add its REST URL/token.
4. Deploy. No separate backend to manage.
