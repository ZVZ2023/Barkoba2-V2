import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.8.0 — PUBLIC RELEASE: one server-authoritative Racer for the ordinary
// Human<->AI public path, no client-controlled override.
//
// SOURCE STRUCTURE assertions, in the same idiom as
// test/xaiProvider.test.ts's own selection/persistence tests — the create
// route needs a live KV, secret store and network call to invoke, so
// nothing here executes it. A source match is a weaker claim than an
// executed one, said plainly rather than implied.
// ---------------------------------------------------------------------------

const CREATE_ROUTE = readFileSync("app/api/game/create/route.ts", "utf8");
const COMPOSER_ENTRY = readFileSync("app/ComposerEntry.tsx", "utf8");
const RACER_SETUP = readFileSync("app/RacerSetup.tsx", "utf8");

test("PUBLIC_RACER_PROVIDER is xai, declared once", () => {
  const matches = CREATE_ROUTE.match(/const PUBLIC_RACER_PROVIDER: ModelProviderId = "([^"]+)";/);
  assert.ok(matches, "PUBLIC_RACER_PROVIDER must be declared exactly this way");
  assert.equal(matches?.[1], "xai");
  const count = (CREATE_ROUTE.match(/const PUBLIC_RACER_PROVIDER/g) ?? []).length;
  assert.equal(count, 1, "exactly one declaration, no duplicate policy constant");
});

test("an ordinary (non-benchmark) caller's racer_provider is never read", () => {
  // The call site must feed PUBLIC_RACER_PROVIDER to resolveRacerProvider for
  // every caller EXCEPT one that already passed resolveBenchmark()'s
  // secret-header gate (isBenchmarkCaller) or a Human<->Human game (no
  // provider at all). body.racer_provider must not appear as the value fed
  // in for the ordinary branch.
  const callSite = CREATE_ROUTE.slice(
    CREATE_ROUTE.indexOf("const isBenchmarkCaller"),
    CREATE_ROUTE.indexOf("if (!racerProviderChoice.ok)")
  );
  assert.ok(callSite.length > 0, "could not isolate the racerProviderChoice call site");
  assert.match(callSite, /benchmark\.benchmark_case_id !== null/);
  assert.match(callSite, /isBenchmarkCaller \? body\.racer_provider : PUBLIC_RACER_PROVIDER/);
});

test("DEFAULT_RACER_PROVIDER is untouched — this is product policy, not a registry default", () => {
  // The V2.8.0 public-path decision must not be implemented by changing the
  // provider registry's own default, which other call sites (diagnostic
  // scripts, tests) still rely on meaning "anthropic".
  assert.match(CREATE_ROUTE, /DEFAULT_RACER_PROVIDER,\s*\n\s*isModelProviderId,\s*\n\s*isProviderAvailable,/);
});

test("the ordinary public client sends no racer_provider field", () => {
  assert.doesNotMatch(COMPOSER_ENTRY, /racer_provider/);
  // No visible provider/model picker either — the removed selector's own
  // labels must not reappear.
  assert.doesNotMatch(COMPOSER_ENTRY, /"Claude"|"Grok"/);
  assert.doesNotMatch(COMPOSER_ENTRY, /setRacerProvider|racerProvider/);
});

test("the AI-Composer / human-Racer surface never had a provider picker either", () => {
  // /play/ai: the Racer seat is human there, so there is nothing to pick —
  // asserted so a future change cannot introduce one silently.
  assert.doesNotMatch(RACER_SETUP, /racer_provider|"Claude"|"Grok"/);
});

test("selection-mode provenance is derivable from existing fields, not duplicated storage", () => {
  // V2.8.0 deliberately adds no new "who chose the provider" column. It is a
  // deterministic function of two fields already durable in corpus.games:
  // benchmark_case_id (non-null => internal/admin/benchmark caller chose it)
  // and racer_provider (set => an AI raced at all). Asserted here as a
  // documented invariant, not a claim about corpus.games' schema directly,
  // since that lives in a migration this task does not touch.
  assert.match(CREATE_ROUTE, /isBenchmarkCaller = benchmark\.benchmark_case_id !== null/);
});
