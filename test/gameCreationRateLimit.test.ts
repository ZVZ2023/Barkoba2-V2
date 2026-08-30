import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkGameCreationRateLimit } from "../lib/rateLimit";

// ---------------------------------------------------------------------------
// V2.7.0.16 — checkGameCreationRateLimit() was keyed on IP alone.
//
// PRODUCTION PROOF: two different phones on the same household Wi-Fi (one
// shared public IP) hit the SAME bucket — one device's play blocked the
// other's entirely. Switching the first phone to cellular (a different
// public IP) immediately unblocked it, confirming the key was purely
// IP-scoped. A shared/NAT'd public IP is common (home Wi-Fi, mobile carrier
// CGNAT, an office), not an edge case.
//
// These tests drive the real function against the real in-memory KV
// fallback (no Upstash configured in this test run), exactly the code path
// production runs, not a mock of it.
// ---------------------------------------------------------------------------

type Entry = { value: unknown; expiresAt: number | null };
const devStore = globalThis as unknown as { __barkobaDevKV?: Map<string, Entry> };

const SAVED = {
  disabled: process.env.RATE_LIMIT_DISABLED,
  limit: process.env.RATE_LIMIT_GAMES_PER_HOUR,
};

beforeEach(() => {
  delete process.env.RATE_LIMIT_DISABLED;
  process.env.RATE_LIMIT_GAMES_PER_HOUR = "5";
  (devStore.__barkobaDevKV ??= new Map<string, Entry>()).clear();
});

afterEach(() => {
  if (SAVED.disabled === undefined) delete process.env.RATE_LIMIT_DISABLED;
  else process.env.RATE_LIMIT_DISABLED = SAVED.disabled;
  if (SAVED.limit === undefined) delete process.env.RATE_LIMIT_GAMES_PER_HOUR;
  else process.env.RATE_LIMIT_GAMES_PER_HOUR = SAVED.limit;
});

test("A. two distinct devices behind the same shared IP do not block each other", async () => {
  const ip = "203.0.113.7"; // one household's public IP
  const deviceA = "a".repeat(32);
  const deviceB = "b".repeat(32);

  // Device A alone exhausts its own allowance.
  for (let i = 0; i < 5; i++) {
    const r = await checkGameCreationRateLimit(ip, deviceA);
    assert.equal(r.allowed, true, `device A's own request ${i + 1} must be allowed`);
  }
  const sixthForA = await checkGameCreationRateLimit(ip, deviceA);
  assert.equal(sixthForA.allowed, false, "device A's own 6th request in the hour must be refused");

  // Device B, same IP, completely unaffected — a fresh bucket of its own.
  const firstForB = await checkGameCreationRateLimit(ip, deviceB);
  assert.equal(
    firstForB.allowed,
    true,
    "a DIFFERENT device on the same IP must not inherit the first device's exhausted bucket"
  );
  assert.equal(firstForB.remaining, 4);
});

test("a single device is still capped at RATE_LIMIT_GAMES_PER_HOUR — abuse protection is preserved, not weakened", async () => {
  const ip = "198.51.100.20";
  const device = "c".repeat(32);

  for (let i = 0; i < 5; i++) {
    assert.equal((await checkGameCreationRateLimit(ip, device)).allowed, true);
  }
  const sixth = await checkGameCreationRateLimit(ip, device);
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.remaining, 0);
});

test("the same device on a DIFFERENT IP still shares nothing with its own prior bucket (device identity is not the sole key either)", async () => {
  // Both IP and device identity are folded into the key together — this is
  // not "switch to device-only limiting", it stays a genuine (ip, device)
  // pair, so a device that also rotates IPs does not get a free unlimited
  // reset purely by changing networks while KEEPING the same identity.
  const device = "d".repeat(32);
  for (let i = 0; i < 5; i++) {
    assert.equal((await checkGameCreationRateLimit("192.0.2.1", device)).allowed, true);
  }
  assert.equal((await checkGameCreationRateLimit("192.0.2.1", device)).allowed, false);

  // A genuinely different IP for the SAME device is its own bucket — this
  // is the same "switching to cellular unblocked it" behavior the human
  // test already relied on, now explicit rather than an accident of pure
  // IP-keying.
  const onNewIp = await checkGameCreationRateLimit("192.0.2.99", device);
  assert.equal(onNewIp.allowed, true);
});

test("an identity-less caller degrades to a real per-IP limit rather than throwing", async () => {
  const ip = "203.0.113.55";
  for (let i = 0; i < 5; i++) {
    assert.equal((await checkGameCreationRateLimit(ip)).allowed, true);
  }
  assert.equal((await checkGameCreationRateLimit(ip)).allowed, false);
  assert.equal((await checkGameCreationRateLimit(ip, null)).allowed, false, "null must behave the same as omitted");
});

test("RATE_LIMIT_DISABLED still bypasses the limiter entirely, key shape notwithstanding", async () => {
  process.env.RATE_LIMIT_DISABLED = "true";
  const ip = "203.0.113.9";
  const device = "e".repeat(32);
  for (let i = 0; i < 10; i++) {
    const r = await checkGameCreationRateLimit(ip, device);
    assert.equal(r.allowed, true);
  }
});

test("the key family stays a stable prefix, still visible to KV namespace isolation", async () => {
  const keys = () => [...(devStore.__barkobaDevKV?.keys() ?? [])];
  await checkGameCreationRateLimit("203.0.113.200", "f".repeat(32));
  assert.ok(
    keys().some((k) => k.startsWith("ratelimit:create:")),
    "the ratelimit:create: family prefix must be unchanged so KV namespacing keeps applying to it"
  );
});
