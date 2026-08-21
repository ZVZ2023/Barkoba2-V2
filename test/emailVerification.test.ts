import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import {
  registerPlayerAccount,
  getPlayerAccount,
  getPlayerAccountByVerificationTokenHash,
  markEmailVerified,
} from "../lib/playerAccounts";
import {
  EMAIL_VERIFICATION_TTL_SECONDS,
  generateVerificationToken,
  looksLikeEmail,
  sendVerificationEmail,
  verificationTokenHash,
} from "../lib/emailVerification";
import { GET as verifyEmail } from "../app/api/account/verify-email/route";

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

let accounts: Map<string, AccountRow>;

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const query = strings.join(" ");
  const v = values as unknown[];

  if (/INSERT INTO accounts\.players/.test(query)) {
    const playerId = String(v[0]);
    if (accounts.has(playerId)) return Promise.resolve([]);
    const row: AccountRow = {
      player_id: playerId,
      recovery_key: String(v[1]),
      display_name: typeof v[2] === "string" ? v[2] : null,
      created_at: String(v[3]),
      registered_at: new Date().toISOString(),
      disabled_at: null,
      email: typeof v[4] === "string" ? v[4] : null,
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
      "https://barkoba.example/api/account/verify-email?token=sometoken"
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
    assert.equal(result.verificationUrl, "/api/account/verify-email?token=sometoken");
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
      "https://barkoba.example/api/account/verify-email?token=sometoken"
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
      /https:\/\/barkoba\.example\/api\/account\/verify-email\?token=sometoken/
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
      "https://barkoba.vercel.app/api/account/verify-email?token=sometoken"
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
// GET /api/account/verify-email
// ---------------------------------------------------------------------------

test("verify-email refuses a missing token", async () => {
  const response = await verifyEmail(
    new Request("https://barkoba.test/api/account/verify-email")
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.verified, false);
  assert.equal(body.error, "missing_token");
});

test("verify-email refuses an unknown token", async () => {
  const response = await verifyEmail(
    new Request("https://barkoba.test/api/account/verify-email?token=nope")
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.verified, false);
  assert.equal(body.error, "invalid_token");
});

test("verify-email refuses an expired token and does not mark it verified", async () => {
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

  const response = await verifyEmail(
    new Request(`https://barkoba.test/api/account/verify-email?token=${rawToken}`)
  );
  assert.equal(response.status, 410);
  const body = await response.json();
  assert.equal(body.verified, false);
  assert.equal(body.error, "expired_token");
  assert.equal(accounts.get(playerId)!.email_verified_at, null);
});

test("verify-email marks the email verified for a valid token, and a second visit is a harmless no-op", async () => {
  const playerId = "8".repeat(32);
  const rawToken = generateVerificationToken();
  const hash = await verificationTokenHash(rawToken);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "8".repeat(64),
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: hash,
    emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString(),
  });

  const first = await verifyEmail(
    new Request(`https://barkoba.test/api/account/verify-email?token=${rawToken}`)
  );
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.verified, true);
  assert.equal(firstBody.email, "zsolt@example.com");
  const firstTimestamp = accounts.get(playerId)!.email_verified_at;
  assert.ok(firstTimestamp);

  const second = await verifyEmail(
    new Request(`https://barkoba.test/api/account/verify-email?token=${rawToken}`)
  );
  assert.equal(second.status, 200);
  assert.equal((await second.json()).verified, true);
  assert.equal(
    accounts.get(playerId)!.email_verified_at,
    firstTimestamp,
    "a second visit must not move the recorded verification moment"
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
