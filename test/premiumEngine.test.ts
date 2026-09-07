import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import {
  PREMIUM_ENGINE_PLAY_CREDIT_COST,
  canFundPremiumEngine,
  canStartGame,
  consumeForGame,
  consumeForPremiumEngine,
  getBalance,
  getStatus,
  grantComplimentary,
  purchasedEligibleBalance,
} from "../lib/entitlements";
import { creditsForPackage } from "../lib/playCreditPackages";
import { racerModelFor } from "../lib/prompts/racer";

// ---------------------------------------------------------------------------
// V2.8.8.7 — COST-SAFE AI ENGINE SELECTION, the entitlement half.
//
// A production data audit is not needed here (this is new code, not a
// reported production defect) — this is the standard in-memory-ledger
// harness every other entitlement suite in this repo uses, modelling
// accounts.entitlement_ledger as a plain array and evaluating each
// statement's WHERE guard by hand, the same way test/entitlements.test.ts
// and test/unlimitedPlay.test.ts already do.
// ---------------------------------------------------------------------------

interface Row {
  player_id: string;
  kind: string;
  amount: number;
  operational_game_id: string | null;
  note: string | null;
}

let ledger: Row[] = [];
let exempt = new Set<string>();
let failNext = false;

const SAVED = {
  enabled: process.env.ENTITLEMENTS_ENABLED,
  db: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
};

function balanceOf(player: string): number {
  return ledger.filter((r) => r.player_id === player).reduce((n, r) => n + r.amount, 0);
}
function purchasedOf(player: string): number {
  return ledger
    .filter((r) => r.player_id === player && r.kind === "purchase")
    .reduce((n, r) => n + r.amount, 0);
}
function premiumConsumedOf(player: string): number {
  return -ledger
    .filter((r) => r.player_id === player && r.kind === "consumption" && r.note === "premium_engine_start")
    .reduce((n, r) => n + r.amount, 0);
}

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  if (failNext) return Promise.reject(new Error("neon unavailable"));
  const sql = strings.join(" ");
  const v = values as unknown[];

  if (/FROM accounts\.unlimited_play/.test(sql)) {
    return Promise.resolve(exempt.has(String(v[0])) ? [{ "?column?": 1 }] : []);
  }

  // getStatus()'s one aggregate read. player_id is always the LAST
  // interpolated value (its WHERE clause is necessarily last).
  if (/FILTER \(WHERE kind = 'complimentary_grant'\)/.test(sql)) {
    const player = String(v[v.length - 1]);
    return Promise.resolve([
      {
        balance: balanceOf(player),
        complimentary_granted: ledger
          .filter((r) => r.player_id === player && r.kind === "complimentary_grant")
          .reduce((n, r) => n + r.amount, 0),
        purchased: purchasedOf(player),
        consumed: -ledger
          .filter((r) => r.player_id === player && r.kind === "consumption")
          .reduce((n, r) => n + r.amount, 0),
        expired: 0,
        initial_complimentary_granted: false,
        anonymous_complimentary_granted: false,
        premium_consumed: premiumConsumedOf(player),
      },
    ]);
  }

  // getBalance()'s plain query — checked AFTER the getStatus branch above,
  // since getStatus's own SELECT list also contains this substring as its
  // first column and would otherwise be intercepted here first.
  if (/SELECT COALESCE\(SUM\(amount\), 0\) AS balance/.test(sql)) {
    return Promise.resolve([{ balance: balanceOf(String(v[0])) }]);
  }

  // Idempotency probe, shared by consumeForGame and consumeForPremiumEngine.
  if (/SELECT entry_id FROM accounts\.entitlement_ledger/.test(sql) && !/INSERT/.test(sql)) {
    const gameId = String(v[0]);
    const hit = ledger.find((r) => r.kind === "consumption" && r.operational_game_id === gameId);
    return Promise.resolve(hit ? [{ entry_id: 1 }] : []);
  }

  // The conditional consumption INSERT. Premium's carries a SECOND guard
  // (purchased - premium_consumed >= cost) that the ordinary one does not —
  // distinguished by the presence of "kind = 'purchase'" in the guard text.
  if (/'consumption'/.test(sql) && /INSERT INTO accounts\.entitlement_ledger/.test(sql)) {
    const isPremium = /FILTER \(WHERE kind = 'purchase'\)/.test(sql);
    if (isPremium) {
      // Params: player, -cost, gameId, note, player, cost, player, note, cost
      const [player, amount, gameId, note] = [String(v[0]), Number(v[1]), String(v[2]), String(v[3])];
      const cost = Number(v[8]);
      if (ledger.some((r) => r.kind === "consumption" && r.operational_game_id === gameId)) {
        return Promise.resolve([]);
      }
      if (balanceOf(player) < cost) return Promise.resolve([]);
      if (purchasedOf(player) - premiumConsumedOf(player) < cost) return Promise.resolve([]);
      ledger.push({ player_id: player, kind: "consumption", amount, operational_game_id: gameId, note });
      return Promise.resolve([{ entry_id: ledger.length }]);
    }
    // Ordinary consumeForGame charge. Params: player, -cost, gameId, player, cost.
    const [player, amount, gameId] = [String(v[0]), Number(v[1]), String(v[2])];
    const cost = Number(v[4]);
    if (ledger.some((r) => r.kind === "consumption" && r.operational_game_id === gameId)) {
      return Promise.resolve([]);
    }
    if (balanceOf(player) < cost) return Promise.resolve([]);
    ledger.push({ player_id: player, kind: "consumption", amount, operational_game_id: gameId, note: "game_start" });
    return Promise.resolve([{ entry_id: ledger.length }]);
  }

  // Grants (complimentary or purchased) — pushed directly by tests via
  // seedLedger() below in most cases, but grantComplimentary is still
  // exercised directly in a couple of tests.
  if (/INSERT INTO accounts\.entitlement_ledger/.test(sql)) {
    const kind = /'complimentary_grant'/.test(sql) ? "complimentary_grant" : "purchase";
    const player = String(v[0]);
    const amount = Number(v[1]);
    ledger.push({ player_id: player, kind, amount, operational_game_id: null, note: null });
    return Promise.resolve([{ entry_id: ledger.length }]);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (q: Promise<Record<string, unknown>[]>[]) => Promise.all(q);

/** Seed a ledger row directly, bypassing grantPurchase()'s account requirement — this suite tests premium consumption, not the purchase-grant path itself (that is playCreditPackages.test.ts's scope). */
function seedPurchase(player: string, amount: number) {
  ledger.push({ player_id: player, kind: "purchase", amount, operational_game_id: null, note: null });
}

beforeEach(() => {
  ledger = [];
  exempt = new Set();
  failNext = false;
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  process.env.ENTITLEMENTS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  for (const [k, val] of [
    ["ENTITLEMENTS_ENABLED", SAVED.enabled],
    ["DATABASE_URL", SAVED.db],
    ["CORPUS_ENABLED", SAVED.corpus],
  ] as const) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
});

const P = "p".repeat(32);
const DEV = "d".repeat(32);

// ---------------------------------------------------------------------------
// Price: reused, not invented.
// ---------------------------------------------------------------------------

test("the premium engine's price is exactly what 2 Digital Ice Cream scoops are worth, reusing the existing reward table", () => {
  assert.equal(PREMIUM_ENGINE_PLAY_CREDIT_COST, creditsForPackage("dics_scoop", 2));
  assert.equal(PREMIUM_ENGINE_PLAY_CREDIT_COST, 15);
});

// ---------------------------------------------------------------------------
// Default selection: unchanged.
// ---------------------------------------------------------------------------

test("default engine: the existing per-game charge is exactly 1 Play Credit, unaffected by this feature", async () => {
  seedPurchase(P, 0);
  await grantComplimentary(P, 5);
  const r = await consumeForGame(P, randomUUID(), 20);
  assert.deepEqual(r, { ok: true, reason: "consumed" });
  assert.equal(await getBalance(P), 4);
});

// ---------------------------------------------------------------------------
// Premium selection: costs exactly two purchased scoops' worth.
// ---------------------------------------------------------------------------

test("premium selection costs exactly PREMIUM_ENGINE_PLAY_CREDIT_COST, funded from a purchased balance", async () => {
  seedPurchase(P, PREMIUM_ENGINE_PLAY_CREDIT_COST);
  assert.deepEqual(await canFundPremiumEngine(P), { ok: true, reason: "consumed" });
  const r = await consumeForPremiumEngine(P, randomUUID());
  assert.deepEqual(r, { ok: true, reason: "consumed" });
  assert.equal(await getBalance(P), 0);
});

// ---------------------------------------------------------------------------
// Anonymous free play cannot select premium.
// ---------------------------------------------------------------------------

test("anonymous free play cannot select premium: a purely complimentary balance is refused", async () => {
  await grantComplimentary(P, 100); // an implausibly large anonymous/complimentary grant
  assert.deepEqual(await canFundPremiumEngine(P), { ok: false, reason: "insufficient_balance" });
  const r = await consumeForPremiumEngine(P, randomUUID());
  assert.deepEqual(r, { ok: false, reason: "insufficient_balance" });
  assert.equal(await getBalance(P), 100, "the complimentary balance must be untouched by a refused premium charge");
});

// ---------------------------------------------------------------------------
// Registration-granted promotional credits cannot fund premium.
// ---------------------------------------------------------------------------

test("registration-granted promotional credits cannot fund premium, even in large quantity", async () => {
  // Simulates the post-verification initial_complimentary allowance — still
  // just a 'complimentary_grant' row, never 'purchase'.
  await grantComplimentary(P, PREMIUM_ENGINE_PLAY_CREDIT_COST * 2);
  assert.deepEqual(await canFundPremiumEngine(P), { ok: false, reason: "insufficient_balance" });
});

test("mixed balance: purchased funds premium, complimentary in the same balance does not inflate eligibility", async () => {
  seedPurchase(P, 10);
  await grantComplimentary(P, 20);
  // Total balance is 30, but only 10 was ever purchased — insufficient for the 15-credit price.
  assert.equal(await getBalance(P), 30);
  assert.deepEqual(await canFundPremiumEngine(P), { ok: false, reason: "insufficient_balance" });

  seedPurchase(P, 5); // now 15 purchased total, balance now 35 (10+20+5)
  assert.deepEqual(await canFundPremiumEngine(P), { ok: true, reason: "consumed" });
  const r = await consumeForPremiumEngine(P, randomUUID());
  assert.deepEqual(r, { ok: true, reason: "consumed" });
  // The charge draws from the shared fungible balance (35 -> 20), and the
  // purchased pool is now fully spent (15 - 15 = 0), leaving only the
  // complimentary 20 behind — none of it eligible for a second premium game.
  assert.equal(await getBalance(P), 20);
  const status = await getStatus(P);
  assert.equal(purchasedEligibleBalance(status), 0, "the purchased pool must be exhausted after spending it on premium");
});

// ---------------------------------------------------------------------------
// Insufficient paid entitlement prevents game creation and charging.
// ---------------------------------------------------------------------------

test("insufficient purchased balance refuses BEFORE any charge is written", async () => {
  seedPurchase(P, PREMIUM_ENGINE_PLAY_CREDIT_COST - 1);
  const before = structuredClone(ledger);
  const r = await consumeForPremiumEngine(P, randomUUID());
  assert.deepEqual(r, { ok: false, reason: "insufficient_balance" });
  assert.deepEqual(ledger, before, "a refused premium charge must write nothing");
});

// ---------------------------------------------------------------------------
// Developer/admin exemption: both tiers, zero internal deduction.
// ---------------------------------------------------------------------------

test("the developer/admin exemption allows premium with zero internal credit deduction, reusing hasUnlimitedPlay", async () => {
  exempt.add(DEV);
  assert.deepEqual(await canFundPremiumEngine(DEV), { ok: true, reason: "unlimited" });
  const r = await consumeForPremiumEngine(DEV, randomUUID());
  assert.deepEqual(r, { ok: true, reason: "unlimited" });
  assert.deepEqual(ledger, [], "an exempt premium game must write NOTHING to the ledger");
});

test("the exemption also covers the default engine unchanged (canStartGame/consumeForGame), same mechanism", async () => {
  exempt.add(DEV);
  assert.deepEqual(await canStartGame(DEV), { ok: true, reason: "unlimited" });
  assert.deepEqual(await consumeForGame(DEV, randomUUID(), 20), { ok: true, reason: "unlimited" });
  assert.deepEqual(ledger, []);
});

// ---------------------------------------------------------------------------
// Ordinary users cannot spoof the exemption.
// ---------------------------------------------------------------------------

test("an ordinary player cannot spoof the exemption: the check is keyed on the server-resolved player id alone", async () => {
  // No amount of ledger balance substitutes for the exemption, and there is
  // no parameter anywhere in these functions' signatures through which a
  // caller could name a different, exempt identity — both take only the
  // server-resolved playerId.
  seedPurchase(P, 10_000);
  exempt.clear(); // P is not, and never becomes, exempt no matter its balance
  const status = await getStatus(P);
  assert.ok(purchasedEligibleBalance(status) >= PREMIUM_ENGINE_PLAY_CREDIT_COST, "P can afford premium on its own merits");
  const r = await consumeForPremiumEngine(P, randomUUID());
  assert.equal(r.reason, "consumed", "P pays for it — it is not exempt");
  assert.equal(await getBalance(P), 10_000 - PREMIUM_ENGINE_PLAY_CREDIT_COST, "a real charge was written, proving no free exemption fired");
});

// ---------------------------------------------------------------------------
// Failed pre-game provider initialization does not charge.
// ---------------------------------------------------------------------------

test("a store outage refuses premium funding without writing anything, and never falls back to guest play", async () => {
  failNext = true;
  const eligibility = await canFundPremiumEngine(P);
  assert.deepEqual(eligibility, { ok: false, reason: "unavailable" });
  const r = await consumeForPremiumEngine(P, randomUUID());
  assert.deepEqual(r, { ok: false, reason: "unavailable" });
  assert.deepEqual(ledger, []);
});

test("premium never accepts a guest/none identity, unconditionally — no allowGuestFallback path exists", async () => {
  assert.deepEqual(await canFundPremiumEngine(null), { ok: false, reason: "no_player" });
  assert.deepEqual(await consumeForPremiumEngine(null, randomUUID()), { ok: false, reason: "no_player" });
  // Static guard: neither function's SIGNATURE accepts an options parameter
  // at all (unlike canStartGame/consumeForGame, which take
  // GameEntitlementOptions) — there is structurally nowhere for a caller to
  // even name allowGuestFallback, let alone have it honored. A bare-word
  // source scan is deliberately avoided: both functions' own doc comments
  // legitimately explain, in prose, why no such option exists.
  const src = readFileSync("lib/entitlements.ts", "utf8");
  assert.match(
    src,
    /export async function canFundPremiumEngine\(playerId: string \| null\): Promise<ConsumeOutcome> \{/
  );
  assert.match(
    src,
    /export async function consumeForPremiumEngine\(\s*playerId: string \| null,\s*operationalGameId: string\s*\): Promise<ConsumeOutcome> \{/
  );
});

// ---------------------------------------------------------------------------
// Duplicate requests cannot double-charge.
// ---------------------------------------------------------------------------

test("a retried premium creation collides with its own earlier charge — same idempotency guarantee as consumeForGame", async () => {
  seedPurchase(P, PREMIUM_ENGINE_PLAY_CREDIT_COST);
  const gameId = randomUUID();

  const first = await consumeForPremiumEngine(P, gameId);
  const second = await consumeForPremiumEngine(P, gameId);
  const third = await consumeForPremiumEngine(P, gameId);

  assert.equal(first.reason, "consumed");
  assert.equal(second.reason, "already_consumed");
  assert.equal(third.reason, "already_consumed");
  assert.equal(second.ok, true, "a replay is success — the premium game IS paid for");
  assert.equal(await getBalance(P), 0, "charged once, not three times");
  assert.equal(
    ledger.filter((r) => r.kind === "consumption" && r.operational_game_id === gameId).length,
    1
  );
});

test("the premium charge reuses the SAME unique index as consumeForGame — no schema change was made", () => {
  const migration = readFileSync("migrations/0004_accounts_entitlements.sql", "utf8");
  // Confirms no migration 0015+ was introduced for this feature and the
  // existing partial index still covers it.
  assert.match(migration, /entitlement_one_consumption_per_game/);
  const ent = readFileSync("lib/entitlements.ts", "utf8");
  const consume = ent.slice(ent.indexOf("export async function consumeForPremiumEngine"));
  assert.match(consume, /ON CONFLICT \(operational_game_id\) WHERE kind = 'consumption' DO NOTHING/);
  assert.match(consume, /pg_advisory_xact_lock\(4242, hashtext\(/, "same per-player serialisation as consumeForGame");
});

// ---------------------------------------------------------------------------
// Provider/model names remain hidden publicly, provenance persists internally.
// ---------------------------------------------------------------------------

test("SOURCE: neither engine's provider/model resolution ever appears in any player-facing string", () => {
  const route = readFileSync("app/api/game/create/route.ts", "utf8");
  const composer = readFileSync("app/ComposerEntry.tsx", "utf8");
  // Both real providers now matter: standard is xAI/Grok, premium is
  // OpenAI/GPT-6 Astra. "grok" itself is excluded from the ComposerEntry.tsx
  // scan (see the dedicated test below) since an existing, unrelated comment
  // legitimately uses "Grok" as an example TARGET a player might type.
  for (const forbidden of [/claude-opus/i, /\banthropic\b/i, /gpt-6/i, /\bopenai\b/i, /\bxai\b/i]) {
    // Player-facing message strings only — the route's own internal
    // provider-selection code legitimately mentions provider ids, so this
    // scan targets the JSON `message:` fields.
    const messages = [...route.matchAll(/message:\s*"([^"]*)"/g)].map((m) => m[1] ?? "");
    for (const msg of messages) assert.doesNotMatch(msg, forbidden);
    assert.doesNotMatch(composer, forbidden, `ComposerEntry.tsx must never name a provider/model (found ${forbidden})`);
  }
  // "grok" scanned separately: exactly ONE mention may exist, the known
  // pre-existing example TARGET word ("Grok, Apple, Tesla"), never a
  // reference to the standard engine's actual provider.
  const grokMentions = composer.match(/grok/gi) ?? [];
  assert.equal(grokMentions.length, 1, "exactly the one pre-existing example-target mention, nothing new");
  assert.match(composer, /one-word target \(Grok, Apple, Tesla\)/, "the single mention must be the known example, not a new one");
});

test("racerModelFor: premium resolves to the SAME already-proven GPT-6 Astra configuration the standard tier used before this feature, not a newly invented model", () => {
  const SAVED = process.env.OPENAI_MODEL_RACER;
  try {
    delete process.env.OPENAI_MODEL_RACER;
    assert.equal(racerModelFor("openai", "premium"), "gpt-6-astra");
    assert.equal(racerModelFor("openai", "premium"), racerModelFor("openai", "standard"), "premium must resolve identically to the pre-existing openai path");
    // Still centrally configurable, via the SAME pre-existing env var.
    process.env.OPENAI_MODEL_RACER = "gpt-6-astra-2026-08-01";
    assert.equal(racerModelFor("openai", "premium"), "gpt-6-astra-2026-08-01");
  } finally {
    if (SAVED === undefined) delete process.env.OPENAI_MODEL_RACER;
    else process.env.OPENAI_MODEL_RACER = SAVED;
  }
});

test("racerModelFor: \"standard\" (the default, omitted tier) is byte-identical to pre-V2.8.8.7 behaviour for every provider", () => {
  assert.equal(racerModelFor("anthropic"), racerModelFor("anthropic", "standard"));
  assert.equal(racerModelFor("openai"), racerModelFor("openai", "standard"));
  assert.equal(racerModelFor("xai"), racerModelFor("xai", "standard"));
});

test("SOURCE: racerModelFor resolves premium via the openai branch, never a plain-anthropic Racer model", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  const fn = src.slice(src.indexOf("export function racerModelFor"));
  assert.match(fn, /if \(tier === "premium"\) return env\.openaiModelRacer\(\);/);
  assert.doesNotMatch(fn, /premiumRacerModel/, "the invented ANTHROPIC_MODEL_RACER_PREMIUM path must be gone entirely");
});

// ---------------------------------------------------------------------------
// V2.8.8.7 CORRECTION — routing verification.
// ---------------------------------------------------------------------------

test("SOURCE: the standard tier routes to the established xAI/Grok Racer configuration", () => {
  const create = readFileSync("app/api/game/create/route.ts", "utf8");
  assert.match(create, /const PUBLIC_RACER_PROVIDER: ModelProviderId = "xai";/);
  // The pre-existing, unchanged env var and default model id — nothing new.
  const env = readFileSync("lib/env.ts", "utf8");
  assert.match(env, /xaiModelRacer: \(\) => process\.env\.XAI_MODEL_RACER \|\| "grok-4\.6",/);
});

test("SOURCE: the premium tier routes to the established OpenAI/GPT-6 Astra Racer configuration", () => {
  const tier = readFileSync("lib/racerEngineTier.ts", "utf8");
  assert.match(tier, /export const PREMIUM_RACER_PROVIDER: ModelProviderId = "openai";/);
  const env = readFileSync("lib/env.ts", "utf8");
  assert.match(env, /openaiModelRacer: \(\) => process\.env\.OPENAI_MODEL_RACER \|\| "gpt-6-astra",/);
  // No new env var was introduced for this feature.
  assert.doesNotMatch(env, /ANTHROPIC_MODEL_RACER_PREMIUM/);
  assert.doesNotMatch(env, /premiumRacerModel/);
});

test("SOURCE: Fable/Claude's adjudication and Integrity Review configuration is untouched and separate from either Racer tier", () => {
  const env = readFileSync("lib/env.ts", "utf8");
  assert.match(env, /modelAdjudication: \(\) => process\.env\.ANTHROPIC_MODEL_ADJUDICATION \|\| "claude-fable-5-1",/);
  // Neither Racer tier's resolution mentions the adjudication model or effort knobs.
  const racer = readFileSync("lib/prompts/racer.ts", "utf8");
  const fn = racer.slice(racer.indexOf("export function racerModelFor"), racer.indexOf("export async function runRacerTurn"));
  assert.doesNotMatch(fn, /modelAdjudication|effortAdjudication/);
});

// ---------------------------------------------------------------------------
// Ledger auditability independent of gameplay.
// ---------------------------------------------------------------------------

test("the premium ledger entry remains fully auditable even if the game is abandoned before any Racer turn", async () => {
  seedPurchase(P, PREMIUM_ENGINE_PLAY_CREDIT_COST);
  const gameId = randomUUID();
  const result = await consumeForPremiumEngine(P, gameId);
  assert.deepEqual(result, { ok: true, reason: "consumed" });

  // The charge is written at CREATION time, before any turn could possibly
  // occur — nothing about this row depends on gameplay happening at all.
  const row = ledger.find((r) => r.kind === "consumption" && r.operational_game_id === gameId);
  assert.ok(row, "the premium consumption row must exist independent of any turn");
  assert.deepEqual(row, {
    player_id: P,
    kind: "consumption",
    amount: -PREMIUM_ENGINE_PLAY_CREDIT_COST,
    operational_game_id: gameId,
    note: "premium_engine_start",
  });
  // The note IS the durable engine-tier marker: a query for
  // kind='consumption' AND note='premium_engine_start' answers "which games
  // were played on the premium engine" without any additional column.
});

// ---------------------------------------------------------------------------
// Static structure guards.
// ---------------------------------------------------------------------------

test("SOURCE: engine tier is a stable internal id, not a public label or model name", () => {
  const src = readFileSync("lib/racerEngineTier.ts", "utf8");
  assert.match(src, /export type RacerEngineTier = "standard" \| "premium";/);
  // The two exported string literals are the only values a request body or
  // response can ever carry — the module's own doc comment naming the
  // Hungarian label is documentation, not something exposed at a boundary.
  assert.doesNotMatch(src, /export const \w+.*Emberi szintű AI/, "the public label must never be an exported VALUE");
});
