import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import {
  accountSessionHash,
  createAccountSession,
  resolveAccountSession,
  revokeAccountSession,
} from "../lib/accountSession";
import { resolveActingPlayer, resolveActingPlayerId } from "../lib/actingPlayer";
import { getBalance } from "../lib/entitlements";
import { issuePlayerCookie, PLAYER_HEADER } from "../lib/playerIdentity";
import {
  getPlayerAccount,
  getPlayerAccountByRecoveryKey,
  migrateLegacyPlayer,
  registerPlayerAccount,
} from "../lib/playerAccounts";
import { claimPlayer, type DurablePlayer } from "../lib/playerStore";
import { POST as createPurchaseIntent } from "../app/api/entitlement/intent/route";
import { __resetDicsCatalogCacheForTests } from "../lib/dicsCatalog";
import { GET as readEntitlement } from "../app/api/player/entitlement/route";
import { GET as readAccountDiagnostic } from "../app/api/account/diagnostic/route";
import { POST as resetIdentity } from "../app/api/account/reset-identity/route";
import { POST as rotateRecoveryCode } from "../app/api/account/rotate-recovery-code/route";
import { recoveryKey } from "../lib/recoveryCode";

process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";

interface AccountRow {
  player_id: string;
  recovery_key: string;
  display_name: string | null;
  created_at: string;
  registered_at: string;
  disabled_at: null;
  // V2.7 — added only so the purchase-intent test below can represent a
  // verified account; every other test in this file is unaffected by the
  // default. This fake predates email verification and has no INSERT/UPDATE
  // path for it, matching how it never modeled email at all — set directly
  // on the Map where a test needs a verified row.
  email_verified_at: string | null;
}

interface SessionRow {
  player_id: string;
  expires_at: string;
  revoked_at: string | null;
}

interface LedgerRow {
  player_id: string;
  amount: number;
  grant_key: string;
}

let accounts: Map<string, AccountRow>;
let sessions: Map<string, SessionRow>;
let ledger: LedgerRow[];
let unlimited: Set<string>;

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const query = strings.join(" ");
  const v = values as unknown[];

  if (/INSERT INTO accounts\.players/.test(query)) {
    const playerId = String(v[0]);
    const recovery = String(v[1]);
    if (accounts.has(playerId) || [...accounts.values()].some((a) => a.recovery_key === recovery)) {
      return Promise.resolve([]);
    }
    const row: AccountRow = {
      player_id: playerId,
      recovery_key: recovery,
      display_name: typeof v[2] === "string" ? v[2] : null,
      created_at: String(v[3]),
      registered_at: new Date().toISOString(),
      disabled_at: null,
      email_verified_at: null,
    };
    accounts.set(playerId, row);
    return Promise.resolve([row]);
  }

  if (/UPDATE accounts\.players/.test(query) && /recovery_key =/.test(query)) {
    const newKey = String(v[0]);
    const playerId = String(v[1]);
    const row = accounts.get(playerId);
    if (!row || row.disabled_at) return Promise.resolve([]);
    row.recovery_key = newKey;
    return Promise.resolve([{ player_id: playerId }]);
  }

  if (/FROM accounts\.players/.test(query) && /recovery_key =/.test(query)) {
    const recovery = String(v[0]);
    const row = [...accounts.values()].find((a) => a.recovery_key === recovery);
    return Promise.resolve(row ? [row] : []);
  }

  if (/FROM accounts\.players/.test(query) && !/INSERT INTO accounts\.player_sessions/.test(query)) {
    const row = accounts.get(String(v[0]));
    return Promise.resolve(row ? [row] : []);
  }

  if (/INSERT INTO accounts\.player_sessions/.test(query)) {
    const hash = String(v[0]);
    const playerId = String(v[2]);
    if (!accounts.has(playerId)) return Promise.resolve([]);
    sessions.set(hash, {
      player_id: playerId,
      expires_at: String(v[1]),
      revoked_at: null,
    });
    return Promise.resolve([{ player_id: playerId }]);
  }

  if (/FROM accounts\.player_sessions/.test(query)) {
    const row = sessions.get(String(v[0]));
    return Promise.resolve(
      row && !row.revoked_at && Date.parse(row.expires_at) > Date.now()
        ? [{ player_id: row.player_id }]
        : []
    );
  }

  if (/UPDATE accounts\.player_sessions/.test(query)) {
    const row = sessions.get(String(v[0]));
    if (row && !row.revoked_at) row.revoked_at = new Date().toISOString();
    return Promise.resolve([]);
  }

  if (/SELECT COALESCE\(SUM\(amount\), 0\) AS balance/.test(query)) {
    const playerId = String(v[0]);
    return Promise.resolve([{
      balance: ledger.filter((r) => r.player_id === playerId).reduce((n, r) => n + r.amount, 0),
    }]);
  }

  if (/BOOL_OR\(grant_key = 'initial_complimentary'\)/.test(query)) {
    const playerId = String(v[0]);
    const rows = ledger.filter((r) => r.player_id === playerId);
    return Promise.resolve([{
      balance: rows.reduce((n, r) => n + r.amount, 0),
      complimentary_granted: 0,
      purchased: rows.filter((r) => r.grant_key.startsWith("purchase:"))
        .reduce((n, r) => n + r.amount, 0),
      consumed: 0,
      expired: 0,
      initial_complimentary_granted: rows.some(
        (r) => r.grant_key === "initial_complimentary"
      ),
      anonymous_complimentary_granted: rows.some(
        (r) => r.grant_key === "anonymous_first_game"
      ),
    }]);
  }

  if (/FROM accounts\.unlimited_play/.test(query)) {
    return Promise.resolve(unlimited.has(String(v[0])) ? [{ "?column?": 1 }] : []);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

const SAVED = {
  database: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
  storefront: process.env.DICS_STOREFRONT_URL,
  manifest: process.env.DICS_MANIFEST_URL,
  entitlements: process.env.ENTITLEMENTS_ENABLED,
};
const realFetch = globalThis.fetch;

/** A minimal but shape-valid stand-in for DICS's own manifest response. */
const FAKE_MANIFEST = {
  offers: {
    standard_flavors: [
      { key: "vanilla", name: "Vanilla", payment_link: "https://buy.stripe.com/fake-scoop" },
    ],
    custom_flavor: { payment_link: "https://buy.stripe.com/fake-custom" },
  },
};

beforeEach(() => {
  accounts = new Map();
  sessions = new Map();
  ledger = [];
  unlimited = new Set();
  process.env.ENTITLEMENTS_ENABLED = "true";
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  process.env.DICS_STOREFRONT_URL = "https://dics.example/store";
  process.env.DICS_MANIFEST_URL = "https://dics.example/manifest.json";
  __resetDicsCatalogCacheForTests();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(FAKE_MANIFEST), { status: 200 })) as typeof fetch;
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  globalThis.fetch = realFetch;
  __resetDicsCatalogCacheForTests();
  if (SAVED.database === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED.database;
  if (SAVED.corpus === undefined) delete process.env.CORPUS_ENABLED;
  else process.env.CORPUS_ENABLED = SAVED.corpus;
  if (SAVED.storefront === undefined) delete process.env.DICS_STOREFRONT_URL;
  else process.env.DICS_STOREFRONT_URL = SAVED.storefront;
  if (SAVED.manifest === undefined) delete process.env.DICS_MANIFEST_URL;
  else process.env.DICS_MANIFEST_URL = SAVED.manifest;
  if (SAVED.entitlements === undefined) delete process.env.ENTITLEMENTS_ENABLED;
  else process.env.ENTITLEMENTS_ENABLED = SAVED.entitlements;
});

test("an authenticated account's player_id drives the visible unlimited state", async () => {
  const playerId = "9".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "8".repeat(64),
    displayName: "Zsolt",
  });
  unlimited.add(playerId);
  const token = await createAccountSession(playerId);

  const response = await readEntitlement(
    new Request("https://barkoba.test/api/player/entitlement", {
      headers: {
        cookie: `bk_account_session=${token}`,
        [PLAYER_HEADER]: "7".repeat(32),
      },
    }) as Parameters<typeof readEntitlement>[0]
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.unlimited, true);
  assert.equal(body.play_state, "unlimited");
  assert.equal(body.balance, 0);
});

// ---------------------------------------------------------------------------
// V2.7.x M2 — the homepage badge must not tell an already-played guest "Az
// első VERSENYED vár rád" (your first game awaits). resolvePlayState() itself
// is untouched (see lib/entitlements.ts); what changed is WHICH pool's
// (amount, already-granted) pair /api/player/entitlement feeds it, based on
// the caller's actual identity kind and verification status.
// ---------------------------------------------------------------------------

test("a fresh guest (no ledger activity at all) still sees introductory_available", async () => {
  const guestId = "c".repeat(32);
  const response = await readEntitlement(
    new Request("https://barkoba.test/api/player/entitlement", {
      headers: { [PLAYER_HEADER]: guestId },
    }) as Parameters<typeof readEntitlement>[0]
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.play_state, "introductory_available");
});

test("a guest who already spent the anonymous complimentary game reads exhausted, not introductory_available", async () => {
  const guestId = "d".repeat(32);
  ledger.push({ player_id: guestId, amount: 0, grant_key: "anonymous_first_game" });

  const response = await readEntitlement(
    new Request("https://barkoba.test/api/player/entitlement", {
      headers: { [PLAYER_HEADER]: guestId },
    }) as Parameters<typeof readEntitlement>[0]
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.balance, 0);
  assert.equal(
    body.play_state,
    "exhausted",
    "must not claim a first game still awaits one that was already played"
  );
});

test("a registered but unverified account reads exhausted, not introductory_available, even with balance 0", async () => {
  const playerId = "e".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "e".repeat(64), displayName: "Zsolt" });
  // email_verified_at defaults to null on this fake, matching a genuinely
  // unverified registration — no explicit set needed.
  const token = await createAccountSession(playerId);

  const response = await readEntitlement(
    new Request("https://barkoba.test/api/player/entitlement", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof readEntitlement>[0]
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    body.play_state,
    "exhausted",
    "the post-verification pool is not available before email_verified_at is set"
  );
});

test("a verified account with the post-verification grant not yet used still sees introductory_available", async () => {
  const playerId = "f".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "f".repeat(64), displayName: "Zsolt" });
  accounts.get(playerId)!.email_verified_at = new Date().toISOString();
  const token = await createAccountSession(playerId);

  const response = await readEntitlement(
    new Request("https://barkoba.test/api/player/entitlement", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof readEntitlement>[0]
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    body.play_state,
    "introductory_available",
    "a verified account's OWN introductory grant must be unaffected by this fix"
  );
});

test("TASK 6G diagnostic traces the same account through display and game admission", async () => {
  const playerId = "1".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "2".repeat(64),
    displayName: "Zsolt",
  });
  unlimited.add(playerId);
  const token = await createAccountSession(playerId);

  const response = await readAccountDiagnostic(
    new Request("https://barkoba.test/api/account/diagnostic", {
      headers: {
        cookie: `bk_account_session=${token}`,
        [PLAYER_HEADER]: "3".repeat(32),
      },
    })
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.deepEqual(body.unlimited_lookup, { active: true, lookup: "ok" });
  assert.equal(body.entitlement.play_state, "unlimited");
  assert.deepEqual(body.game_creation_precheck, { ok: true, reason: "unlimited" });
  assert.equal(body.account.display_name, "Zsolt");
  assert.match(body.player_fingerprint, /^[0-9a-f]{12}$/);

  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /bk_account_session|recovery|session_hash|secret/i);
  assert.doesNotMatch(serialized, new RegExp(playerId));
  assert.doesNotMatch(serialized, new RegExp(token));
});

test("TASK 6G diagnostic refuses guest identity", async () => {
  const response = await readAccountDiagnostic(
    new Request("https://barkoba.test/api/account/diagnostic", {
      headers: { [PLAYER_HEADER]: "4".repeat(32) },
    })
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    diagnostic: "task6g",
    authenticated: false,
    identity_kind: "guest",
  });
});

test("TASK 6H: a registered local identity cannot silently register again", async () => {
  const playerId = "5".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "6".repeat(64),
    displayName: "Zsolt",
  });

  // No account-session cookie presented: exactly the stuck state — the local
  // bk_player already belongs to an account, but this browser is not logged in.
  const context = await resolveActingPlayer(
    new Request("https://barkoba.test/api/account/register", {
      headers: { [PLAYER_HEADER]: playerId },
    }).headers
  );
  assert.equal(context.kind, "registered");

  // register/route.ts uses next/headers cookies() and cannot be invoked directly
  // in this harness (see the existing structural tests above it), so the
  // guarantee that this state is refused, not silently re-registered, is
  // asserted the same way the rest of this suite already does for that route.
  const source = readFileSync("app/api/account/register/route.ts", "utf8");
  assert.match(source, /context\.kind === "registered"/);
  assert.match(source, /login_required/);
  assert.match(source, /status: 409/);
  assert.doesNotMatch(
    source.slice(source.indexOf('context.kind === "registered"'), source.indexOf("if (context.kind !== \"guest\")")),
    /registerPlayerAccount/
  );
});

test("TASK 6H: explicit reset clears only this browser's identity/session cookies", async () => {
  const playerId = "1".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "old-recovery-key-do-not-lose".padEnd(64, "0"),
    displayName: "Zsolt",
  });

  const response = await resetIdentity(
    new Request("https://barkoba.test/api/account/reset-identity", {
      method: "POST",
      headers: { [PLAYER_HEADER]: playerId },
    })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reset, true);
  assert.equal(
    body.message,
    "A régi fiók nem törlődik. Ez a böngésző új játékosként indul tovább."
  );

  const cleared = response.headers.getSetCookie();
  assert.equal(cleared.length, 3, `expected exactly 3 cleared cookies, got: ${cleared.join(" | ")}`);
  for (const name of ["bk_player=", "bk_player_name=", "bk_account_session="]) {
    const cookie = cleared.find((c) => c.startsWith(name));
    assert.ok(cookie, `expected a cleared ${name} cookie`);
    assert.match(cookie!, /Max-Age=0/);
  }
});

test("TASK 6H: reset leaves the old account completely untouched in the database", async () => {
  const playerId = "2".repeat(32);
  const recoveryKey = "another-old-recovery-key".padEnd(64, "0");
  await registerPlayerAccount({ playerId, recoveryKey, displayName: "Zsolt" });
  unlimited.add(playerId);
  const before = await getPlayerAccount(playerId);
  const sessionsBefore = sessions.size;

  const response = await resetIdentity(
    new Request("https://barkoba.test/api/account/reset-identity", {
      method: "POST",
      headers: { [PLAYER_HEADER]: playerId },
    })
  );
  assert.equal(response.status, 200);

  const after = await getPlayerAccount(playerId);
  assert.deepEqual(after, before, "the registered account row must be byte-for-byte unchanged");
  assert.equal(sessions.size, sessionsBefore, "no session rows should be created or altered");
  assert.equal(unlimited.has(playerId), true, "the unlimited grant must survive the reset");
});

test("TASK 6H: reset refuses when there is no orphaned registered identity to abandon", async () => {
  const guestResponse = await resetIdentity(
    new Request("https://barkoba.test/api/account/reset-identity", {
      method: "POST",
      headers: { [PLAYER_HEADER]: "3".repeat(32) },
    })
  );
  assert.equal(guestResponse.status, 409);
  assert.equal(guestResponse.headers.getSetCookie().length, 0);

  const playerId = "4".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "yet-another-key".padEnd(64, "0"), displayName: "Zsolt" });
  const token = await createAccountSession(playerId);
  const authenticatedResponse = await resetIdentity(
    new Request("https://barkoba.test/api/account/reset-identity", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}`, [PLAYER_HEADER]: playerId },
    })
  );
  assert.equal(authenticatedResponse.status, 409, "an active session must never be cleared by this route");
  assert.equal(authenticatedResponse.headers.getSetCookie().length, 0);
  assert.equal(await resolveAccountSession(token), playerId, "the active session must remain valid");
});

test("TASK 6H: the next request gets a distinct fresh guest identity, and it can register normally", async () => {
  const oldPlayerId = "9".repeat(30) + "aa";
  await registerPlayerAccount({
    playerId: oldPlayerId,
    recoveryKey: "the-lost-recovery-code".padEnd(64, "0"),
    displayName: "Zsolt",
  });
  const oldAccountBefore = structuredClone(accounts.get(oldPlayerId));

  // What middleware does on the very next request once bk_player is cleared:
  // no valid signed cookie survives, so a brand-new id is minted.
  const fresh = await issuePlayerCookie();
  assert.notEqual(fresh.playerId, oldPlayerId);

  const freshContext = await resolveActingPlayer(
    new Request("https://barkoba.test/", { headers: { [PLAYER_HEADER]: fresh.playerId } }).headers
  );
  assert.equal(freshContext.kind, "guest", "a freshly minted id must not inherit the old account's status");

  const { account, created } = await registerPlayerAccount({
    playerId: fresh.playerId,
    recoveryKey: "brand-new-recovery-code".padEnd(64, "0"),
    displayName: "Zsolt",
  });
  assert.equal(created, true);
  assert.equal(account.player_id, fresh.playerId);
  assert.equal(account.display_name, "Zsolt");

  // The old account is a separate row, entirely undisturbed by the new one.
  assert.deepEqual(accounts.get(oldPlayerId), oldAccountBefore);
  assert.equal(accounts.size, 2);
});

test("recovery code rotation: the old code stops working and the new one logs in", async () => {
  const playerId = "6".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "old-code-hash".padEnd(64, "0"),
    displayName: "Zsolt",
  });
  const oldHash = accounts.get(playerId)!.recovery_key;
  const token = await createAccountSession(playerId);

  const response = await rotateRecoveryCode(
    new Request("https://barkoba.test/api/account/rotate-recovery-code", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}` },
    })
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.rotated, true);
  assert.match(body.recovery_code, /^BARKOBA-([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);

  const newHash = await recoveryKey(body.recovery_code);
  assert.notEqual(newHash, oldHash);
  assert.equal(await getPlayerAccountByRecoveryKey(oldHash), null, "the old code must stop working");
  const viaNewCode = await getPlayerAccountByRecoveryKey(newHash);
  assert.equal(viaNewCode?.player_id, playerId, "the new code must log in immediately");
});

test("recovery code rotation leaves player_id, display_name, timestamps, ledger and unlimited_play byte-for-byte unchanged", async () => {
  const playerId = "7".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "another-code-hash".padEnd(64, "0"),
    displayName: "Zsolt",
  });
  unlimited.add(playerId);
  ledger.push({ player_id: playerId, amount: 10, grant_key: "initial_complimentary" });
  const ledgerBefore = structuredClone(ledger);
  const before = await getPlayerAccount(playerId);
  const token = await createAccountSession(playerId);

  const response = await rotateRecoveryCode(
    new Request("https://barkoba.test/api/account/rotate-recovery-code", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}` },
    })
  );
  assert.equal(response.status, 200);

  const after = await getPlayerAccount(playerId);
  assert.equal(after?.player_id, before?.player_id);
  assert.equal(after?.display_name, before?.display_name);
  assert.equal(after?.created_at, before?.created_at);
  assert.equal(after?.registered_at, before?.registered_at);
  assert.notEqual(after?.recovery_key, before?.recovery_key, "only the credential itself should change");
  assert.deepEqual(ledger, ledgerBefore, "the ledger must not be touched");
  assert.equal(unlimited.has(playerId), true, "the unlimited grant must survive rotation");
  assert.equal(await resolveAccountSession(token), playerId, "the current session must remain valid");
});

test("recovery code rotation refuses a caller without an active session", async () => {
  const guestResponse = await rotateRecoveryCode(
    new Request("https://barkoba.test/api/account/rotate-recovery-code", {
      method: "POST",
      headers: { [PLAYER_HEADER]: "8".repeat(32) },
    })
  );
  assert.equal(guestResponse.status, 401);

  const playerId = "9".repeat(30) + "aa";
  await registerPlayerAccount({
    playerId,
    recoveryKey: "yet-another-code-hash".padEnd(64, "0"),
    displayName: "Zsolt",
  });
  const registeredNoSessionResponse = await rotateRecoveryCode(
    new Request("https://barkoba.test/api/account/rotate-recovery-code", {
      method: "POST",
      headers: { [PLAYER_HEADER]: playerId },
    })
  );
  assert.equal(
    registeredNoSessionResponse.status,
    401,
    "a registered-but-not-logged-in browser must not be able to rotate the credential it doesn't hold"
  );
  assert.equal(accounts.get(playerId)!.recovery_key, "yet-another-code-hash".padEnd(64, "0"));
});

test("registration preserves player_id, ledger rows, balance and ownership markers", async () => {
  const playerId = "a".repeat(32);
  ledger.push(
    { player_id: playerId, amount: 5, grant_key: "purchase:one" },
    { player_id: playerId, amount: 10, grant_key: "initial_complimentary" },
    { player_id: playerId, amount: -1, grant_key: "game:one" }
  );
  const beforeRows = structuredClone(ledger);
  const beforeBalance = await getBalance(playerId);

  const { account, created } = await registerPlayerAccount({
    playerId,
    recoveryKey: "b".repeat(64),
    displayName: "Zsolt",
  });

  assert.equal(created, true);
  assert.equal(account.player_id, playerId);
  assert.deepEqual(ledger, beforeRows, "registration must not copy or alter ledger rows");
  assert.equal(await getBalance(playerId), beforeBalance);
  assert.ok(ledger.some((row) => row.grant_key === "initial_complimentary"));
});

test("two devices resolve one account and logout revokes only the presented session", async () => {
  const playerId = "c".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "d".repeat(64),
    displayName: null,
  });
  ledger.push({ player_id: playerId, amount: 30, grant_key: "purchase:two" });

  const deviceOne = await createAccountSession(playerId);
  const deviceTwo = await createAccountSession(playerId);
  assert.notEqual(deviceOne, deviceTwo, "login must mint a fresh session token");
  assert.equal(await resolveAccountSession(deviceOne), playerId);
  assert.equal(await resolveAccountSession(deviceTwo), playerId);
  assert.equal(await getBalance(playerId), 30);

  await revokeAccountSession(deviceOne);
  assert.equal(await resolveAccountSession(deviceOne), null);
  assert.equal(await resolveAccountSession(deviceTwo), playerId);
  assert.equal(await getBalance(playerId), 30, "logout cannot alter account RACES");
});

test("registered ownership survives lost browser state and old bk_player has no authority", async () => {
  const playerId = "e".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "f".repeat(64),
    displayName: null,
  });
  ledger.push({ player_id: playerId, amount: 15, grant_key: "purchase:three" });

  assert.deepEqual(await resolveActingPlayer(new Headers()), { kind: "none", playerId: null });
  assert.equal(await getBalance(playerId), 15, "lost cookies do not delete account value");

  const oldCookie = await issuePlayerCookie(playerId);
  const oldHeaders = new Headers({ [PLAYER_HEADER]: oldCookie.playerId });
  assert.deepEqual(await resolveActingPlayer(oldHeaders), { kind: "registered", playerId });
  assert.equal(await resolveActingPlayerId(oldHeaders), null, "old cookie is information, not authority");

  const freshSession = await createAccountSession(playerId);
  const accountHeaders = new Headers({ cookie: `bk_account_session=${freshSession}` });
  assert.deepEqual(await resolveActingPlayer(accountHeaders), { kind: "account", playerId });
});

test("V2.7.0.15 diagnostic — a presented-but-invalid account session logs, an absent one never does", async () => {
  // Production finding: a browser that was authenticated (Profil visible,
  // credits spent down) later showed "Regisztráció / Belépés" while still
  // displaying a balance — consistent with an account session token being
  // PRESENTED but no longer resolving, silently falling through to a
  // different (guest) identity. This pins the diagnostic added to find out
  // why, and equally importantly, that it stays SILENT for the ordinary
  // "no session cookie at all" case every anonymous visitor is in — logging
  // that unconditionally would be pure noise, not a diagnostic.
  const playerId = "7".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "8".repeat(64), displayName: null });
  const token = await createAccountSession(playerId);
  await revokeAccountSession(token);

  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const revokedHeaders = new Headers({ cookie: `bk_account_session=${token}` });
    const revokedContext = await resolveActingPlayer(revokedHeaders);
    assert.notEqual(revokedContext.kind, "account", "a revoked session must not authenticate");
    assert.ok(
      logged.some((line) => line.includes("account session token presented but did not resolve")),
      "a presented, invalid session token must be diagnosable"
    );
    assert.ok(
      logged.every((line) => !line.includes(token)),
      "the diagnostic must never include the raw session token"
    );

    logged.length = 0;
    await resolveActingPlayer(new Headers());
    assert.deepEqual(logged, [], "an ordinary anonymous visitor (no session cookie at all) must log nothing");
  } finally {
    console.error = originalError;
  }
});

test("V2.7.0.17 diagnostic — distinguishes NO session row from a row that exists but did not validate", async () => {
  // Production evidence: a presented, well-formed session token failed to
  // resolve on EVERY request of an affected browsing session, from the
  // very first page load onward (confirmed via real production logs, not
  // inferred) — pointing at something wrong with the stored session itself,
  // not a transient race. This is the one follow-up read that can actually
  // say which of "no row at all" vs "row exists but revoked/expired/account
  // disabled" is true, since lib/actingPlayer.ts's own diagnostic can only
  // say THAT resolution failed, not why.
  //
  // Uses a purpose-built fake (not the shared one above, which pre-filters
  // accounts.player_sessions reads by validity and so cannot distinguish
  // "row missing" from "row present but invalid") so the two messages are
  // proven against their actual trigger condition, not assumed.
  const token = "R".repeat(43);
  const hash = await accountSessionHash(token);
  const otherToken = "S".repeat(43);
  const otherHash = await accountSessionHash(otherToken);

  function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
    const query = strings.join(" ");
    const v = values as unknown[];
    if (/FROM accounts\.player_sessions s\s+JOIN accounts\.players p/.test(query)) {
      return Promise.resolve([]); // the primary, filtered lookup always misses here
    }
    if (/LEFT JOIN accounts\.players/.test(query)) {
      const presentedHash = String(v[0]);
      if (presentedHash === otherHash) {
        // The "row exists but revoked" case.
        return Promise.resolve([
          { revoked_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1000).toISOString(), not_expired: true, account_disabled_at: null },
        ]);
      }
      return Promise.resolve([]); // "no row at all" case
    }
    return Promise.resolve([]);
  }
  fakeSql.transaction = (q: Promise<Record<string, unknown>[]>[]) => Promise.all(q);

  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    __setSqlClientForTests(fakeSql);

    logged.length = 0;
    assert.equal(await resolveAccountSession(token), null);
    assert.ok(
      logged.some((line) => line.includes("has NO row in accounts.player_sessions at all")),
      "a session_hash with no matching row must say so precisely"
    );
    assert.ok(logged.every((line) => !line.includes(hash) && !line.includes(token)));

    logged.length = 0;
    assert.equal(await resolveAccountSession(otherToken), null);
    assert.ok(
      logged.some((line) => line.includes("session row exists but did not validate — revoked=true")),
      "a row that exists but is revoked must be distinguished from a missing row"
    );
    assert.ok(logged.every((line) => !line.includes(otherHash) && !line.includes(otherToken)));
  } finally {
    console.error = originalError;
    __setSqlClientForTests(null);
  }
});

test("legacy protected players migrate idempotently without changing player_id", async () => {
  const record: DurablePlayer = {
    player_id: "1".repeat(32),
    recovery_key: "2".repeat(64),
    display_name: "Régi játékos",
    created_at: "2026-01-01T00:00:00.000Z",
    claimed_at: "2026-01-01T00:00:00.000Z",
  };
  const first = await migrateLegacyPlayer(record);
  const second = await migrateLegacyPlayer(record);
  assert.equal(first.player_id, record.player_id);
  assert.deepEqual(second, first);
  assert.equal(accounts.size, 1);
});

test("encountering a legacy protected cookie migrates it but does not authenticate it", async () => {
  const playerId = "6".repeat(32);
  const legacy = await claimPlayer(playerId, "Korábbi", "LEGACY-ACCOUNT-CODE");
  assert.ok(legacy);
  const headers = new Headers({ [PLAYER_HEADER]: playerId });

  assert.deepEqual(await resolveActingPlayer(headers), { kind: "registered", playerId });
  assert.equal(accounts.get(playerId)?.recovery_key, legacy.recovery_key);
  assert.equal(await resolveActingPlayerId(headers), null);
  assert.deepEqual(await resolveActingPlayer(headers), { kind: "registered", playerId });
  assert.equal(accounts.size, 1);
});

test("guest purchase intent is refused and an authenticated account can mint one", async () => {
  const guestId = "3".repeat(32);
  const guestResponse = await createPurchaseIntent(
    new Request("https://barkoba.test/api/entitlement/intent", {
      method: "POST",
      headers: { [PLAYER_HEADER]: guestId },
    }) as Parameters<typeof createPurchaseIntent>[0]
  );
  assert.equal(guestResponse.status, 409);
  assert.equal((await guestResponse.json()).error, "account_required");

  const playerId = "4".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "5".repeat(64),
    displayName: null,
  });
  // V2.7 — intent now also requires a verified email; this test is about
  // account ownership, not verification, so mark it verified directly rather
  // than modeling the real registration email flow here.
  accounts.get(playerId)!.email_verified_at = new Date().toISOString();
  const token = await createAccountSession(playerId);
  const accountResponse = await createPurchaseIntent(
    new Request("https://barkoba.test/api/entitlement/intent", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ package_id: "dics_scoop", flavor_key: "vanilla" }),
    }) as Parameters<typeof createPurchaseIntent>[0]
  );
  assert.equal(accountResponse.status, 200);
  const body = await accountResponse.json();
  assert.match(body.purchase_ref, /^[0-9A-HJKMNP-TV-Z]{16}$/);
  // V2.7.x — purchase_url now points DIRECTLY at DICS's own published Stripe
  // Payment Link for the selected package/flavor, not at DICS's storefront
  // page. See lib/dicsCatalog.ts and docs/DESIGN-NOTES.md §51.8.
  assert.match(body.purchase_url, /^https:\/\/buy\.stripe\.com\/fake-scoop\?/);
  assert.match(body.purchase_url, /client_reference_id=/);
});

test("purchase intent refuses an unknown package_id", async () => {
  const playerId = "7".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "6".repeat(64), displayName: null });
  accounts.get(playerId)!.email_verified_at = new Date().toISOString();
  const token = await createAccountSession(playerId);
  const res = await createPurchaseIntent(
    new Request("https://barkoba.test/api/entitlement/intent", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ package_id: "not_a_real_package" }),
    }) as Parameters<typeof createPurchaseIntent>[0]
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_package");
});

test("two purchase intents for the same flavor carry their own distinct correlation reference", async () => {
  // The reconciliation/grant path (app/api/entitlement/grant/route.ts,
  // lib/purchaseRef.ts) identifies a purchase by client_reference_id alone.
  // If two intents ever produced URLs sharing one client_reference_id, a
  // webhook for the SECOND purchase would resolve — and grant credits
  // against — the FIRST purchase's reference. This proves that cannot
  // happen: each call mints its own reference, and the Stripe URL carries
  // that exact value, not a shared or stale one.
  const playerId = "d".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "e".repeat(64), displayName: null });
  accounts.get(playerId)!.email_verified_at = new Date().toISOString();
  const token = await createAccountSession(playerId);

  const mint = () =>
    createPurchaseIntent(
      new Request("https://barkoba.test/api/entitlement/intent", {
        method: "POST",
        headers: { cookie: `bk_account_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ package_id: "dics_scoop", flavor_key: "vanilla" }),
      }) as Parameters<typeof createPurchaseIntent>[0]
    );

  const [firstRes, secondRes] = [await mint(), await mint()];
  const first = await firstRes.json();
  const second = await secondRes.json();

  assert.equal(firstRes.status, 200);
  assert.equal(secondRes.status, 200);
  assert.notEqual(first.purchase_ref, second.purchase_ref);

  const firstClientRef = new URL(first.purchase_url).searchParams.get("client_reference_id");
  const secondClientRef = new URL(second.purchase_url).searchParams.get("client_reference_id");

  // The URL's client_reference_id is exactly this response's own purchase_ref
  // — not merely present, and not the OTHER intent's reference.
  assert.equal(firstClientRef, first.purchase_ref);
  assert.equal(secondClientRef, second.purchase_ref);
  assert.notEqual(firstClientRef, secondClientRef);
});

test("purchase ownership and non-merging are structural at both API and database layers", () => {
  const intent = readFileSync("app/api/entitlement/intent/route.ts", "utf8");
  const login = readFileSync("app/api/account/login/route.ts", "utf8");
  const grant = readFileSync("app/api/entitlement/grant/route.ts", "utf8");
  const ref = readFileSync("lib/purchaseRef.ts", "utf8");
  const migration = readFileSync("migrations/0009_player_accounts.sql", "utf8");
  const claimCompatibility = readFileSync("app/api/player/claim/route.ts", "utf8");

  assert.match(intent, /context\.kind !== "account"/);
  assert.match(intent, /account_required/);
  assert.match(ref, /account_required: true/);
  assert.match(grant, /allowLegacyUnregistered: !ref\.accountRequired/);
  assert.match(migration, /BEFORE INSERT ON accounts\.entitlement_ledger/);
  assert.match(migration, /purchase entitlement requires a registered player account/);
  assert.match(migration, /barkoba\.allow_legacy_purchase/);
  assert.doesNotMatch(login, /entitlement_ledger|UPDATE corpus\.games|composer_player_id|racer_player_id/);
  assert.match(login, /Preserve an unrelated local guest without merging it/);
  assert.match(claimCompatibility, /status: 405/);
});

test("all ownership routes use the central account-aware resolver", () => {
  for (const path of [
    "app/api/game/join/route.ts",
    "app/api/game/[id]/view/route.ts",
    "app/api/game/[id]/resolve/route.ts",
    "app/api/game/[id]/hh/turn/route.ts",
    "app/api/game/[id]/contest/route.ts",
    "app/api/contest/[id]/route.ts",
    "app/game/[id]/page.tsx",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /resolveActingPlayerId/, path);
    assert.doesNotMatch(source, /playerIdFromHeaders/, path);
  }

  const creation = readFileSync("app/api/game/create/route.ts", "utf8");
  assert.match(creation, /resolveActingPlayer\(req\.headers\)/);
  assert.doesNotMatch(creation, /playerIdFromHeaders|resolveActingPlayerId/);

  // V2.7.x M2 — the entitlement route moved to the same broader resolver as
  // game creation, for the same reason: it now needs to tell a guest's
  // identity kind apart from an account's to pick the right introductory
  // pool (see that route's own header comment), which the narrower
  // resolveActingPlayerId() cannot express.
  const balance = readFileSync("app/api/player/entitlement/route.ts", "utf8");
  assert.match(balance, /resolveActingPlayer\(req\.headers\)/);
  assert.doesNotMatch(balance, /playerIdFromHeaders/);
});

test("guest play fallback cannot authorize a registered account or purchase", () => {
  const creation = readFileSync("app/api/game/create/route.ts", "utf8");
  const intent = readFileSync("app/api/entitlement/intent/route.ts", "utf8");
  const composerEntry = readFileSync("app/ComposerEntry.tsx", "utf8");

  assert.match(
    creation,
    /allowGuestFallback:\s*playerContext\.kind === "guest" \|\| playerContext\.kind === "none"/
  );
  assert.doesNotMatch(creation, /allowGuestFallback:[^\n]*(?:"account"|"registered")/);
  assert.match(intent, /context\.kind !== "account"/);
  assert.match(intent, /account_required/);

  const rateLimit = creation.indexOf("checkGameCreationRateLimit(ip, playerId)");
  const validator = creation.indexOf("runValidator(target");
  const aiTarget = creation.indexOf("chooseComposerTarget({");
  assert.ok(rateLimit > 0 && validator > rateLimit && aiTarget > rateLimit);
  assert.doesNotMatch(creation, /recovery_code|recoveryCode|RecoverPrompt/);
  assert.doesNotMatch(
    composerEntry,
    /ClaimPrompt|RecoverPrompt|\/api\/account\/|account_required/,
    "ordinary Human Composer play must have no account or recovery prerequisite"
  );
});

// ---------------------------------------------------------------------------
// V2.7.0.13 — the visitor/IP hourly rate limit (checkGameCreationRateLimit)
// is an ANONYMOUS abuse safeguard. Production human-test proof: one
// anonymous complimentary game plus four of five post-verification credits,
// all from the same IP, hit the default 5/hour ceiling and refused the
// player's own fifth, legitimately-held credit with the GUEST-limit message
// — despite the entitlement gate immediately above already having proven
// real balance. What changed here is that the route no longer calls the
// limiter at all for a verified account identity — see V2.7.0.16 below for
// the SEPARATE fix to the limiter's own key shape (shared-IP contamination
// between different anonymous devices), which these tests do not cover.
// ---------------------------------------------------------------------------

test("A. an anonymous or unverified identity remains fully subject to the visitor rate limit", () => {
  const creation = readFileSync("app/api/game/create/route.ts", "utf8");

  // The exemption requires playerContext.kind === "account" as its FIRST
  // condition — a guest, "none", or a registered-but-session-less identity
  // can never satisfy it, so the rate-limit block below is reached exactly
  // as before for every one of them.
  const exemption = creation.slice(
    creation.indexOf("const accountForExemption ="),
    creation.indexOf("if (!isVerifiedAccount)")
  );
  assert.match(exemption, /playerContext\.kind === "account"/);

  const guarded = creation.slice(
    creation.indexOf("if (!isVerifiedAccount)"),
    creation.indexOf('error: "rate_limited"') + 100
  );
  assert.match(guarded, /checkGameCreationRateLimit\(ip, playerId\)/);
  assert.match(guarded, /rate_limited/);
});

test("B. a verified account identity with a passed entitlement check is exempt from the visitor rate limit", () => {
  const creation = readFileSync("app/api/game/create/route.ts", "utf8");

  // Exemption requires BOTH an account-kind identity AND a currently
  // verified email — an unverified registration stays rate-limited exactly
  // like a guest, matching the product decision precisely ("registered +
  // email-verified", not merely "registered").
  const exemption = creation.slice(
    creation.indexOf("const accountForExemption ="),
    creation.indexOf("if (!isVerifiedAccount)")
  );
  assert.match(exemption, /playerContext\.kind === "account"/);
  assert.match(exemption, /email_verified_at != null/);
  assert.match(exemption, /getPlayerAccount\(playerContext\.playerId\)/);

  // The entire rate-limit check AND its refusal live inside
  // `if (!isVerifiedAccount)` — a verified account never reaches
  // checkGameCreationRateLimit() or the "rate_limited" response at all, it
  // is not merely exempted from failing it.
  const ifIndex = creation.indexOf("if (!isVerifiedAccount)");
  const closeIndex = creation.indexOf("\n  }\n\n  let body: CreateGameBody;");
  assert.ok(ifIndex > 0 && closeIndex > ifIndex, "could not locate the guard block");
  const beforeGuard = creation.slice(0, ifIndex);
  const afterGuardClose = creation.slice(closeIndex);
  assert.doesNotMatch(beforeGuard.slice(beforeGuard.indexOf("const accountForExemption =")), /rate_limited/);
  assert.doesNotMatch(afterGuardClose, /rate_limited/);

  // This exemption sits strictly AFTER the entitlement pre-check (canStartGame
  // / entitlementRefusal), so "verified account" alone can never bypass the
  // rate limit without ALSO having already proven a real, spendable balance.
  const preCheckIndex = creation.indexOf("const preCheck = await canStartGame");
  const isVerifiedIndex = creation.indexOf("const accountForExemption =");
  assert.ok(preCheckIndex > 0 && isVerifiedIndex > preCheckIndex);
});

test("C. the exemption is re-derived from CURRENT account state, never carried forward from the anonymous phase", () => {
  const creation = readFileSync("app/api/game/create/route.ts", "utf8");

  // getPlayerAccount() is a live, per-request database read of the CURRENT
  // row — not a cookie flag, not a value threaded through from the earlier
  // anonymous game, and not anything checkGameCreationRateLimit()'s own
  // counter could carry forward. There is nothing in this file that
  // persists "was previously anonymous" across the registration/
  // verification transition, so a verified account's exemption is decided
  // fresh on every single request, exactly like the entitlement balance it
  // depends on.
  const exemption = creation.slice(
    creation.indexOf("const accountForExemption ="),
    creation.indexOf("if (!isVerifiedAccount)")
  );
  assert.match(exemption, /await getPlayerAccount/);

  // V2.7.0.16 — the limiter itself now takes a device/guest identity (the
  // shared-IP fix), but it must stay VERIFICATION-blind: it folds a bare
  // playerId into its key and nothing more. Whether that id belongs to a
  // verified account is a decision the ROUTE makes (isVerifiedAccount,
  // asserted above) entirely BEFORE ever calling the limiter — the limiter
  // itself has no account/verified concept at all.
  const rateLimitModule = readFileSync("lib/rateLimit.ts", "utf8");
  const gameCreationFn = rateLimitModule.slice(
    rateLimitModule.indexOf("export async function checkGameCreationRateLimit"),
    rateLimitModule.indexOf("export function extractClientIp")
  );
  assert.match(gameCreationFn, /playerId/, "the limiter must accept a device identity (the shared-IP fix)");
  assert.doesNotMatch(
    gameCreationFn,
    /account|verified/i,
    "the visitor limiter itself must stay VERIFICATION-blind — the route decides who it applies to, not the limiter"
  );
});
