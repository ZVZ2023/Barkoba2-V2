import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";

import {
  RECOVERY_CODE_ENTROPY_BITS,
  generateRecoveryCode,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  recoveryKey,
} from "../lib/recoveryCode";
import {
  claimPlayer,
  deleteDurablePlayer,
  getDurablePlayer,
  recoverPlayer,
} from "../lib/playerStore";
import { mintPlayerId } from "../lib/playerIdentity";
import { getKV } from "../lib/kv";

/** V2.1.3.0 — claim, recover, delete. */

test("the code contains exactly the entropy it claims", () => {
  const code = generateRecoveryCode();
  const body = normalizeRecoveryCode(code);
  assert.equal(body.length, 24, code);
  // 24 Crockford characters x 5 bits = 120 bits, and 15 random bytes = 120 bits.
  assert.equal(body.length * 5, RECOVERY_CODE_ENTROPY_BITS);
  assert.equal(RECOVERY_CODE_ENTROPY_BITS, 120);
  assert.match(code, /^BARKOBA(-[0-9A-Z]{4}){6}$/);
});

test("codes do not repeat", () => {
  const seen = new Set(Array.from({ length: 200 }, () => generateRecoveryCode()));
  assert.equal(seen.size, 200);
});

test("the alphabet excludes every ambiguous character", () => {
  const body = Array.from({ length: 100 }, () => normalizeRecoveryCode(generateRecoveryCode())).join("");
  for (const ch of ["I", "L", "O", "U"]) {
    assert.ok(!body.includes(ch), `generated an ambiguous ${ch}`);
  }
});

test("reasonable retyping still resolves to the same key", async () => {
  // People retype these from paper: lowercase, no dashes, extra spaces, and
  // O/0 confusion. Rejecting a legitimate code is the worst possible failure
  // for a credential that cannot be reissued.
  const code = generateRecoveryCode();
  const canonical = await recoveryKey(code);
  const variants = [
    code.toLowerCase(),
    code.replace(/-/g, ""),
    `  ${code}  `,
    code.replace(/-/g, " "),
    code.replace(/0/g, "O").replace(/1/g, "I"),
  ];
  for (const v of variants) {
    assert.equal(await recoveryKey(v), canonical, `variant failed: ${v}`);
  }
});

test("a wrong-shaped code is rejected before touching storage", () => {
  assert.equal(looksLikeRecoveryCode(""), false);
  assert.equal(looksLikeRecoveryCode("BARKOBA-1234"), false);
  assert.equal(looksLikeRecoveryCode(generateRecoveryCode()), true);
});

test("claiming attaches to the existing player and mints no new one", async () => {
  const id = mintPlayerId();
  const code = generateRecoveryCode();
  const record = await claimPlayer(id, "Zsolt", code);
  assert.ok(record);
  assert.equal(record.player_id, id, "claiming must not create a different Player");
  assert.equal(record.display_name, "Zsolt");
  assert.ok(record.recovery_key.length === 64, "recovery_key is a sha256 hex pointer");
});

test("recovery returns the same player and the durable name", async () => {
  const id = mintPlayerId();
  const code = generateRecoveryCode();
  await claimPlayer(id, "Áron", code);
  const recovered = await recoverPlayer(code);
  assert.equal(recovered?.player_id, id);
  assert.equal(recovered?.display_name, "Áron");
});

test("a wrong code recovers nothing", async () => {
  await claimPlayer(mintPlayerId(), null, generateRecoveryCode());
  assert.equal(await recoverPlayer(generateRecoveryCode()), null);
});

test("re-claiming is refused rather than rotating the code", async () => {
  const id = mintPlayerId();
  const first = generateRecoveryCode();
  await claimPlayer(id, null, first);
  assert.equal(await claimPlayer(id, null, generateRecoveryCode()), null);
  // The original code must still work — silently invalidating one the player
  // wrote down is the fastest way to destroy trust in recovery.
  assert.equal((await recoverPlayer(first))?.player_id, id);
});

test("deletion removes both records, directly and with no scan", async () => {
  const id = mintPlayerId();
  const code = generateRecoveryCode();
  const record = await claimPlayer(id, "Zsolt", code);
  assert.ok(record);

  assert.equal(await deleteDurablePlayer(id), true);
  assert.equal(await getDurablePlayer(id), null, "player record survived");
  assert.equal(await recoverPlayer(code), null, "the code still resolves after deletion");
  assert.equal(await getKV().get(`recovery:${record.recovery_key}`), null, "recovery record survived");
  assert.equal(await deleteDurablePlayer(id), false, "second delete should be a no-op");
});

test("the KV layer can delete, and only that", async () => {
  const kv = getKV();
  await kv.set("probe:del", { a: 1 });
  assert.deepEqual(await kv.get("probe:del"), { a: 1 });
  await kv.del("probe:del");
  assert.equal(await kv.get("probe:del"), null);
});

test("durable identity lives behind one module", () => {
  // playerStore is the only place that may touch these key families, so moving
  // identity to a real database later stays a one-file change.
  for (const path of [
    "app/api/player/claim/route.ts",
    "app/api/player/recover/route.ts",
  ]) {
    const src = readFileSync(path, "utf8");
    assert.ok(!src.includes("getKV"), `${path} reaches storage directly`);
  }
  assert.match(readFileSync("lib/playerStore.ts", "utf8"), /player:\$\{playerId\}/);
});

test("recovery is rate limited, and the raw code is never stored", () => {
  assert.match(
    readFileSync("app/api/player/recover/route.ts", "utf8"),
    /checkRecoveryRateLimit/,
  );
  const store = readFileSync("lib/playerStore.ts", "utf8");
  assert.ok(!store.includes("raw_code") && !store.includes("code:"), "raw code must never be stored");
  assert.match(store, /recoveryKey\(rawCode\)/);
});

test("recovery validity does not depend on PLAYER_ID_SECRET", () => {
  // The hash is unkeyed on purpose: rotating the cookie secret must not orphan
  // every recovery code in the wild.
  // Assert on CODE, not prose: the header comment names PLAYER_ID_SECRET while
  // explaining why it is deliberately absent.
  const code = readFileSync("lib/recoveryCode.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  assert.ok(!code.includes("PLAYER_ID_SECRET"), "no server secret may gate recovery");
  assert.ok(!code.includes("HMAC"), "must be a plain digest, not a keyed one");
  assert.match(code, /crypto\.subtle\.digest\("SHA-256"/);
});

test("the privacy page discloses durable identity and deletion", () => {
  const src = readFileSync("app/privacy/page.tsx", "utf8");
  assert.match(src, /helyreállító kód/);
  assert.match(src, /törl/, "deletion must be disclosed");
});
