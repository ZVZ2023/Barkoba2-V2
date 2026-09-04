import { test } from "node:test";
import assert from "node:assert/strict";
import { __setSqlClientForTests, type SqlClient } from "../lib/corpus/db";
import { generateAccountSessionToken, accountSessionHash } from "../lib/accountSession";
import {
  resolveActingPlayer,
  resolveActingPlayerId,
  resolveActingPlayerIdentity,
} from "../lib/actingPlayer";
import { enableTestIdentityLookups, testPlayerId, playerHeader } from "./helpers/testIdentity";

// ---------------------------------------------------------------------------
// V2.8.6 R1 COMMIT 3 — the typed identity-failure taxonomy.
//
// resolveActingPlayerIdentity is a NEW, additive export: resolveActingPlayer
// and resolveActingPlayerId keep their exact pre-existing behavior (asserted
// below), and this file's own job is to prove the new function distinguishes
// exactly the three outcomes /turn, /correct, /ask, /clue, /view and
// page.tsx now need — "identified" (reaches the seat check), "absent" (401),
// and "backend_unavailable" (503) — which a plain `string | null` could
// never express.
// ---------------------------------------------------------------------------

function headersWith(entries: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(entries)) h.set(k, v);
  return h;
}

// --- absent -----------------------------------------------------------------

test("absent: no identity presented at all resolves to {kind: absent}, distinct from backend_unavailable", async () => {
  enableTestIdentityLookups(); // a WORKING backend, so this is genuinely "nobody asked", not an outage
  const result = await resolveActingPlayerIdentity(headersWith({}));
  assert.deepEqual(result, { kind: "absent" });
});

test("absent: a malformed x-bk-player header (wrong shape) is treated the same as no header", async () => {
  enableTestIdentityLookups();
  const result = await resolveActingPlayerIdentity(headersWith({ "x-bk-player": "not-a-valid-id" }));
  assert.deepEqual(result, { kind: "absent" });
});

// --- identified: guest ------------------------------------------------------

test("identified: an ordinary guest header with a healthy identity backend reaches the seat check", async () => {
  enableTestIdentityLookups();
  const guestId = testPlayerId("d");
  const result = await resolveActingPlayerIdentity(headersWith(playerHeader(guestId)));
  assert.deepEqual(result, { kind: "identified", playerId: guestId });
});

// --- identified: registered (logged-in) account -----------------------------

test("identified: a valid account session reaches the seat check, as the ACCOUNT's playerId (not any guest header present alongside it)", async () => {
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  const accountPlayerId = testPlayerId("e");
  const token = generateAccountSessionToken();
  const expectedHash = await accountSessionHash(token);

  const sqlWithSession: SqlClient = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("accounts.player_sessions")) {
        // The route's own query binds session_hash as its first value.
        return values[0] === expectedHash ? [{ player_id: accountPlayerId }] : [];
      }
      return [];
    },
    { transaction: async (qs: Promise<Record<string, unknown>[]>[]) => Promise.all(qs) }
  );
  __setSqlClientForTests(sqlWithSession);

  try {
    const result = await resolveActingPlayerIdentity(
      headersWith({
        cookie: `bk_account_session=${token}`,
        // A guest header is ALSO present, deliberately -- the account
        // session must win, exactly as resolveActingPlayer already
        // documents ("a valid server-side account session always wins").
        "x-bk-player": testPlayerId("f"),
      })
    );
    assert.deepEqual(result, { kind: "identified", playerId: accountPlayerId });
  } finally {
    __setSqlClientForTests(null);
    delete process.env.DATABASE_URL;
    delete process.env.CORPUS_ENABLED;
  }
});

// --- backend_unavailable -----------------------------------------------------

test("backend_unavailable: a guest header whose account-lookup query throws is distinguished from an absent identity", async () => {
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  const throwingSql: SqlClient = Object.assign(
    async () => {
      throw new Error("simulated identity-store outage");
    },
    { transaction: async () => Promise.reject(new Error("simulated identity-store outage")) }
  );
  __setSqlClientForTests(throwingSql);

  try {
    const result = await resolveActingPlayerIdentity(headersWith(playerHeader(testPlayerId("a"))));
    assert.deepEqual(result, { kind: "backend_unavailable" });
  } finally {
    __setSqlClientForTests(null);
    delete process.env.DATABASE_URL;
    delete process.env.CORPUS_ENABLED;
  }
});

test("backend_unavailable is never reachable with no identity backend even attempted: an absent identity never touches the DB", async () => {
  // No enableTestIdentityLookups(), no DATABASE_URL at all -- proves the
  // "absent" case above is genuine (short-circuits before any DB call),
  // not accidentally passing because the backend happened to be reachable.
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  __setSqlClientForTests(null);
  const result = await resolveActingPlayerIdentity(headersWith({}));
  assert.deepEqual(result, { kind: "absent" });
});

// ---------------------------------------------------------------------------
// resolveActingPlayer / resolveActingPlayerId — UNCHANGED behavior. A
// backend failure still collapses to the pre-existing {kind:"none"}/null for
// every one of these functions' many OTHER callers (account routes,
// /resolve, /contest, /hh/turn, /join, player routes, and more) — Commit 3
// must not silently change what any of them see.
// ---------------------------------------------------------------------------

test("REGRESSION: resolveActingPlayer still collapses a backend failure to {kind: none, playerId: null}", async () => {
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  const throwingSql: SqlClient = Object.assign(
    async () => {
      throw new Error("simulated identity-store outage");
    },
    { transaction: async () => Promise.reject(new Error("simulated identity-store outage")) }
  );
  __setSqlClientForTests(throwingSql);

  try {
    const context = await resolveActingPlayer(headersWith(playerHeader(testPlayerId("a"))));
    assert.deepEqual(context, { kind: "none", playerId: null });
    const id = await resolveActingPlayerId(headersWith(playerHeader(testPlayerId("a"))));
    assert.equal(id, null);
  } finally {
    __setSqlClientForTests(null);
    delete process.env.DATABASE_URL;
    delete process.env.CORPUS_ENABLED;
  }
});

test("REGRESSION: resolveActingPlayerId still resolves an ordinary guest with a healthy backend", async () => {
  enableTestIdentityLookups();
  const guestId = testPlayerId("d");
  const id = await resolveActingPlayerId(headersWith(playerHeader(guestId)));
  assert.equal(id, guestId);
});
