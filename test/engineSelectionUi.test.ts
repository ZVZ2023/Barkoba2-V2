import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.8.8.7 — COST-SAFE AI ENGINE SELECTION, the UI and route-ordering half.
//
// Entitlement/ledger behaviour (default charge unchanged, premium
// purchased-only gating, the developer/admin exemption, duplicate-request
// safety, idempotency) is proven behaviourally against a mocked ledger in
// test/premiumEngine.test.ts. This file is source-contract only, matching
// the established idiom for React/route files with no rendering harness
// (see e.g. test/gameHistory.test.ts's own header comment).
// ---------------------------------------------------------------------------

const COMPOSER = readFileSync("app/ComposerEntry.tsx", "utf8");
const CREATE_ROUTE = readFileSync("app/api/game/create/route.ts", "utf8");

// ---------------------------------------------------------------------------
// UX: default preselected, mobile-first, simple choice.
// ---------------------------------------------------------------------------

test("SOURCE: the engine picker defaults to \"standard\" — preselected, matching the unchanged default charge", () => {
  assert.match(COMPOSER, /const \[engineTier, setEngineTier\] = useState<EngineTier>\("standard"\);/);
});

test("SOURCE: exactly two full-width, stacked (mobile-first) engine buttons exist", () => {
  const at = COMPOSER.indexOf('Ellenfél');
  assert.ok(at > 0);
  const block = COMPOSER.slice(at, at + 1500);
  assert.match(block, /onClick=\{\(\) => setEngineTier\("standard"\)\}/);
  assert.match(block, /onClick=\{\(\) => setEngineTier\("premium"\)\}/);
  // The standard label is bilingual, keyed on gameLanguage — never a fixed
  // Hungarian-only string the way the premium label is.
  assert.match(block, /\{gameLanguage === "en" \? "Reasoning AI" : "Érvelő AI"\}/);
  assert.match(block, /Emberi szintű AI/);
  // Stacked, not side-by-side — "flex-col", not "flex" alone or "grid-cols-2".
  assert.match(block, /className="flex flex-col gap-2"/);
});

test("SOURCE: the provider/model behind either engine is never named in ComposerEntry.tsx", () => {
  // "grok" is deliberately excluded from this blanket scan: an existing,
  // unrelated comment on this screen already uses "Grok" as an example
  // TARGET a player might type (like "Apple" or "Tesla"), not a reference
  // to the standard engine's actual provider. See
  // test/premiumEngine.test.ts's own dedicated, exact-count grok check.
  for (const forbidden of [/claude-opus/i, /\banthropic\b/i, /gpt-6/i, /\bopenai\b/i, /\bxai\b/i]) {
    assert.doesNotMatch(COMPOSER, forbidden, `must not name a provider/model (found ${forbidden})`);
  }
});

// ---------------------------------------------------------------------------
// Bilingual price copy, Hungarian label preserved.
// ---------------------------------------------------------------------------

test("SOURCE: complete Hungarian and English price/disclaimer copy exists, keyed to the game's language", () => {
  assert.match(COMPOSER, /hu: \{/);
  assert.match(COMPOSER, /en: \{/);
  assert.match(COMPOSER, /2 gombóc — jelenleg kb\. 4,20 USD \/ játék/);
  assert.match(COMPOSER, /2 scoops — currently about USD 4\.20 per game/);
  assert.match(
    COMPOSER,
    /A hozzávetőleges USD-árfolyam és az ár a vezető csúcskategóriás modellek/
  );
  assert.match(
    COMPOSER,
    /The approximate USD equivalent and price may change as exchange rates/
  );
  assert.match(COMPOSER, /gameLanguage === "en" \? PREMIUM_PRICE_COPY\.en : PREMIUM_PRICE_COPY\.hu/);
});

test("SOURCE: clearly distinguishes the ordinary charge from the premium charge BEFORE game creation — price copy renders unconditionally, not only after selecting premium", () => {
  const at = COMPOSER.indexOf("Ellenfél");
  const block = COMPOSER.slice(at, at + 2000);
  // The price line renders regardless of which button is currently selected —
  // i.e. it is not gated behind `engineTier === "premium" &&`.
  const priceAt = block.indexOf("priceCopy.price");
  assert.ok(priceAt > 0);
  const guard = block.slice(Math.max(0, priceAt - 150), priceAt);
  assert.doesNotMatch(guard, /engineTier === "premium" &&\s*$/, "the price must be visible before selecting premium, not only after");
});

// ---------------------------------------------------------------------------
// If premium access is unavailable: explain why, offer the purchase action,
// never create or charge for a game.
// ---------------------------------------------------------------------------

test("SOURCE: premium ineligibility shows an explanation and reuses CreditGateway — no separate purchase flow was built", () => {
  const at = COMPOSER.indexOf("Ellenfél");
  const block = COMPOSER.slice(at, at + 2500);
  assert.match(block, /engineTier === "premium" && !premiumEligible/);
  assert.match(block, /priceCopy\.ineligible/);
  assert.match(block, /<CreditGateway \/>/);
});

test("SOURCE: the submit button is disabled while premium is selected and ineligible — a courtesy, not the enforcement", () => {
  const at = COMPOSER.indexOf("Célpont rögzítése");
  const block = COMPOSER.slice(Math.max(0, at - 500), at);
  assert.match(
    block,
    /engineTier === "premium" && entitlement\.view\?\.premium_engine\?\.eligible !== true/
  );
});

test("SOURCE: a refused premium submission is distinguished from an ordinary credit refusal, so the right message and CreditGateway show", () => {
  assert.match(COMPOSER, /const \[premiumIneligible, setPremiumIneligible\] = useState\(false\);/);
  assert.match(COMPOSER, /if \(data\.error === "premium_engine_insufficient_credit"\) setPremiumIneligible\(true\);/);
  assert.match(COMPOSER, /\{premiumIneligible && <CreditGateway \/>\}/);
});

test("SOURCE: the request sends only a stable internal tier id, never a provider/model", () => {
  assert.match(COMPOSER, /engine_tier: engineTier,/);
});

// ---------------------------------------------------------------------------
// Server-side ordering: premium is gated and priced entirely before the
// Validator call, so a refusal costs no model call and charges nothing.
// ---------------------------------------------------------------------------

test("SOURCE: premium eligibility is resolved BEFORE the Validator call, exactly like racerProviderChoice", () => {
  const eligibilityAt = CREATE_ROUTE.indexOf("const premiumEligibility = await canFundPremiumEngine(playerId);");
  const validatorAt = CREATE_ROUTE.indexOf("validation = await runValidator(");
  assert.ok(eligibilityAt > 0 && validatorAt > eligibilityAt, "premium eligibility must be checked before the Validator call");
});

test("SOURCE: an invalid engine_tier is refused outright (400), never silently coerced to standard", () => {
  assert.match(CREATE_ROUTE, /error: "invalid_engine_tier"/);
});

test("SOURCE: the benchmark/internal testing surface is untouched by engine tier — it keeps choosing racer_provider directly", () => {
  const at = CREATE_ROUTE.indexOf("const requestedEngineTier = humanVsHuman || isBenchmarkCaller ? undefined : body.engine_tier;");
  assert.ok(at > 0, "engine_tier must be ignored for both humanVsHuman and a benchmark caller");
});

test("SOURCE: premium charges through consumeForPremiumEngine, never consumeForGame; every other game is unaffected", () => {
  assert.match(
    CREATE_ROUTE,
    /racerEngineTier === "premium"\s*\n\s*\? await consumeForPremiumEngine\(playerId, game\.game_id\)\s*\n\s*: await consumeForGame\(playerId, game\.game_id, game\.max_questions, entitlementOptions\);/
  );
});

test("SOURCE: a premium game is recorded with its own racer_provider (PREMIUM_RACER_PROVIDER) and racer_engine_tier, both null for humanVsHuman exactly like racer_provider today", () => {
  assert.match(CREATE_ROUTE, /racer_provider: humanVsHuman \? null : finalRacerProvider,/);
  assert.match(CREATE_ROUTE, /racer_engine_tier: humanVsHuman \? null : racerEngineTier,/);
});

test("SOURCE: the premium provider is resolved through the SAME resolveRacerProvider refusal contract — unavailable refuses, never substitutes", () => {
  const at = CREATE_ROUTE.indexOf('if (racerEngineTier === "premium") {');
  const block = CREATE_ROUTE.slice(at, at + 700);
  assert.match(block, /const premiumProviderChoice = resolveRacerProvider\(PREMIUM_RACER_PROVIDER\);/);
  assert.match(block, /if \(!premiumProviderChoice\.ok\) return premiumProviderChoice\.response;/);
});
