# Deploying Barkóba `0.3.x` to Vercel

Target: one public URL that opens and plays end to end on a phone.

## Blockers — read first

**Both are hard requirements. Neither can be skipped, and neither is optional.**

### 1. Upstash Redis is mandatory

Not advisory. Without it, `/api/game/create` returns **503 with an explanatory
message** (added deliberately in `0.3.1.0`) rather than creating a game that
dies on its first turn.

Why: a turn loop spans many requests. On Vercel those land on different
serverless instances, which do not share memory. The in-memory fallback exists
only for `npm run dev` on a single process.

### 2. `ANTHROPIC_API_KEY` must be set in Vercel

Local `.env.local` is **not** uploaded. The key must be set in the Vercel
project, or every Validator and Racer call fails.

## Steps

1. **Push to GitHub.** `.gitignore` already excludes `node_modules`, `.next`,
   and every `.env*` variant — confirm `.env.local` is not staged before the
   first commit.

2. **Provision Upstash Redis** (Vercel Marketplace → Upstash, or upstash.com).
   Copy the **REST** URL and token — not the Redis protocol URL.

3. **Import the repo into Vercel.** Framework auto-detects as Next.js. No build
   settings to change; `next.config.mjs` needs nothing for Vercel.

4. **Set environment variables** (Project → Settings → Environment Variables),
   for Production *and* Preview:

   | Variable | Required | Notes |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | **yes** | |
   | `UPSTASH_REDIS_REST_URL` | **yes** | REST URL, not `redis://` |
   | `UPSTASH_REDIS_REST_TOKEN` | **yes** | |
   | `ANTHROPIC_MODEL_STRONG` | no | defaults to `claude-sonnet-5` |
   | `ANTHROPIC_MODEL_RACER` | no | defaults to `claude-haiku-4-5-20251001` |
   | `MAX_QUESTIONS` | no | defaults to 20 |
   | `RATE_LIMIT_GAMES_PER_HOUR` | no | defaults to 5 |
   | `RACER_DAILY_CALL_CEILING` | no | defaults to 2000 |
   | `RESOLVE_DAILY_CALL_CEILING` | no | defaults to 300 |

   **Do not set `RATE_LIMIT_DISABLED`.** It exists for local development. In a
   deployed environment with a real key behind it, it removes the only per-IP
   spend control.

5. **Deploy**, then walk one full game on a phone: set a target → answer
   questions → reach a verdict.

## If it breaks

| Symptom | Cause |
|---|---|
| 503, "durable storage is missing" | Upstash vars not set, or set only for Preview |
| 502 "Could not validate the target" | `ANTHROPIC_API_KEY` missing or invalid |
| 429 on the first game | `RATE_LIMIT_GAMES_PER_HOUR` too low, or shared IP |
| Turn hangs past ~60s | Function timeout; routes declare `maxDuration = 60` |

## Costs live

Per completed 20-question game: roughly 20–25 Racer calls (cheap model) plus 1
Validator and 1–2 resolution calls (strong model). Per-IP limiting caps one
abuser at 5 games/hour; the global daily ceilings cap everyone together and
fail closed.
