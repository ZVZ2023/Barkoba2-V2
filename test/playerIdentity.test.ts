import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PLAYER_COOKIE,
  PLAYER_HEADER,
  identityConfigured,
  issuePlayerCookie,
  mintPlayerId,
  playerIdFromHeaders,
  verifyPlayerCookie,
} from "../lib/playerIdentity";

// The secret is read lazily inside each call, never at module load, so setting
// it here — after imports hoist, before any test runs — is enough.
process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";

/** V2.1.1 — signed, client-held, server-verifiable, no durable record. */

test("a minted id is opaque and 128 bits", () => {
  const a = mintPlayerId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, mintPlayerId(), "two visitors must not collide");
});

test("a cookie we issued verifies back to the same player", async () => {
  const { playerId, value } = await issuePlayerCookie();
  assert.equal(await verifyPlayerCookie(value), playerId);
});

test("the same client keeps the same identity across visits", async () => {
  const first = await issuePlayerCookie();
  // A later request presents the cookie it was given.
  assert.equal(await verifyPlayerCookie(first.value), first.playerId);
  assert.equal(await verifyPlayerCookie(first.value), first.playerId);
});

test("a fresh client gets a different identity", async () => {
  const a = await issuePlayerCookie();
  const b = await issuePlayerCookie();
  assert.notEqual(a.playerId, b.playerId);
});

test("a forged id is rejected — this is the whole point of signing", async () => {
  const forged = `${mintPlayerId()}.notarealsignature`;
  assert.equal(await verifyPlayerCookie(forged), null);
});

test("a tampered id does not survive its own signature", async () => {
  const { playerId, value } = await issuePlayerCookie();
  const sig = value.slice(value.lastIndexOf(".") + 1);
  const other = mintPlayerId();
  assert.notEqual(other, playerId);
  assert.equal(await verifyPlayerCookie(`${other}.${sig}`), null);
});

test("malformed cookies are refused rather than trusted", async () => {
  for (const bad of ["", "  ", "nodot", ".", ".sig", "abc.def", `${mintPlayerId()}.`]) {
    assert.equal(await verifyPlayerCookie(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(await verifyPlayerCookie(undefined), null);
});

test("a cookie signed with another key is refused", async () => {
  const { value } = await issuePlayerCookie();
  const original = process.env.PLAYER_ID_SECRET;
  process.env.PLAYER_ID_SECRET = "a-different-deployment-secret";
  try {
    assert.equal(await verifyPlayerCookie(value), null, "V1 and V2 identities must not cross");
  } finally {
    process.env.PLAYER_ID_SECRET = original;
  }
});

test("no secret means identity is disabled, never unsigned", async () => {
  const original = process.env.PLAYER_ID_SECRET;
  delete process.env.PLAYER_ID_SECRET;
  try {
    assert.equal(identityConfigured(), false);
    assert.equal(await verifyPlayerCookie("anything.atall"), null);
  } finally {
    process.env.PLAYER_ID_SECRET = original;
  }
});

test("only a well-formed id is accepted off the trusted header", () => {
  const id = mintPlayerId();
  assert.equal(playerIdFromHeaders(new Headers({ [PLAYER_HEADER]: id })), id);
  assert.equal(playerIdFromHeaders(new Headers({ [PLAYER_HEADER]: "../../etc" })), null);
  assert.equal(playerIdFromHeaders(new Headers()), null);
});

test("middleware strips any client-supplied trusted header", () => {
  const src = readFileSync("middleware.ts", "utf8");
  const stripAt = src.indexOf("headers.delete(PLAYER_HEADER)");
  assert.ok(stripAt > 0, "inbound header must be deleted");
  // It must be deleted before any early return, or an unconfigured deployment
  // would forward a header the client wrote.
  assert.ok(stripAt < src.indexOf("identityConfigured()"), "strip must precede every return");
});

test("middleware does not run over the statically rendered pages", () => {
  const src = readFileSync("middleware.ts", "utf8");
  const matcher = src.slice(src.indexOf("matcher"), src.indexOf("]", src.indexOf("matcher")));
  for (const stat of ["/about", "/contact", "/privacy", "/rules"]) {
    assert.ok(!matcher.includes(`"${stat}"`), `${stat} is static and must stay static`);
  }
  assert.ok(matcher.includes('"/api/game/:path*"'), "game APIs need the acting player");
});

test("identity never becomes a durable record", () => {
  const src = readFileSync("lib/playerIdentity.ts", "utf8");
  for (const forbidden of ["gameStore", "secretStore", "getKV", "./kv"]) {
    assert.ok(!src.includes(forbidden), `identity must not reach ${forbidden}`);
  }
  assert.equal(src.includes("PLAYER_COOKIE"), true);
});

test("the acting player is recorded in existing game state, not a new store", () => {
  const types = readFileSync("lib/types.ts", "utf8");
  assert.match(types, /player_id: string \| null;/);
  assert.ok(!types.includes("interface PlayerRecord"), "no player entity in V2.1.1");

  const create = readFileSync("app/api/game/create/route.ts", "utf8");
  assert.match(create, /playerIdFromHeaders\(req\.headers\)/);
  assert.equal((create.match(/player_id: playerId,/g) || []).length, 2, "both game modes");
});

test("a game with no identity still reads and still plays", () => {
  const store = readFileSync("lib/gameStore.ts", "utf8");
  assert.match(store, /if \(record\.player_id === undefined\) record\.player_id = null;/);
  assert.match(store, /player_id: null,/);
});

test("the cookie is not readable or writable from client script", () => {
  const src = readFileSync("lib/playerIdentity.ts", "utf8");
  assert.match(src, /httpOnly: true/);
  assert.match(src, /sameSite: "lax" as const/);
  assert.equal(PLAYER_COOKIE, "bk_player");
});
