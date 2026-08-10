import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getKV, namespacedKey } from "../lib/kv";

/**
 * V2.1.1.1 — KV namespace isolation.
 *
 * V1 and V2 share one Upstash database. Two of the four key families are
 * COUNTERS, and one of them is the daily AI spend ceiling that fails closed —
 * so without a namespace V2 traffic could lock V1 out of starting games.
 *
 * These tests drive the real stores against the in-memory backend and inspect
 * the keys that actually land, rather than asserting on the key builders.
 */

type Entry = { value: unknown; expiresAt: number | null };
const devStore = globalThis as unknown as { __barkobaDevKV?: Map<string, Entry> };

function keysWritten(): string[] {
  return [...(devStore.__barkobaDevKV?.keys() ?? [])].sort();
}

function reset() {
  // Clear IN PLACE. InMemoryKV captures the Map in a field initializer and
  // getKV() memoizes the client, so replacing the Map would leave writes going
  // to the old one while assertions read the new one.
  (devStore.__barkobaDevKV ??= new Map<string, Entry>()).clear();
}

/** Exercise every key family through its real module. */
async function writeAllFamilies(suffix: string) {
  const { createGame } = await import("../lib/gameStore");
  const { checkGameCreationRateLimit } = await import("../lib/rateLimit");
  const { consumeModelCall } = await import("../lib/callBudget");

  await createGame(`game-${suffix}`);
  // The secret family is written through getKV like every other key, but the
  // isolation invariant forbids a test importing secretStore — correctly, and
  // widening that allowlist for test convenience would weaken the one guarantee
  // the whole architecture rests on. The key shape is pinned separately below.
  await getKV().set(`secret:game-${suffix}`, { probe: true }, 60);
  await checkGameCreationRateLimit(`10.0.0.${suffix.length}`);
  await consumeModelCall("racer");
  await consumeModelCall("resolve");
}

const FAMILIES = ["state:", "secret:", "ratelimit:create:", "budget:racercalls:", "budget:resolvecalls:"];

test("an unset namespace reproduces V1 key shapes exactly", () => {
  delete process.env.KV_NAMESPACE;
  assert.equal(namespacedKey("state:abc"), "state:abc");
  assert.equal(namespacedKey("budget:racercalls:2026-08-10"), "budget:racercalls:2026-08-10");
});

test("an empty-string namespace is also a no-op", () => {
  process.env.KV_NAMESPACE = "";
  assert.equal(namespacedKey("state:abc"), "state:abc");
  delete process.env.KV_NAMESPACE;
});

test("a configured namespace prefixes the key", () => {
  process.env.KV_NAMESPACE = "v2:";
  assert.equal(namespacedKey("state:abc"), "v2:state:abc");
  delete process.env.KV_NAMESPACE;
});

test("the namespace is read per call, not frozen when the client is cached", async () => {
  // getKV() memoizes. A prefix captured at construction would silently ignore
  // configuration for the life of the process.
  delete process.env.KV_NAMESPACE;
  reset();
  const kv = getKV();
  await kv.set("probe", 1);
  process.env.KV_NAMESPACE = "v2:";
  await kv.set("probe", 2);
  delete process.env.KV_NAMESPACE;

  assert.deepEqual(keysWritten(), ["probe", "v2:probe"], "same cached client, both namespaces");
});

test("with no namespace, every key family keeps its legacy V1 shape", async () => {
  delete process.env.KV_NAMESPACE;
  reset();
  await writeAllFamilies("legacy");

  const keys = keysWritten();
  for (const family of FAMILIES) {
    assert.ok(
      keys.some((k) => k.startsWith(family)),
      `missing legacy family ${family} — got ${keys.join(", ")}`,
    );
  }
  assert.ok(!keys.some((k) => k.startsWith("v2:")), "nothing should be namespaced");
});

test("with a namespace, every key family is prefixed", async () => {
  process.env.KV_NAMESPACE = "v2:";
  reset();
  await writeAllFamilies("v2");

  const keys = keysWritten();
  for (const family of FAMILIES) {
    assert.ok(
      keys.some((k) => k === `v2:${family}` || k.startsWith(`v2:${family}`)),
      `family ${family} not namespaced — got ${keys.join(", ")}`,
    );
  }
  assert.ok(
    keys.every((k) => k.startsWith("v2:")),
    `an un-namespaced key escaped: ${keys.filter((k) => !k.startsWith("v2:")).join(", ")}`,
  );
  delete process.env.KV_NAMESPACE;
});

test("the two lanes cannot see each other's keys", async () => {
  reset();
  delete process.env.KV_NAMESPACE;
  await writeAllFamilies("lane1");
  const v1Keys = keysWritten();

  process.env.KV_NAMESPACE = "v2:";
  await writeAllFamilies("lane2");
  delete process.env.KV_NAMESPACE;

  const all = keysWritten();
  const v2Keys = all.filter((k) => k.startsWith("v2:"));

  assert.equal(v2Keys.length, v1Keys.length, "both lanes wrote the same families");
  for (const k of v1Keys) {
    assert.ok(!k.startsWith("v2:"), "V1 keys must stay unprefixed");
    assert.ok(all.includes(k), "V2 activity must not overwrite a V1 key");
  }
});

test("the daily AI spend ceilings are separated — the reason this exists", async () => {
  reset();
  const { consumeModelCall } = await import("../lib/callBudget");

  delete process.env.KV_NAMESPACE;
  await consumeModelCall("racer");
  const v1Counter = keysWritten().find((k) => k.startsWith("budget:racercalls:"));
  assert.ok(v1Counter, "V1 counter missing");
  const v1Before = devStore.__barkobaDevKV?.get(v1Counter)?.value;

  // Spend hard in the V2 lane.
  process.env.KV_NAMESPACE = "v2:";
  for (let i = 0; i < 25; i += 1) await consumeModelCall("racer");
  delete process.env.KV_NAMESPACE;

  const v1After = devStore.__barkobaDevKV?.get(v1Counter)?.value;
  assert.equal(v1After, v1Before, "V2 spending must not move V1's ceiling counter");
  assert.equal(devStore.__barkobaDevKV?.get(`v2:${v1Counter}`)?.value, 25);
});

test("no key builder was changed — the wrapper is the only change", () => {
  assert.match(readFileSync("lib/gameStore.ts", "utf8"), /return `state:\$\{gameId\}`;/);
  assert.match(readFileSync("lib/secretStore.ts", "utf8"), /return `secret:\$\{gameId\}`;/);
  assert.match(readFileSync("lib/rateLimit.ts", "utf8"), /`ratelimit:create:\$\{ip\}:\$\{hourBucket\}`/);
  assert.match(readFileSync("lib/callBudget.ts", "utf8"), /return `budget:\$\{kind\}calls:\$\{day\}`;/);
});

test("both KV backends are namespaced, so dev and production agree", () => {
  const src = readFileSync("lib/kv.ts", "utf8");
  assert.match(src, /new NamespacedKV\(new UpstashKV\(url, token\)\)/);
  assert.match(src, /new NamespacedKV\(new InMemoryKV\(\)\)/);
});
