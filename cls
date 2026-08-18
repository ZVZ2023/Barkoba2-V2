[1mdiff --git a/.env.example b/.env.example[m
[1mindex bd39dea..4ff47a0 100644[m
[1m--- a/.env.example[m
[1m+++ b/.env.example[m
[36m@@ -1,6 +1,10 @@[m
 # --- Required ---[m
 ANTHROPIC_API_KEY=sk-ant-...[m
 [m
[32m+[m[32m# Existing Digital Ice Cream storefront. Barkóba adds only an opaque purchase[m
[32m+[m[32m# reference; DICS products, prices and customer-facing offers stay unchanged.[m
[32m+[m[32mDICS_STOREFRONT_URL=https://zvz2023.github.io/Lighthouse/digital-ice-cream/[m
[32m+[m
 # --- Model routing (configurable, no code changes needed to swap) ---[m
 # Fast/cheap model for the repeated per-turn Racer loop.[m
 ANTHROPIC_MODEL_RACER=claude-haiku-4-5-20251001[m
[36m@@ -93,15 +97,15 @@[m [mCORPUS_RECONCILE_BATCH=3[m
 ENTITLEMENTS_ENABLED=false[m
 [m
 # First-contact allowance, granted at most once per player.[m
[31m-# Spendable on any tier, including budget-100 (cost 5). No complimentary-[m
[32m+[m[32m# Spendable on any tier, including budget-100 (cost 1). No complimentary-[m
 # specific cap: RACER_DAILY_CALL_CEILING is the systemwide backstop.[m
 ENTITLEMENT_COMPLIMENTARY_GRANT=10[m
 [m
 # NOTE: there is no per-game cost setting. Cost is derived server-side from the[m
[31m-# resolved question budget (lib/questionBudget.ts): 20->1, 35->2, 50->3, 100->5.[m
[31m-# That curve is arbitrary and monotonic, NOT a calibrated cost proxy. Keeping it[m
[31m-# out of the environment is deliberate — no deployment setting, and therefore no[m
[31m-# caller, can state what a game costs.[m
[32m+[m[32m# the resolved question budget (lib/questionBudget.ts): every offered tier costs[m
[32m+[m[32m# one internal Play Credit, so one player-facing RACE always means one playable[m
[32m+[m[32m# run. Keeping it out of the environment is deliberate — no deployment setting,[m
[32m+[m[32m# and therefore no caller, can state what a run costs.[m
 [m
 # --- V2.5-B3: xAI / Grok as a selectable Racer ---[m
 # SERVER SIDE ONLY. Never prefix with NEXT_PUBLIC_ and never return it from a[m
[1mdiff --git a/lib/env.ts b/lib/env.ts[m
[1mindex 423d93a..ee88427 100644[m
[1m--- a/lib/env.ts[m
[1m+++ b/lib/env.ts[m
[36m@@ -42,6 +42,12 @@[m [mfunction optionalInt(name: string, fallback: number): number {[m
 export const env = {[m
   anthropicApiKey: () => required("ANTHROPIC_API_KEY"),[m
 [m
[32m+[m[32m  // Ordinary DICS storefront. The purchase reference is appended by the[m
[32m+[m[32m  // intent route; DICS then forwards it invisibly as Stripe client_reference_id.[m
[32m+[m[32m  dicsStorefrontUrl: () =>[m
[32m+[m[32m    process.env.DICS_STOREFRONT_URL ||[m
[32m+[m[32m    "https://zvz2023.github.io/Lighthouse/digital-ice-cream/",[m
[32m+[m
   // Fast/cheap model for the repeated per-turn Racer loop.[m
   modelRacer: () => process.env.ANTHROPIC_MODEL_RACER || "claude-haiku-4-5-20251001",[m
 [m
