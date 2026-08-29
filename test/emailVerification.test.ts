import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import {
  registerPlayerAccount,
  getPlayerAccount,
  getPlayerAccountByEmail,
  getPlayerAccountByVerificationTokenHash,
  markEmailVerified,
  setAccountEmail,
  EmailAlreadyRegisteredError,
} from "../lib/playerAccounts";
import {
  EMAIL_VERIFICATION_TTL_SECONDS,
  generateVerificationToken,
  looksLikeEmail,
  sendVerificationEmail,
  verificationTokenHash,
} from "../lib/emailVerification";
import {
  GET as verifyEmailStatus,
  POST as confirmVerification,
} from "../app/api/account/verify-email/route";
import { POST as updateEmail } from "../app/api/account/email/route";
import { GET as readProfile } from "../app/api/account/profile/route";
import { GET as readEntitlement } from "../app/api/player/entitlement/route";
import { createAccountSession, resolveAccountSession } from "../lib/accountSession";
import { PLAYER_HEADER } from "../lib/playerIdentity";

// ---------------------------------------------------------------------------
// V2.6.x — email collection, the verification token lifecycle, and
// GET /api/account/verify-email.
//
// register/route.ts uses next/headers cookies() and (per the existing
// convention in test/accountOwnership.test.ts) cannot be invoked directly in
// this harness, so its wiring is proven by source inspection here, exactly
// like the rest of this suite already does for that file. Everything the
// wiring calls into — registerPlayerAccount, the token functions, the stub,
// and the fully header/URL-based verify-email route — is proven behaviorally.
// ---------------------------------------------------------------------------

interface AccountRow {
  player_id: string;
  recovery_key: string;
  display_name: string | null;
  created_at: string;
  registered_at: string;
  disabled_at: string | null;
  email: string | null;
  email_verified_at: string | null;
  email_verification_token: string | null;
  email_verification_expires_at: string | null;
  photo_url: string | null;
}

interface SessionRow {
  player_id: string;
  expires_at: string;
  revoked_at: string | null;
}

interface LedgerRow {
  player_id: string;
  amount: number;
  grant_key: string | null;
}

let accounts: Map<string, AccountRow>;
let sessions: Map<string, SessionRow>;
let ledger: LedgerRow[];
let unlimited: Set<string>;

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const query = strings.join(" ");
  const v = values as unknown[];

  if (/INSERT INTO accounts\.player_sessions/.test(query)) {
    const hash = String(v[0]);
    const playerId = String(v[2]);
    if (!accounts.has(playerId)) return Promise.resolve([]);
    sessions.set(hash, { player_id: playerId, expires_at: String(v[1]), revoked_at: null });
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

  if (/INSERT INTO accounts\.players/.test(query)) {
    const playerId = String(v[0]);
    const email = typeof v[4] === "string" ? v[4] : null;
    // Models migration 0011's UNIQUE INDEX ON LOWER(email): a bare
    // ON CONFLICT DO NOTHING absorbs a collision on ANY unique constraint,
    // not only player_id, so the fake must refuse here too.
    const emailTaken =
      email !== null &&
      [...accounts.values()].some(
        (a) => a.email !== null && a.email.toLowerCase() === email.toLowerCase()
      );
    if (accounts.has(playerId) || emailTaken) return Promise.resolve([]);
    const row: AccountRow = {
      player_id: playerId,
      recovery_key: String(v[1]),
      display_name: typeof v[2] === "string" ? v[2] : null,
      created_at: String(v[3]),
      registered_at: new Date().toISOString(),
      disabled_at: null,
      email,
      email_verified_at: null,
      email_verification_token: typeof v[5] === "string" ? v[5] : null,
      email_verification_expires_at: typeof v[6] === "string" ? v[6] : null,
      photo_url: null,
    };
    accounts.set(playerId, row);
    return Promise.resolve([row]);
  }

  if (/UPDATE accounts\.players/.test(query) && /email_verified_at = COALESCE/.test(query)) {
    const playerId = String(v[0]);
    const row = accounts.get(playerId);
    if (!row || row.disabled_at) return Promise.resolve([]);
    if (!row.email_verified_at) row.email_verified_at = new Date().toISOString();
    return Promise.resolve([{ player_id: playerId }]);
  }

  if (/UPDATE accounts\.players/.test(query) && /SET email =/.test(query)) {
    const [email, tokenHash, expiresAt, playerId] = v.map(String);
    const row = accounts.get(playerId!);
    if (!row || row.disabled_at) return Promise.resolve([]);
    row.email = email!;
    row.email_verified_at = null;
    row.email_verification_token = tokenHash!;
    row.email_verification_expires_at = expiresAt!;
    return Promise.resolve([{ player_id: playerId }]);
  }

  if (/FROM accounts\.players/.test(query) && /LOWER\(email\)/.test(query)) {
    const email = String(v[0]).toLowerCase();
    const row = [...accounts.values()].find(
      (a) => (a.email ?? "").toLowerCase() === email && !a.disabled_at
    );
    return Promise.resolve(row ? [row] : []);
  }

  if (/FROM accounts\.players/.test(query) && /email_verification_token =/.test(query)) {
    const hash = String(v[0]);
    const row = [...accounts.values()].find((a) => a.email_verification_token === hash);
    return Promise.resolve(row ? [row] : []);
  }

  if (/FROM accounts\.players/.test(query) && /recovery_key =/.test(query)) {
    const recovery = String(v[0]);
    const row = [...accounts.values()].find((a) => a.recovery_key === recovery);
    return Promise.resolve(row ? [row] : []);
  }

  if (/FROM accounts\.players/.test(query) && /player_id =/.test(query)) {
    const row = accounts.get(String(v[0]));
    return Promise.resolve(row ? [row] : []);
  }

  // V2.7.0.3 — ensureInitialComplimentary's own writes/reads, exercised now
  // that verify-email's POST calls it eagerly. Matches the shape already
  // established in test/accountOwnership.test.ts and test/entitlements.test.ts.
  if (/INSERT INTO accounts\.entitlement_ledger/.test(query)) {
    const playerId = String(v[0]);
    const amount = Number(v[1]);
    const grantKey = typeof v[2] === "string" ? v[2] : null;
    if (grantKey && ledger.some((r) => r.player_id === playerId && r.grant_key === grantKey)) {
      return Promise.resolve([]); // ON CONFLICT DO NOTHING
    }
    ledger.push({ player_id: playerId, amount, grant_key: grantKey });
    return Promise.resolve([{ entry_id: ledger.length }]);
  }

  if (/FROM accounts\.unlimited_play/.test(query)) {
    return Promise.resolve(unlimited.has(String(v[0])) ? [{ "?column?": 1 }] : []);
  }

  // getStatus()'s full-shape query. Matches accountOwnership.test.ts's
  // fake exactly — a simpler balance-only handler would silently zero out
  // initial_complimentary_granted for any caller of getStatus() (not just
  // ensureInitialComplimentary, which never calls it), which would be
  // wrong, not merely incomplete.
  if (/BOOL_OR\(grant_key = 'initial_complimentary'\)/.test(query)) {
    const playerId = String(v[0]);
    const rows = ledger.filter((r) => r.player_id === playerId);
    return Promise.resolve([{
      balance: rows.reduce((n, r) => n + r.amount, 0),
      complimentary_granted: rows.reduce((n, r) => n + r.amount, 0),
      purchased: 0,
      consumed: 0,
      expired: 0,
      initial_complimentary_granted: rows.some((r) => r.grant_key === "initial_complimentary"),
      anonymous_complimentary_granted: rows.some((r) => r.grant_key === "anonymous_first_game"),
    }]);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

beforeEach(() => {
  accounts = new Map();
  sessions = new Map();
  ledger = [];
  unlimited = new Set();
  process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  process.env.ENTITLEMENTS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
  delete process.env.ENTITLEMENTS_ENABLED;
  __setSqlClientForTests(null);
});

// ---------------------------------------------------------------------------
// Pure functions: shape validation and the token/hash pair.
// ---------------------------------------------------------------------------

test("looksLikeEmail accepts plausible addresses and refuses everything else", () => {
  for (const ok of ["a@b.co", "zsolt@barkoba.hu", "first.last+tag@example.com"]) {
    assert.equal(looksLikeEmail(ok), true, ok);
  }
  for (const bad of ["", "not-an-email", "a@b", "@b.co", "a@.co", "a b@c.co", "a".repeat(260) + "@c.co"]) {
    assert.equal(looksLikeEmail(bad), false, bad);
  }
});

test("generateVerificationToken produces distinct, well-shaped tokens", () => {
  const a = generateVerificationToken();
  const b = generateVerificationToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test("verificationTokenHash is deterministic and distinguishes different tokens", async () => {
  const token = generateVerificationToken();
  const h1 = await verificationTokenHash(token);
  const h2 = await verificationTokenHash(token);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.notEqual(h1, await verificationTokenHash(generateVerificationToken()));
});

// ---------------------------------------------------------------------------
// sendVerificationEmail — real Resend integration.
//
// The Resend SDK calls the ambient global `fetch` (confirmed by reading
// node_modules/resend/dist/index.mjs: no fetch import, no undici dependency),
// so intercepting it here is a faithful test of the real request, not a
// simulation of one.
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

const EMAIL_ENV_VARS = [
  "RESEND_API_KEY",
  "SITE_URL",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;
let savedEmailEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEmailEnv = Object.fromEntries(EMAIL_ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of EMAIL_ENV_VARS) delete process.env[k];
});

afterEach(() => {
  for (const k of EMAIL_ENV_VARS) {
    if (savedEmailEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEmailEnv[k];
  }
});

test("sendVerificationEmail reports sent:false and never calls fetch when RESEND_API_KEY is unset", async () => {
  const mock = mockFetch(() => {
    throw new Error("must not be called");
  });
  try {
    process.env.SITE_URL = "https://barkoba.example";
    const result = await sendVerificationEmail("zsolt@example.com", "sometoken");
    assert.equal(result.sent, false);
    assert.equal(
      result.verificationUrl,
      "https://barkoba.example/verify-email?token=sometoken"
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("sendVerificationEmail reports sent:false and never calls fetch when no site origin is resolvable", async () => {
  const mock = mockFetch(() => {
    throw new Error("must not be called");
  });
  try {
    process.env.RESEND_API_KEY = "re_test_key";
    const result = await sendVerificationEmail("zsolt@example.com", "sometoken");
    assert.equal(result.sent, false);
    assert.equal(result.verificationUrl, "/verify-email?token=sometoken");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("sendVerificationEmail calls Resend with the right request and reports the provider id on success", async () => {
  const mock = mockFetch(
    () =>
      new Response(JSON.stringify({ id: "email-id-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  );
  try {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.SITE_URL = "https://barkoba.example/";
    const result = await sendVerificationEmail("zsolt@example.com", "sometoken");

    assert.equal(result.sent, true);
    assert.equal(result.providerMessageId, "email-id-123");
    assert.equal(
      result.verificationUrl,
      "https://barkoba.example/verify-email?token=sometoken"
    );

    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0]!;
    assert.equal(call.url, "https://api.resend.com/emails");
    assert.equal(call.init?.method, "POST");
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer re_test_key");
    const body = JSON.parse(String(call.init?.body));
    assert.deepEqual(body.to, ["zsolt@example.com"]);
    assert.match(body.html, /sometoken/);
    assert.match(
      body.html,
      /https:\/\/barkoba\.example\/verify-email\?token=sometoken/
    );
  } finally {
    mock.restore();
  }
});

test("sendVerificationEmail reports sent:false, not a throw, when Resend refuses the send", async () => {
  const mock = mockFetch(
    () =>
      new Response(
        JSON.stringify({ name: "validation_error", message: "Invalid `to` field" }),
        { status: 422, headers: { "Content-Type": "application/json" } }
      )
  );
  try {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.SITE_URL = "https://barkoba.example";
    const result = await sendVerificationEmail("zsolt@example.com", "sometoken");
    assert.equal(result.sent, false);
    assert.equal(result.providerMessageId, undefined);
  } finally {
    mock.restore();
  }
});

test("sendVerificationEmail falls back to VERCEL_PROJECT_PRODUCTION_URL when SITE_URL is unset", async () => {
  const mock = mockFetch(
    () =>
      new Response(JSON.stringify({ id: "email-id-456" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  );
  try {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "barkoba.vercel.app";
    const result = await sendVerificationEmail("zsolt@example.com", "sometoken");
    assert.equal(result.sent, true);
    assert.equal(
      result.verificationUrl,
      "https://barkoba.vercel.app/verify-email?token=sometoken"
    );
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// registerPlayerAccount with email fields, and the two new lib functions.
// ---------------------------------------------------------------------------

test("registerPlayerAccount stores email and the token HASH, and leaves email_verified_at null", async () => {
  const playerId = "1".repeat(32);
  const rawToken = generateVerificationToken();
  const hash = await verificationTokenHash(rawToken);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString();

  const { account, created } = await registerPlayerAccount({
    playerId,
    recoveryKey: "a".repeat(64),
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: hash,
    emailVerificationExpiresAt: expiresAt,
  });

  assert.equal(created, true);
  assert.equal(account.email, "zsolt@example.com");
  assert.equal(account.email_verified_at, null);
  assert.equal(account.email_verification_token, hash);
  assert.notEqual(account.email_verification_token, rawToken, "the raw token must never be stored");
  assert.equal(account.email_verification_expires_at, expiresAt);
  assert.equal(account.photo_url, null);
});

test("registerPlayerAccount without email fields (the legacy-migration path) leaves all four columns null", async () => {
  const playerId = "2".repeat(32);
  const { account } = await registerPlayerAccount({
    playerId,
    recoveryKey: "b".repeat(64),
    displayName: "Legacy",
  });
  assert.equal(account.email, null);
  assert.equal(account.email_verified_at, null);
  assert.equal(account.email_verification_token, null);
  assert.equal(account.email_verification_expires_at, null);
});

// ---------------------------------------------------------------------------
// V2.6.x — migration 0011: email uniqueness.
// ---------------------------------------------------------------------------

test("registerPlayerAccount refuses a second account with the same email, case-insensitively", async () => {
  const firstId = "e".repeat(32);
  await registerPlayerAccount({
    playerId: firstId,
    recoveryKey: "e".repeat(64),
    displayName: "First",
    email: "zsolt@example.com",
    emailVerificationTokenHash: "e".repeat(64),
    emailVerificationExpiresAt: new Date().toISOString(),
  });

  const secondId = "f".repeat(32);
  await assert.rejects(
    () =>
      registerPlayerAccount({
        playerId: secondId,
        recoveryKey: "f".repeat(64),
        displayName: "Second",
        email: "ZSOLT@Example.com",
        emailVerificationTokenHash: "f".repeat(64),
        emailVerificationExpiresAt: new Date().toISOString(),
      }),
    (err: unknown) => err instanceof EmailAlreadyRegisteredError
  );

  // The rejected attempt must not have left any trace — no second row, and
  // the first account completely untouched.
  assert.equal(await getPlayerAccount(secondId), null);
  assert.equal((await getPlayerAccount(firstId))?.display_name, "First");
});

test("getPlayerAccountByEmail finds the right account case-insensitively, and nothing else", async () => {
  const mineId = "1".repeat(31) + "a";
  const otherId = "1".repeat(31) + "b";
  await registerPlayerAccount({
    playerId: mineId,
    recoveryKey: "1".repeat(63) + "a",
    displayName: "Mine",
    email: "mine@example.com",
    emailVerificationTokenHash: "a".repeat(64),
    emailVerificationExpiresAt: new Date().toISOString(),
  });
  await registerPlayerAccount({
    playerId: otherId,
    recoveryKey: "1".repeat(63) + "b",
    displayName: "Other",
    email: "other@example.com",
    emailVerificationTokenHash: "b".repeat(64),
    emailVerificationExpiresAt: new Date().toISOString(),
  });

  const found = await getPlayerAccountByEmail("Mine@Example.COM");
  assert.equal(found?.player_id, mineId);

  const unknown = await getPlayerAccountByEmail("nobody@example.com");
  assert.equal(unknown, null);
});

test("getPlayerAccountByVerificationTokenHash finds the right account and nothing else", async () => {
  const mineId = "3".repeat(32);
  const otherId = "4".repeat(32);
  const mineToken = await verificationTokenHash(generateVerificationToken());
  const otherToken = await verificationTokenHash(generateVerificationToken());
  await registerPlayerAccount({
    playerId: mineId,
    recoveryKey: "c".repeat(64),
    displayName: "Mine",
    email: "mine@example.com",
    emailVerificationTokenHash: mineToken,
    emailVerificationExpiresAt: new Date().toISOString(),
  });
  await registerPlayerAccount({
    playerId: otherId,
    recoveryKey: "d".repeat(64),
    displayName: "Other",
    email: "other@example.com",
    emailVerificationTokenHash: otherToken,
    emailVerificationExpiresAt: new Date().toISOString(),
  });

  const found = await getPlayerAccountByVerificationTokenHash(mineToken);
  assert.equal(found?.player_id, mineId);

  const unknown = await getPlayerAccountByVerificationTokenHash("0".repeat(64));
  assert.equal(unknown, null);
});

test("markEmailVerified is idempotent: a second call never moves the recorded timestamp", async () => {
  const playerId = "5".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "e".repeat(64),
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: "f".repeat(64),
    emailVerificationExpiresAt: new Date().toISOString(),
  });

  assert.equal(await markEmailVerified(playerId), true);
  const first = (await getPlayerAccount(playerId))!.email_verified_at;
  assert.ok(first);

  assert.equal(await markEmailVerified(playerId), true);
  const second = (await getPlayerAccount(playerId))!.email_verified_at;
  assert.equal(second, first);
});

test("markEmailVerified never touches the token or its expiry", async () => {
  const playerId = "6".repeat(32);
  const hash = "1".repeat(64);
  const expiresAt = new Date(Date.now() + 1000).toISOString();
  await registerPlayerAccount({
    playerId,
    recoveryKey: "6".repeat(64),
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: hash,
    emailVerificationExpiresAt: expiresAt,
  });

  await markEmailVerified(playerId);
  const after = await getPlayerAccount(playerId);
  assert.equal(after?.email_verification_token, hash);
  assert.equal(after?.email_verification_expires_at, expiresAt);
});

// ---------------------------------------------------------------------------
// GET /api/account/verify-email — READ-ONLY STATUS CHECK
//
// V2.7.x — split from a mutating GET specifically because email security
// scanners and link-prefetch systems fetch a link's URL automatically. When
// GET itself verified and rotated, a scanner could consume the newcomer's
// one-time recovery code before they ever saw the page. GET now only reads;
// see the POST block below for the actual mutating action.
// ---------------------------------------------------------------------------

test("verify-email GET refuses a missing token, without mutating anything", async () => {
  const response = await verifyEmailStatus(
    new Request("https://barkoba.test/api/account/verify-email")
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.status, "invalid");
});

test("verify-email GET refuses an unknown token", async () => {
  const response = await verifyEmailStatus(
    new Request("https://barkoba.test/api/account/verify-email?token=nope")
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.status, "invalid");
});

test("verify-email GET reports expired for an unverified token past its TTL, without mutating anything", async () => {
  const playerId = "7".repeat(32);
  const rawToken = generateVerificationToken();
  const hash = await verificationTokenHash(rawToken);
  const alreadyExpired = new Date(Date.now() - 1000).toISOString();
  await registerPlayerAccount({
    playerId,
    recoveryKey: "7".repeat(64),
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: hash,
    emailVerificationExpiresAt: alreadyExpired,
  });

  const response = await verifyEmailStatus(
    new Request(`https://barkoba.test/api/account/verify-email?token=${rawToken}`)
  );
  assert.equal(response.status, 410);
  const body = await response.json();
  assert.equal(body.status, "expired");
  assert.equal(accounts.get(playerId)!.email_verified_at, null);
});

test("verify-email GET reports pending for a fresh, unverified token — and never mutates, however many times it is called", async () => {
  const playerId = "9".repeat(32);
  const rawToken = generateVerificationToken();
  const hash = await verificationTokenHash(rawToken);
  const originalRecoveryKey = "9".repeat(64);
  await registerPlayerAccount({
    playerId,
    recoveryKey: originalRecoveryKey,
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: hash,
    emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString(),
  });

  // Simulates page load, a status re-check, AND a scanner/prefetcher hitting
  // the same URL — five reads in a row, none of them a click.
  for (let i = 0; i < 5; i += 1) {
    const response = await verifyEmailStatus(
      new Request(`https://barkoba.test/api/account/verify-email?token=${rawToken}`)
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "pending");
    assert.equal(body.email, "zsolt@example.com");
    // No verified/already_verified/recovery_code field ever appears on a
    // status response — GET is not the mutating contract's shape at all.
    assert.equal(body.recovery_code, undefined);
    assert.equal(body.verified, undefined);
  }

  assert.equal(accounts.get(playerId)!.email_verified_at, null, "GET must never verify");
  assert.equal(
    accounts.get(playerId)!.recovery_key,
    originalRecoveryKey,
    "GET must never rotate the recovery key"
  );
});

test("verify-email GET reports already_verified once verified, without a code, and independent of the token's own TTL", async () => {
  const playerId = "a".repeat(32);
  const rawToken = generateVerificationToken();
  const hash = await verificationTokenHash(rawToken);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "a".repeat(64),
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: hash,
    // Already past its TTL — must still read as already_verified, not
    // expired, because the account is already verified.
    emailVerificationExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  accounts.get(playerId)!.email_verified_at = new Date().toISOString();

  const response = await verifyEmailStatus(
    new Request(`https://barkoba.test/api/account/verify-email?token=${rawToken}`)
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "already_verified");
  assert.equal(body.recovery_code, undefined);
});

// ---------------------------------------------------------------------------
// POST /api/account/verify-email — the ONLY mutating path
// ---------------------------------------------------------------------------

test("verify-email POST refuses a missing or unknown token, same shapes as before", async () => {
  const missing = await confirmVerification(
    new Request("https://barkoba.test/api/account/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  );
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "missing_token");

  const unknown = await confirmVerification(
    new Request("https://barkoba.test/api/account/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "nope" }),
    })
  );
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, "invalid_token");
});

test("verify-email POST refuses an expired, unverified token and does not mark it verified", async () => {
  const playerId = "b".repeat(32);
  const rawToken = generateVerificationToken();
  const hash = await verificationTokenHash(rawToken);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "b".repeat(64),
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: hash,
    emailVerificationExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  const response = await confirmVerification(
    new Request("https://barkoba.test/api/account/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: rawToken }),
    })
  );
  assert.equal(response.status, 410);
  const body = await response.json();
  assert.equal(body.verified, false);
  assert.equal(body.error, "expired_token");
  assert.equal(accounts.get(playerId)!.email_verified_at, null);
});

test("verify-email POST verifies without touching the recovery key or issuing any code — repeats and races are safe", async () => {
  // V2.7.x M2 — production testing showed the recovery-code capture step
  // reintroduced exactly the friction this onboarding pass exists to remove.
  // Verification is now plain markEmailVerified(): no rotation, no code,
  // ever, on any POST — see app/api/account/verify-email/route.ts's own
  // header comment. Recovery capability lives on Profil instead, unchanged
  // and untested here (test/accountOwnership.test.ts already covers
  // rotate-recovery-code directly).
  const playerId = "8".repeat(32);
  const rawToken = generateVerificationToken();
  const hash = await verificationTokenHash(rawToken);
  const registrationTimeKey = "8".repeat(64);
  await registerPlayerAccount({
    playerId,
    recoveryKey: registrationTimeKey,
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: hash,
    emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString(),
  });

  const post = () =>
    confirmVerification(
      new Request("https://barkoba.test/api/account/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: rawToken }),
      })
    );

  // A read-only status GET immediately before the click must not disturb
  // anything the click is about to do.
  await verifyEmailStatus(
    new Request(`https://barkoba.test/api/account/verify-email?token=${rawToken}`)
  );

  const first = await post();
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.verified, true);
  assert.equal(firstBody.email, "zsolt@example.com");
  assert.equal(firstBody.already_verified, false);
  assert.equal(firstBody.recovery_code, undefined, "no code is ever generated any more");
  const firstTimestamp = accounts.get(playerId)!.email_verified_at;
  assert.ok(firstTimestamp);
  assert.equal(
    accounts.get(playerId)!.recovery_key,
    registrationTimeKey,
    "verification must not touch the recovery key at all"
  );

  // A status GET after the click reports already_verified.
  const statusAfter = await verifyEmailStatus(
    new Request(`https://barkoba.test/api/account/verify-email?token=${rawToken}`)
  );
  assert.equal((await statusAfter.json()).status, "already_verified");

  // A repeat/racing POST for the SAME token — must not verify "again" and
  // must never issue a code.
  const second = await post();
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.verified, true);
  assert.equal(secondBody.already_verified, true);
  assert.equal(secondBody.recovery_code, undefined);
  assert.equal(
    accounts.get(playerId)!.email_verified_at,
    firstTimestamp,
    "a second POST must not move the recorded verification moment"
  );
  assert.equal(
    accounts.get(playerId)!.recovery_key,
    registrationTimeKey,
    "a second POST must still not touch the recovery key"
  );
});

// ---------------------------------------------------------------------------
// V2.7.0.3 human-test fix — the +5 grant is EAGER now, not only lazy at
// game-creation. Production testing found the ledger genuinely empty right
// after verification, so the homepage read a real zero balance and an
// unclaimed introductory pool — not a display bug, an authoritative-state
// bug. ensureInitialComplimentary() is called synchronously inside the POST
// handler, before it responds, so this proves the LEDGER itself, not merely
// what a status endpoint would infer from it.
// ---------------------------------------------------------------------------

test("verify-email POST eagerly grants the +5 ledger row — repeat verification never duplicates it", async () => {
  process.env.ENTITLEMENT_COMPLIMENTARY_GRANT = "5";
  try {
    const playerId = "c".repeat(32);
    const rawToken = generateVerificationToken();
    const hash = await verificationTokenHash(rawToken);
    await registerPlayerAccount({
      playerId,
      recoveryKey: "c".repeat(64),
      displayName: "Zsolt",
      email: "zsolt-grant@example.com",
      emailVerificationTokenHash: hash,
      emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString(),
    });

    // Nothing granted yet — the ledger is genuinely empty before verification,
    // matching production's actual pre-fix state.
    assert.equal(ledger.filter((r) => r.player_id === playerId).length, 0);

    const post = () =>
      confirmVerification(
        new Request("https://barkoba.test/api/account/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: rawToken }),
        })
      );

    const first = await post();
    assert.equal(first.status, 200);
    assert.equal((await first.json()).verified, true);

    // The LEDGER, not a display computation, now holds the grant.
    const grantRows = ledger.filter(
      (r) => r.player_id === playerId && r.grant_key === "initial_complimentary"
    );
    assert.equal(grantRows.length, 1, "exactly one initial_complimentary row must exist");
    assert.equal(grantRows[0]!.amount, 5);
    const balance = ledger
      .filter((r) => r.player_id === playerId)
      .reduce((n, r) => n + r.amount, 0);
    assert.equal(balance, 5, "the account's real balance must be 5 immediately after verification");

    // A repeat POST (already verified) must not reach the grant call a
    // second time — and even if it somehow did, grant_key uniqueness would
    // still refuse a duplicate.
    const second = await post();
    assert.equal((await second.json()).already_verified, true);
    assert.equal(
      ledger.filter((r) => r.player_id === playerId && r.grant_key === "initial_complimentary").length,
      1,
      "a repeat verification must not grant a second time"
    );
    assert.equal(
      ledger.filter((r) => r.player_id === playerId).reduce((n, r) => n + r.amount, 0),
      5,
      "balance must still be exactly 5 after the repeat POST"
    );
  } finally {
    delete process.env.ENTITLEMENT_COMPLIMENTARY_GRANT;
  }
});

test("GET /api/player/entitlement reports 5/has_balance immediately after verification, and 4 after spending one", async () => {
  process.env.ENTITLEMENT_COMPLIMENTARY_GRANT = "5";
  try {
    const playerId = "d".repeat(32);
    const rawToken = generateVerificationToken();
    const hash = await verificationTokenHash(rawToken);
    await registerPlayerAccount({
      playerId,
      recoveryKey: "d".repeat(64),
      displayName: "Zsolt",
      email: "zsolt-status@example.com",
      emailVerificationTokenHash: hash,
      emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString(),
    });
    const sessionToken = await createAccountSession(playerId);
    const readStatus = () =>
      readEntitlement(
        new Request("https://barkoba.test/api/player/entitlement", {
          headers: { cookie: `bk_account_session=${sessionToken}` },
        }) as Parameters<typeof readEntitlement>[0]
      );

    // Before verification: the introductory pool is not yet claimable.
    const before = await readStatus();
    assert.equal((await before.json()).play_state, "exhausted");

    await confirmVerification(
      new Request("https://barkoba.test/api/account/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: rawToken }),
      })
    );

    // Immediately after — no game played, no separate "claim" step.
    const after = await readStatus();
    assert.equal(after.status, 200);
    const afterBody = await after.json();
    assert.equal(afterBody.play_state, "has_balance", "the homepage must see a REAL balance, not an eligibility flag");
    assert.equal(afterBody.balance, 5);

    // One game consumed (flat 1 credit/game, matching the frozen rule) —
    // the anonymous pool is untouched since this player_id never had one.
    ledger.push({ player_id: playerId, amount: -1, grant_key: null });
    const afterPlay = await readStatus();
    const afterPlayBody = await afterPlay.json();
    assert.equal(afterPlayBody.play_state, "has_balance");
    assert.equal(afterPlayBody.balance, 4);
    assert.equal(
      ledger.filter((r) => r.player_id === playerId && r.grant_key === "anonymous_first_game").length,
      0,
      "the separate anonymous pool must remain untouched for an account that never had one"
    );
  } finally {
    delete process.env.ENTITLEMENT_COMPLIMENTARY_GRANT;
  }
});

test("the eager +5 grant stays separate from an earlier anonymous grant on the SAME player_id — never merged", async () => {
  process.env.ENTITLEMENT_COMPLIMENTARY_GRANT = "5";
  try {
    const playerId = "e".repeat(32);
    // Simulates having played the anonymous complimentary game as a guest,
    // BEFORE registering — the same player_id carries forward, per
    // ensureAnonymousComplimentary's own contract.
    ledger.push({ player_id: playerId, amount: 1, grant_key: "anonymous_first_game" });
    ledger.push({ player_id: playerId, amount: -1, grant_key: null });

    const rawToken = generateVerificationToken();
    const hash = await verificationTokenHash(rawToken);
    await registerPlayerAccount({
      playerId,
      recoveryKey: "e".repeat(64),
      displayName: "Zsolt",
      email: "zsolt-anon@example.com",
      emailVerificationTokenHash: hash,
      emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString(),
    });

    await confirmVerification(
      new Request("https://barkoba.test/api/account/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: rawToken }),
      })
    );

    const mine = ledger.filter((r) => r.player_id === playerId);
    const anonymousRows = mine.filter((r) => r.grant_key === "anonymous_first_game");
    const initialRows = mine.filter((r) => r.grant_key === "initial_complimentary");
    assert.equal(anonymousRows.length, 1, "the earlier anonymous grant row must survive untouched");
    assert.equal(anonymousRows[0]!.amount, 1);
    assert.equal(initialRows.length, 1, "a separate, distinctly-keyed row for the verified grant");
    assert.equal(initialRows[0]!.amount, 5);
    assert.equal(
      mine.reduce((n, r) => n + r.amount, 0),
      5,
      "1 (anonymous) - 1 (spent) + 5 (verified) = 5"
    );
  } finally {
    delete process.env.ENTITLEMENT_COMPLIMENTARY_GRANT;
  }
});

// ---------------------------------------------------------------------------
// V2.7.0.4 production-test fix — POST /api/account/verify-email now
// authenticates the VERIFYING browser, not just the ledger. Every scenario
// below calls the route with headers modeling a specific browser's actual
// cookie state — never assuming an account session already exists, since
// that assumption is exactly what broke cross-device/cross-browser
// verification in production.
// ---------------------------------------------------------------------------

function sessionCookieFrom(res: Response): string | null {
  const header = res.headers.get("set-cookie") ?? "";
  return header.match(/bk_account_session=([^;]+)/)?.[1] ?? null;
}

async function registerVerifiableAccount(playerId: string, email: string) {
  const rawToken = generateVerificationToken();
  const hash = await verificationTokenHash(rawToken);
  await registerPlayerAccount({
    playerId,
    recoveryKey: playerId.slice(0, 32).padEnd(64, "0"),
    displayName: "Zsolt",
    email,
    emailVerificationTokenHash: hash,
    emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString(),
  });
  return rawToken;
}

test("A. same-browser verification (registration's own device cookie present) still authenticates and grants", async () => {
  process.env.ENTITLEMENT_COMPLIMENTARY_GRANT = "5";
  try {
    const playerId = "1a".padEnd(32, "0");
    const rawToken = await registerVerifiableAccount(playerId, "same-browser@example.com");

    const res = await confirmVerification(
      new Request("https://barkoba.test/api/account/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", [PLAYER_HEADER]: playerId },
        body: JSON.stringify({ token: rawToken }),
      })
    );
    assert.equal(res.status, 200);
    const cookie = sessionCookieFrom(res);
    assert.ok(cookie, "same-browser verification must still establish a session");
    assert.equal(await resolveAccountSession(cookie), playerId);
    assert.equal(accounts.size, 1, "no second account/player was created");
  } finally {
    delete process.env.ENTITLEMENT_COMPLIMENTARY_GRANT;
  }
});

test("B. CROSS-BROWSER: verification with NO original session/guest cookie still authenticates player A", async () => {
  process.env.ENTITLEMENT_COMPLIMENTARY_GRANT = "5";
  try {
    const playerId = "1b".padEnd(32, "0");
    const rawToken = await registerVerifiableAccount(playerId, "cross-browser@example.com");

    // The verifying request carries NEITHER an account session NOR any
    // bk_player header at all — a genuinely fresh browser (iPhone Safari,
    // a different device), exactly the reported production scenario.
    const res = await confirmVerification(
      new Request("https://barkoba.test/api/account/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: rawToken }),
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verified, true);

    const cookie = sessionCookieFrom(res);
    assert.ok(cookie, "verification from a brand-new browser must still establish a session");
    const resolvedPlayerId = await resolveAccountSession(cookie);
    assert.equal(resolvedPlayerId, playerId, "the session must resolve to the SAME registered player A");
    assert.equal(accounts.size, 1, "no second player/account was created for the verifying browser");

    // The now-authenticated browser reads its own real balance.
    const status = await readEntitlement(
      new Request("https://barkoba.test/api/player/entitlement", {
        headers: { cookie: `bk_account_session=${cookie}` },
      }) as Parameters<typeof readEntitlement>[0]
    );
    const statusBody = await status.json();
    assert.equal(statusBody.play_state, "has_balance");
    assert.equal(statusBody.balance, 5);
  } finally {
    delete process.env.ENTITLEMENT_COMPLIMENTARY_GRANT;
  }
});

test("C. verification from a browser carrying an UNRELATED guest identity does not merge or transfer it", async () => {
  process.env.ENTITLEMENT_COMPLIMENTARY_GRANT = "5";
  try {
    const playerA = "1c".padEnd(32, "0");
    const guestB = "9c".padEnd(32, "0");
    const rawToken = await registerVerifiableAccount(playerA, "unrelated-guest@example.com");

    // B has its own, unrelated history/credits — never registered, never
    // connected to A in any way.
    ledger.push({ player_id: guestB, amount: 3, grant_key: "anonymous_first_game" });

    const res = await confirmVerification(
      new Request("https://barkoba.test/api/account/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", [PLAYER_HEADER]: guestB },
        body: JSON.stringify({ token: rawToken }),
      })
    );
    assert.equal(res.status, 200);

    const cookie = sessionCookieFrom(res);
    assert.equal(await resolveAccountSession(cookie), playerA, "the session authenticates A, not B");

    // B's own cookie/identity must be left completely alone — the fake
    // records this as "no bk_player cookie set in the response", since B
    // does not equal the verified player_id.
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    assert.doesNotMatch(setCookieHeader, /bk_player=/, "an unrelated guest's device cookie must not be rewritten");

    // B's own ledger rows are untouched and never attached to A.
    assert.equal(
      ledger.filter((r) => r.player_id === guestB).length,
      1,
      "B's own history is untouched"
    );
    assert.equal(
      ledger.filter((r) => r.player_id === playerA && r.grant_key === "anonymous_first_game").length,
      0,
      "none of B's credits were transferred onto A"
    );
    assert.equal(
      ledger.filter((r) => r.player_id === playerA).reduce((n, r) => n + r.amount, 0),
      5,
      "A's balance is exactly its OWN +5 grant, nothing from B"
    );
    assert.equal(accounts.size, 1, "B never became a second account");
  } finally {
    delete process.env.ENTITLEMENT_COMPLIMENTARY_GRANT;
  }
});

test("D. repeat verification (any browser) re-authenticates without duplicating the grant or the account", async () => {
  process.env.ENTITLEMENT_COMPLIMENTARY_GRANT = "5";
  try {
    const playerId = "1d".padEnd(32, "0");
    const rawToken = await registerVerifiableAccount(playerId, "repeat-cross-browser@example.com");

    const post = () =>
      confirmVerification(
        new Request("https://barkoba.test/api/account/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: rawToken }),
        })
      );

    const first = await post();
    const firstCookie = sessionCookieFrom(first);
    assert.ok(firstCookie);
    assert.equal(await resolveAccountSession(firstCookie), playerId);

    // A SECOND browser (still no original cookies) clicks the same link.
    const second = await post();
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.already_verified, true);
    const secondCookie = sessionCookieFrom(second);
    assert.ok(secondCookie, "a repeat/second-browser click must still authenticate that browser");
    assert.equal(await resolveAccountSession(secondCookie), playerId, "still the SAME existing account");

    assert.equal(accounts.size, 1, "no second account was ever created");
    assert.equal(
      ledger.filter((r) => r.player_id === playerId && r.grant_key === "initial_complimentary").length,
      1,
      "the +5 grant was not duplicated by the second authentication"
    );
    assert.equal(
      ledger.filter((r) => r.player_id === playerId).reduce((n, r) => n + r.amount, 0),
      5
    );
  } finally {
    delete process.env.ENTITLEMENT_COMPLIMENTARY_GRANT;
  }
});

// ---------------------------------------------------------------------------
// register/route.ts wiring — structural, matching this suite's existing
// convention for the routes cookies() keeps this harness from calling directly.
// ---------------------------------------------------------------------------

test("register/route.ts is wired to validate, store and (non-fatally) send the verification email", () => {
  const source = readFileSync("app/api/account/register/route.ts", "utf8");
  assert.match(source, /looksLikeEmail\(email\)/);
  assert.match(source, /invalid_email/);
  assert.match(source, /generateVerificationToken/);
  assert.match(source, /verificationTokenHash/);
  assert.match(source, /emailVerificationTokenHash/);
  assert.match(source, /emailVerificationExpiresAt/);
  assert.match(source, /sendVerificationEmail\(email, verificationToken\)/);

  // Account creation must happen BEFORE the send is attempted, so a stub (or
  // future real provider) failure can never prevent the account from existing.
  const registerCallAt = source.indexOf("await registerPlayerAccount({");
  const sendCallAt = source.indexOf("sendVerificationEmail(email, verificationToken)");
  assert.ok(registerCallAt > 0 && sendCallAt > registerCallAt);

  // And the send's own catch block must not be able to fail the request: no
  // `return` between the send call and the next unrelated statement.
  const nextMilestone = source.indexOf("const secure =", sendCallAt);
  const sendRegion = source.slice(sendCallAt, nextMilestone);
  assert.match(sendRegion, /catch/, "the send must be wrapped in its own try/catch");
  assert.doesNotMatch(
    sendRegion,
    /return/,
    "a failed send must fall through to registration's normal success response, not return early"
  );
});

test("register/route.ts surfaces a duplicate email as its own distinct outcome", () => {
  const source = readFileSync("app/api/account/register/route.ts", "utf8");
  assert.match(source, /EmailAlreadyRegisteredError/);
  assert.match(source, /email_already_registered/);
  assert.match(source, /err instanceof EmailAlreadyRegisteredError/);
});

// ---------------------------------------------------------------------------
// V2.7 — a playing name is required at registration, not merely optional
// pass-through from NamePrompt's separate, freely skippable cookie.
// ---------------------------------------------------------------------------

test("register/route.ts refuses registration with no name from either the body or the cookie", () => {
  const source = readFileSync("app/api/account/register/route.ts", "utf8");
  assert.match(source, /missing_name/);
  assert.match(source, /sanitizePlayerName\(typeof body\.name === "string" \? body\.name : ""\)/);
  // Body name wins; the cookie is a fallback, not the only source — checked
  // via the `||` chain, and the refusal must happen before any account is
  // ever created.
  assert.match(
    source,
    /const displayName =\s*\n\s*sanitizePlayerName\([^)]*\) \|\| nameState\.name \|\| "";/
  );
  const missingNameAt = source.indexOf("missing_name");
  const registerCallAt = source.indexOf("await registerPlayerAccount({");
  assert.ok(missingNameAt > 0 && registerCallAt > missingNameAt);
});

test("register/route.ts's GET handler exposes the current name so the form can prefill it", () => {
  const source = readFileSync("app/api/account/register/route.ts", "utf8");
  const getHandler = source.slice(
    source.indexOf("export async function GET"),
    source.indexOf("export async function POST")
  );
  assert.match(getHandler, /readPlayerName/);
  assert.match(getHandler, /name: nameState\.name/);
});

test("ClaimPrompt's registration form collects and requires a name alongside email", () => {
  const source = readFileSync("app/components/ClaimPrompt.tsx", "utf8");
  assert.match(source, /body: JSON\.stringify\(\{ email: email\.trim\(\), name: name\.trim\(\) \}\)/);
  assert.match(source, /disabled=\{busy \|\| !email\.trim\(\) \|\| !name\.trim\(\)\}/);
  // Prefilled from the GET response, but still just a starting value — the
  // player can still clear and change it.
  assert.match(source, /if \(typeof data\.name === "string" && data\.name\) setName\(data\.name\);/);
});

// ---------------------------------------------------------------------------
// setAccountEmail — the reachable-any-time add/change path.
// ---------------------------------------------------------------------------

test("setAccountEmail changes the address and resets verification, leaving other columns untouched", async () => {
  const playerId = "9".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "9".repeat(64),
    displayName: "Zsolt",
    email: "old@example.com",
    emailVerificationTokenHash: "a".repeat(64),
    emailVerificationExpiresAt: new Date().toISOString(),
  });
  await markEmailVerified(playerId);
  const before = await getPlayerAccount(playerId);
  assert.equal(before?.email_verified_at !== null, true, "precondition: the old address was verified");

  const newHash = "b".repeat(64);
  const newExpiry = new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString();
  assert.equal(await setAccountEmail(playerId, "new@example.com", newHash, newExpiry), true);

  const after = await getPlayerAccount(playerId);
  assert.equal(after?.email, "new@example.com");
  assert.equal(after?.email_verified_at, null, "a changed address must go back to unverified");
  assert.equal(after?.email_verification_token, newHash);
  assert.equal(after?.email_verification_expires_at, newExpiry);
  assert.equal(after?.display_name, "Zsolt", "unrelated columns must be untouched");
  assert.equal(after?.recovery_key, before?.recovery_key, "unrelated columns must be untouched");
});

test("setAccountEmail refuses a disabled or nonexistent account", async () => {
  assert.equal(
    await setAccountEmail("0".repeat(32), "x@example.com", "c".repeat(64), new Date().toISOString()),
    false
  );
});

test("setAccountEmail refuses to move an address onto a DIFFERENT account, case-insensitively", async () => {
  const ownerId = "2".repeat(31) + "a";
  const otherId = "2".repeat(31) + "b";
  await registerPlayerAccount({
    playerId: ownerId,
    recoveryKey: "2".repeat(63) + "a",
    displayName: "Owner",
    email: "owner@example.com",
    emailVerificationTokenHash: "a".repeat(64),
    emailVerificationExpiresAt: new Date().toISOString(),
  });
  await registerPlayerAccount({
    playerId: otherId,
    recoveryKey: "2".repeat(63) + "b",
    displayName: "Other",
  });

  await assert.rejects(
    () =>
      setAccountEmail(otherId, "Owner@Example.com", "b".repeat(64), new Date().toISOString()),
    (err: unknown) => err instanceof EmailAlreadyRegisteredError
  );
  assert.equal((await getPlayerAccount(otherId))?.email, null, "the rejected change must not apply");
});

test("setAccountEmail allows re-saving the SAME email the account already has — not a conflict with itself", async () => {
  const playerId = "3".repeat(31) + "a";
  await registerPlayerAccount({
    playerId,
    recoveryKey: "3".repeat(63) + "a",
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: "a".repeat(64),
    emailVerificationExpiresAt: new Date().toISOString(),
  });

  const newHash = "b".repeat(64);
  const newExpiry = new Date(Date.now() + 1000).toISOString();
  assert.equal(await setAccountEmail(playerId, "zsolt@example.com", newHash, newExpiry), true);
  assert.equal((await getPlayerAccount(playerId))?.email_verification_token, newHash);
});

// ---------------------------------------------------------------------------
// POST /api/account/email
// ---------------------------------------------------------------------------

async function registeredSession(playerId: string, email?: string): Promise<string> {
  await registerPlayerAccount({
    playerId,
    recoveryKey: `${playerId}-key`.padEnd(64, "0"),
    displayName: "Zsolt",
    email,
  });
  return createAccountSession(playerId);
}

test("POST /api/account/email refuses a caller without an active session", async () => {
  const guestResponse = await updateEmail(
    new Request("https://barkoba.test/api/account/email", {
      method: "POST",
      headers: { [PLAYER_HEADER]: "1".repeat(32) },
      body: JSON.stringify({ email: "x@example.com" }),
    })
  );
  assert.equal(guestResponse.status, 401);

  const playerId = "2".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "2".repeat(64), displayName: "Zsolt" });
  const registeredNoSessionResponse = await updateEmail(
    new Request("https://barkoba.test/api/account/email", {
      method: "POST",
      headers: { [PLAYER_HEADER]: playerId },
      body: JSON.stringify({ email: "x@example.com" }),
    })
  );
  assert.equal(registeredNoSessionResponse.status, 401);
});

test("POST /api/account/email refuses an implausible address without touching the account", async () => {
  const playerId = "3".repeat(32);
  const token = await registeredSession(playerId, "old@example.com");
  const response = await updateEmail(
    new Request("https://barkoba.test/api/account/email", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    })
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_email");
  assert.equal((await getPlayerAccount(playerId))?.email, "old@example.com");
});

test("POST /api/account/email changes exactly the caller's own account and reports the new address", async () => {
  const playerId = "4".repeat(32);
  const other = "5".repeat(32);
  const token = await registeredSession(playerId, "old@example.com");
  await registerPlayerAccount({ playerId: other, recoveryKey: "o".repeat(64), displayName: "Other", email: "other@example.com" });

  const response = await updateEmail(
    new Request("https://barkoba.test/api/account/email", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.com" }),
    })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.email, "new@example.com");
  assert.equal(typeof body.email_verification_sent, "boolean");

  assert.equal((await getPlayerAccount(playerId))?.email, "new@example.com");
  assert.equal(
    (await getPlayerAccount(other))?.email,
    "other@example.com",
    "another account's email must be untouched"
  );
});

test("POST /api/account/email refuses a colliding address with a GENERIC response — no account-existence wording, zero mutation", async () => {
  // V2.7.x review — this used to say "email_already_registered" / "Ez az
  // e-mail cím már regisztrálva van egy másik fiókhoz.", which lets an
  // authenticated caller use this endpoint as an oracle for whether ANY
  // address belongs to someone else. Reviewed and changed: the status may
  // still distinguish success from refusal, but the body must not.
  const playerId = "6".repeat(32);
  const other = "7".repeat(32);
  const token = await registeredSession(playerId, "mine@example.com");
  await registerPlayerAccount({
    playerId: other,
    recoveryKey: "o".repeat(64),
    displayName: "Other",
    email: "taken@example.com",
  });

  const response = await updateEmail(
    new Request("https://barkoba.test/api/account/email", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Taken@Example.com" }),
    })
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, "email_unavailable");
  assert.doesNotMatch(
    JSON.stringify(body),
    /already|regisztrálva|másik fiók/i,
    "the response must not reveal that the address belongs to another account"
  );

  // Zero mutation on collision — neither account's row changed at all.
  const mine = await getPlayerAccount(playerId);
  assert.equal(mine?.email, "mine@example.com", "the rejected change must not apply");
  assert.equal(mine?.email_verified_at, null);
  const theirs = await getPlayerAccount(other);
  assert.equal(theirs?.email, "taken@example.com", "the other account is untouched too");
});

test("POST /api/account/email: per-IP bucket eventually throttles, with the SAME generic response as success/collision paths", async () => {
  const playerId = "8".repeat(32);
  const token = await registeredSession(playerId, "limiter-ip@example.com");
  const ip = "203.0.113.5";

  let lastStatus = 0;
  let lastBody: unknown;
  for (let i = 0; i < 11; i += 1) {
    const res = await updateEmail(
      new Request("https://barkoba.test/api/account/email", {
        method: "POST",
        headers: {
          cookie: `bk_account_session=${token}`,
          "Content-Type": "application/json",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ email: `ip-limit-${i}@example.com` }),
      })
    );
    lastStatus = res.status;
    lastBody = await res.json();
  }
  assert.equal(lastStatus, 429);
  assert.equal((lastBody as { error: string }).error, "rate_limited");
  assert.doesNotMatch(
    JSON.stringify(lastBody),
    /already|regisztrálva|másik fiók|ip-limit-10/i,
    "a rate-limited response must not echo the attempted address or hint at existence"
  );
});

test("POST /api/account/email: per-target-email bucket throttles across ROTATING IPs for the SAME address", async () => {
  const playerId = "9".repeat(32);
  const token = await registeredSession(playerId, "limiter-target@example.com");
  const targetEmail = "same-victim-target@example.com";

  let lastStatus = 0;
  for (let i = 0; i < 11; i += 1) {
    const res = await updateEmail(
      new Request("https://barkoba.test/api/account/email", {
        method: "POST",
        headers: {
          cookie: `bk_account_session=${token}`,
          "Content-Type": "application/json",
          // A different IP every call — if only the IP bucket existed, this
          // would never throttle, since no single IP is reused.
          "x-forwarded-for": `198.51.100.${i}`,
        },
        body: JSON.stringify({ email: targetEmail }),
      })
    );
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429, "the target-email bucket must throttle even though every call used a distinct IP");
});

test("lib/rateLimit.ts: the email-change target bucket hashes before keying, and never uses the raw address", () => {
  const src = readFileSync("lib/rateLimit.ts", "utf8");
  const fn = src.slice(
    src.indexOf("export async function checkEmailChangeTargetRateLimit"),
    src.length
  );
  assert.match(fn, /verificationTokenHash\(normalized\)/);
  assert.match(fn, /ratelimit:email-change-target:\$\{hash\}/);
  assert.doesNotMatch(fn, /email-change-target:\$\{normalized\}|email-change-target:\$\{email\}/);
});

test("end-to-end: correcting an unverified email invalidates the OLD link; the NEW link authenticates the SAME account and grants +5 exactly once, cross-browser", async () => {
  process.env.ENTITLEMENT_COMPLIMENTARY_GRANT = "5";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.SITE_URL = "https://barkoba.example";
  const realFetchForThisTest = globalThis.fetch;
  try {
    const playerId = "aa".padEnd(32, "0");
    const oldToken = await registerVerifiableAccount(playerId, "typo@exmaple.com");
    const session = await createAccountSession(playerId);

    // Capture the NEW token the way it actually leaves the system: in the
    // real verification email's own link, exactly as Resend would receive
    // it — not a token this test invents.
    let capturedHtml = "";
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      capturedHtml = body.html ?? "";
      return new Response(JSON.stringify({ id: "email-id-correction" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    // The player notices the typo and corrects it from the
    // pending-verification screen's own affordance.
    const correctRes = await updateEmail(
      new Request("https://barkoba.test/api/account/email", {
        method: "POST",
        headers: { cookie: `bk_account_session=${session}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "corrected@example.com" }),
      })
    );
    assert.equal(correctRes.status, 200);
    assert.equal((await correctRes.json()).email, "corrected@example.com");
    assert.equal(accounts.get(playerId)!.email_verified_at, null, "still unverified after the correction");
    assert.equal(
      accounts.get(playerId)!.recovery_key,
      playerId.slice(0, 32).padEnd(64, "0"),
      "recovery_key untouched by an email correction"
    );

    // The OLD link (pre-correction token) must no longer resolve — scanner-
    // safe GET, still read-only, still correctly reports it as gone.
    const oldStatus = await verifyEmailStatus(
      new Request(`https://barkoba.test/api/account/verify-email?token=${oldToken}`)
    );
    assert.equal(oldStatus.status, 404);
    assert.equal((await oldStatus.json()).status, "invalid");

    const newTokenMatch = capturedHtml.match(/token=([0-9a-f]+)/);
    assert.ok(newTokenMatch, "the corrected address must have received its own real verification link");
    const newToken = newTokenMatch![1]!;
    assert.notEqual(newToken, oldToken, "the new token is not a reuse of the old one");

    // GET on the new link is still read-only (no mutation from a status check).
    const newStatus = await verifyEmailStatus(
      new Request(`https://barkoba.test/api/account/verify-email?token=${newToken}`)
    );
    assert.equal((await newStatus.json()).status, "pending");
    assert.equal(accounts.get(playerId)!.email_verified_at, null, "GET must not verify");

    // Explicit POST, from a browser with NO prior session — the exact
    // cross-browser scenario the previous review's fix covers, now proven
    // for a CORRECTED address too.
    const confirmRes = await confirmVerification(
      new Request("https://barkoba.test/api/account/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: newToken }),
      })
    );
    assert.equal(confirmRes.status, 200);
    const confirmBody = await confirmRes.json();
    assert.equal(confirmBody.verified, true);
    assert.equal(confirmBody.email, "corrected@example.com");

    const cookieHeader = confirmRes.headers.get("set-cookie") ?? "";
    const sessionMatch = cookieHeader.match(/bk_account_session=([^;]+)/);
    assert.ok(sessionMatch, "verifying the corrected address must still establish a session");
    assert.equal(
      await resolveAccountSession(sessionMatch![1]!),
      playerId,
      "the SAME existing player_id, not a new account"
    );

    // Exactly one +5 grant, tied to this one player_id.
    const grantRows = ledger.filter(
      (r) => r.player_id === playerId && r.grant_key === "initial_complimentary"
    );
    assert.equal(grantRows.length, 1);
    assert.equal(grantRows[0]!.amount, 5);
    assert.equal(accounts.size, 1, "no second account was ever created by the correction");
  } finally {
    delete process.env.ENTITLEMENT_COMPLIMENTARY_GRANT;
    delete process.env.RESEND_API_KEY;
    delete process.env.SITE_URL;
    globalThis.fetch = realFetchForThisTest;
  }
});

// ---------------------------------------------------------------------------
// GET /api/account/profile
// ---------------------------------------------------------------------------

test("GET /api/account/profile refuses a caller without an active session", async () => {
  const response = await readProfile(
    new Request("https://barkoba.test/api/account/profile", {
      headers: { [PLAYER_HEADER]: "6".repeat(32) },
    })
  );
  assert.equal(response.status, 401);
});

test("GET /api/account/profile reports display name, email, verification status and photo — nothing else", async () => {
  const playerId = "7".repeat(32);
  const token = await registeredSession(playerId, "zsolt@example.com");
  const response = await readProfile(
    new Request("https://barkoba.test/api/account/profile", {
      headers: { cookie: `bk_account_session=${token}` },
    })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    display_name: "Zsolt",
    email: "zsolt@example.com",
    email_verified: false,
    photo_url: null,
  });

  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /recovery|session_hash|verification_token/i);
});

test("GET /api/account/profile reports email_verified:true once the address has been verified", async () => {
  const playerId = "8".repeat(32);
  const token = await registeredSession(playerId, "zsolt@example.com");
  await markEmailVerified(playerId);

  const response = await readProfile(
    new Request("https://barkoba.test/api/account/profile", {
      headers: { cookie: `bk_account_session=${token}` },
    })
  );
  const body = await response.json();
  assert.equal(body.email_verified, true);
});
