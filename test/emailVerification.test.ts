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
import { createAccountSession } from "../lib/accountSession";
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

let accounts: Map<string, AccountRow>;
let sessions: Map<string, SessionRow>;

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

  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

beforeEach(() => {
  accounts = new Map();
  sessions = new Map();
  process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CORPUS_ENABLED;
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

test("POST /api/account/email refuses an address already registered to a different account", async () => {
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
  assert.equal(body.error, "email_already_registered");
  assert.equal((await getPlayerAccount(playerId))?.email, "mine@example.com", "the rejected change must not apply");
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
