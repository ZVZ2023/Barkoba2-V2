import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { notifyOwnerOfNewSignup, notifyOwnerOfVerifiedSignup } from "../lib/ownerNotifications";
import { getAccountTotals, rangeSince } from "../lib/adminOverview";
import { createAccountSession } from "../lib/accountSession";
import { registerPlayerAccount } from "../lib/playerAccounts";
import { env } from "../lib/env";
import { isAdminPlayer } from "../lib/admin";
import { POST as verifyEmailPOST } from "../app/api/account/verify-email/route";
import { GET as adminOverviewGET } from "../app/api/admin/overview/route";

process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";

// ---------------------------------------------------------------------------
// V2.9.2 — owner monitoring: signup email alerts + the admin overview.
//
// Mirrors test/emailVerification.test.ts's own established idiom: the
// Resend SDK calls the ambient global `fetch` directly (no undici
// dependency — confirmed there by reading node_modules/resend/dist/
// index.mjs), so intercepting it here is a faithful test of the real
// request, not a simulation.
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

/** Every mocked call in these tests hits the same Resend endpoint for both
 * the player's own verification email and the owner's alert — distinguish
 * by the request body's `subject`. */
function callsWithSubjectContaining(calls: FetchCall[], fragment: string): FetchCall[] {
  return calls.filter((c) => {
    try {
      const body = JSON.parse(String(c.init?.body));
      return typeof body.subject === "string" && body.subject.includes(fragment);
    } catch {
      return false;
    }
  });
}

const EMAIL_ENV_VARS = ["RESEND_API_KEY", "OWNER_NOTIFICATION_EMAIL", "SITE_URL"] as const;
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

// ---------------------------------------------------------------------------
// lib/ownerNotifications.ts, in isolation.
// ---------------------------------------------------------------------------

test("notifyOwnerOfNewSignup reports sent:false and never calls fetch when OWNER_NOTIFICATION_EMAIL is unset", async () => {
  const mock = mockFetch(() => {
    throw new Error("must not be called");
  });
  try {
    process.env.RESEND_API_KEY = "re_test_key";
    const result = await notifyOwnerOfNewSignup({
      playerName: "Zsolt",
      email: "zsolt@example.com",
      signupTime: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(result.sent, false);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("notifyOwnerOfVerifiedSignup reports sent:false and never calls fetch when RESEND_API_KEY is unset", async () => {
  const mock = mockFetch(() => {
    throw new Error("must not be called");
  });
  try {
    process.env.OWNER_NOTIFICATION_EMAIL = "owner@example.com";
    const result = await notifyOwnerOfVerifiedSignup({
      playerName: "Zsolt",
      email: "zsolt@example.com",
      signupTime: new Date(),
    });
    assert.equal(result.sent, false);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("a malformed OWNER_NOTIFICATION_EMAIL is treated as unset, not sent to an invalid address", async () => {
  const mock = mockFetch(() => {
    throw new Error("must not be called");
  });
  try {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.OWNER_NOTIFICATION_EMAIL = "not-an-email";
    const result = await notifyOwnerOfNewSignup({
      playerName: "Zsolt",
      email: "zsolt@example.com",
      signupTime: new Date(),
    });
    assert.equal(result.sent, false);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("notifyOwnerOfNewSignup sends to the configured owner address with signup details and an admin-overview link", async () => {
  const mock = mockFetch(
    () => new Response(JSON.stringify({ id: "email-owner-1" }), { status: 200, headers: { "Content-Type": "application/json" } })
  );
  try {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.OWNER_NOTIFICATION_EMAIL = "owner@example.com";
    process.env.SITE_URL = "https://barkoba.example";
    const result = await notifyOwnerOfNewSignup({
      playerName: "Zsolt",
      email: "zsolt@example.com",
      signupTime: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(result.sent, true);
    assert.equal(mock.calls.length, 1);
    const body = JSON.parse(String(mock.calls[0]!.init?.body));
    assert.deepEqual(body.to, ["owner@example.com"]);
    assert.match(body.subject, /megerősítésre vár/);
    assert.match(body.html, /2026-01-01T00:00:00\.000Z/);
    assert.match(body.html, /Zsolt/);
    assert.match(body.html, /zsolt@example\.com/);
    assert.match(body.html, /https:\/\/barkoba\.example\/admin\/overview/);
  } finally {
    mock.restore();
  }
});

test("player-supplied name/email are HTML-escaped before being embedded in the owner alert", async () => {
  const mock = mockFetch(
    () => new Response(JSON.stringify({ id: "email-owner-2" }), { status: 200, headers: { "Content-Type": "application/json" } })
  );
  try {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.OWNER_NOTIFICATION_EMAIL = "owner@example.com";
    process.env.SITE_URL = "https://barkoba.example";
    await notifyOwnerOfNewSignup({
      playerName: '<script>alert("x")</script>',
      email: "zsolt@example.com",
      signupTime: new Date(),
    });
    const body = JSON.parse(String(mock.calls[0]!.init?.body));
    assert.doesNotMatch(body.html, /<script>/);
    assert.match(body.html, /&lt;script&gt;/);
  } finally {
    mock.restore();
  }
});

test("Resend refusing the send is reported as sent:false, never a throw", async () => {
  const mock = mockFetch(
    () => new Response(JSON.stringify({ name: "validation_error", message: "bad" }), { status: 422, headers: { "Content-Type": "application/json" } })
  );
  try {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.OWNER_NOTIFICATION_EMAIL = "owner@example.com";
    process.env.SITE_URL = "https://barkoba.example";
    const result = await notifyOwnerOfVerifiedSignup({ playerName: "Zsolt", email: "z@example.com", signupTime: new Date() });
    assert.equal(result.sent, false);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// End-to-end: registration and verification never fail because of the
// owner-notification step, and it never double-fires.
// ---------------------------------------------------------------------------

interface AccountRow {
  player_id: string;
  recovery_key: string;
  display_name: string | null;
  email: string | null;
  email_verified_at: string | null;
  email_verification_token: string | null;
  email_verification_expires_at: string | null;
  created_at: string;
  registered_at: string;
  disabled_at: null;
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

  if (/INSERT INTO accounts\.players/.test(query)) {
    const playerId = String(v[0]);
    const recoveryKey = String(v[1]);
    const existingById = accounts.get(playerId);
    const collidesOnRecovery = [...accounts.values()].some((a) => a.recovery_key === recoveryKey);
    if (existingById || collidesOnRecovery) return Promise.resolve([]);
    const row: AccountRow = {
      player_id: playerId,
      recovery_key: recoveryKey,
      display_name: typeof v[2] === "string" ? v[2] : null,
      created_at: String(v[3]),
      email: typeof v[4] === "string" ? v[4] : null,
      email_verification_token: typeof v[5] === "string" ? v[5] : null,
      email_verification_expires_at: typeof v[6] === "string" ? v[6] : null,
      registered_at: new Date().toISOString(),
      disabled_at: null,
      email_verified_at: null,
      photo_url: null,
    };
    accounts.set(playerId, row);
    return Promise.resolve([row as unknown as Record<string, unknown>]);
  }
  if (/SELECT\s*\n?\s*COUNT\(\*\)::int AS registered/.test(query)) {
    const rows = [...accounts.values()];
    return Promise.resolve([
      {
        registered: rows.length,
        verified: rows.filter((r) => r.email_verified_at !== null).length,
        pending_verification: rows.filter((r) => r.email !== null && r.email_verified_at === null).length,
      },
    ]);
  }
  if (/FROM accounts\.players/.test(query) && /email_verification_token\s*=/.test(query)) {
    const hash = String(v[0]);
    const row = [...accounts.values()].find((a) => a.email_verification_token === hash);
    return Promise.resolve(row ? [row as unknown as Record<string, unknown>] : []);
  }
  if (/UPDATE accounts\.players/.test(query) && /email_verified_at/.test(query)) {
    const playerId = String(v[0]);
    const row = accounts.get(playerId);
    if (!row) return Promise.resolve([]);
    if (row.email_verified_at === null) row.email_verified_at = new Date().toISOString();
    return Promise.resolve([{ player_id: playerId }]);
  }
  if (/FROM accounts\.players/.test(query) && !/INSERT INTO accounts\.player_sessions/.test(query)) {
    const row = accounts.get(String(v[0]));
    return Promise.resolve(row ? [row as unknown as Record<string, unknown>] : []);
  }
  if (/INSERT INTO accounts\.player_sessions/.test(query)) {
    const hash = String(v[0]);
    const playerId = String(v[2]);
    if (!accounts.has(playerId)) return Promise.resolve([]);
    sessions.set(hash, { player_id: playerId, expires_at: String(v[1]), revoked_at: null });
    return Promise.resolve([{ player_id: playerId }]);
  }
  if (/FROM accounts\.player_sessions/.test(query)) {
    const row = sessions.get(String(v[0]));
    return Promise.resolve(row && !row.revoked_at && Date.parse(row.expires_at) > Date.now() ? [{ player_id: row.player_id }] : []);
  }
  if (/SELECT COALESCE\(SUM\(amount\), 0\) AS balance/.test(query)) {
    return Promise.resolve([{ balance: 0 }]);
  }
  if (/BOOL_OR\(grant_key = 'initial_complimentary'\)/.test(query)) {
    return Promise.resolve([{ balance: 0, complimentary_granted: 0, purchased: 0, consumed: 0, expired: 0, initial_complimentary_granted: false, anonymous_complimentary_granted: false }]);
  }
  if (/FROM accounts\.unlimited_play/.test(query)) {
    return Promise.resolve([]);
  }
  if (/INSERT INTO accounts\.entitlement_ledger/.test(query)) {
    return Promise.resolve([{ entry_id: 1 }]);
  }
  return Promise.resolve([]);
}
fakeSql.transaction = (q: Promise<Record<string, unknown>[]>[]) => Promise.all(q);

const SAVED = {
  db: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
  admin: process.env.ADMIN_PLAYER_IDS,
};

beforeEach(() => {
  accounts = new Map();
  sessions = new Map();
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  delete process.env.ADMIN_PLAYER_IDS;
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  if (SAVED.db === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED.db;
  if (SAVED.corpus === undefined) delete process.env.CORPUS_ENABLED;
  else process.env.CORPUS_ENABLED = SAVED.corpus;
  if (SAVED.admin === undefined) delete process.env.ADMIN_PLAYER_IDS;
  else process.env.ADMIN_PLAYER_IDS = SAVED.admin;
});

// register/route.ts uses next/headers cookies() and, per the existing
// convention in test/accountOwnership.test.ts and test/emailVerification
// .test.ts, cannot be invoked directly in this harness — so its wiring is
// proven by source inspection, exactly like the rest of this suite already
// does for that file, and the underlying dedup MECHANISM
// (registerPlayerAccount's own unique constraints) is proven executably
// below instead, since that function does not touch next/headers at all.

test("SOURCE: the new-signup owner alert is wired exactly like the existing verification-email send — after the account exists, in its own non-fatal try/catch", () => {
  const source = readFileSync("app/api/account/register/route.ts", "utf8");
  assert.match(source, /notifyOwnerOfNewSignup\(\{ playerName: displayName, email, signupTime: new Date\(\) \}\)/);

  const registerCallAt = source.indexOf("await registerPlayerAccount({");
  const notifyCallAt = source.indexOf("notifyOwnerOfNewSignup(");
  assert.ok(registerCallAt > 0 && notifyCallAt > registerCallAt, "the owner alert must only be attempted after the account row already exists");

  const nextMilestone = source.indexOf("const secure =", notifyCallAt);
  const notifyRegion = source.slice(notifyCallAt - 40, nextMilestone);
  assert.match(notifyRegion, /catch/, "the owner alert must be wrapped in its own try/catch");
  assert.doesNotMatch(
    notifyRegion,
    /return/,
    "a failed owner alert must fall through to registration's normal success response, not return early"
  );
});

test("registerPlayerAccount throws rather than silently no-op-ing on a genuine retry for the same player_id — the exact mechanism that keeps the owner alert from ever firing twice", async () => {
  const playerId = "3".repeat(32);
  const { account, created } = await registerPlayerAccount({
    playerId,
    recoveryKey: "firstattempt".padEnd(64, "0"),
    displayName: "Zsolt",
    email: "zsolt@example.com",
    emailVerificationTokenHash: "hash1",
    emailVerificationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(created, true);
  assert.equal(account.player_id, playerId);

  // A retry of the SAME registration request generates a FRESH random
  // recovery code server-side (see app/api/account/register/route.ts:
  // `recoveryCode = generateRecoveryCode()` runs on every invocation), so
  // a second call for the same player_id can never present the SAME
  // recovery_key the first call already committed -- registerPlayerAccount
  // then throws rather than returning created:false, which is what stops
  // the route from ever reaching its (post-registerPlayerAccount) owner-
  // notification call site a second time for this account.
  await assert.rejects(() =>
    registerPlayerAccount({
      playerId,
      recoveryKey: "secondattempt".padEnd(64, "0"),
      displayName: "Zsolt",
      email: "zsolt@example.com",
      emailVerificationTokenHash: "hash2",
      emailVerificationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
  );
});

test("verification sends the owner alert on the fresh-verification branch, never again on a repeat visit", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.OWNER_NOTIFICATION_EMAIL = "owner@example.com";
  process.env.SITE_URL = "https://barkoba.example";
  const mock = mockFetch(
    () => new Response(JSON.stringify({ id: "email-y" }), { status: 200, headers: { "Content-Type": "application/json" } })
  );
  try {
    const playerId = "9".repeat(32);
    await registerPlayerAccount({
      playerId,
      recoveryKey: "rk".padEnd(64, "0"),
      displayName: "Zsolt",
      email: "zsolt@example.com",
      emailVerificationTokenHash: "tokenhash123",
      emailVerificationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // resolveByToken (verify-email/route.ts) hashes the raw token before
    // looking it up, so the fake must store the HASH of the raw token used
    // below, not the literal string — recomputed the same way the real
    // module does.
    const { verificationTokenHash } = await import("../lib/emailVerification");
    const realHash = await verificationTokenHash("tokenhash123");
    accounts.get(playerId)!.email_verification_token = realHash;

    const req1 = new Request("https://barkoba.test/api/account/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "tokenhash123" }),
    });

    const res1 = await verifyEmailPOST(req1 as Parameters<typeof verifyEmailPOST>[0]);
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.verified, true);
    assert.equal(body1.already_verified, false);

    const verifiedCallsAfterFirst = callsWithSubjectContaining(mock.calls, "megerősítve").length;
    assert.equal(verifiedCallsAfterFirst, 1);

    const req2 = new Request("https://barkoba.test/api/account/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "tokenhash123" }),
    });
    const res2 = await verifyEmailPOST(req2 as Parameters<typeof verifyEmailPOST>[0]);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.already_verified, true);

    const verifiedCallsAfterSecond = callsWithSubjectContaining(mock.calls, "megerősítve").length;
    assert.equal(verifiedCallsAfterSecond, 1, "a repeat visit must never re-send the verified-owner alert");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// Admin overview: non-admin denial, admin (owner) access.
// ---------------------------------------------------------------------------

const OWNER = "d".repeat(32);

async function ownerSession(): Promise<string> {
  process.env.ADMIN_PLAYER_IDS = OWNER;
  await registerPlayerAccount({ playerId: OWNER, recoveryKey: "ownerrk".padEnd(64, "0"), displayName: "Owner" });
  return createAccountSession(OWNER);
}

test("GET /api/admin/overview refuses a non-admin authenticated account", async () => {
  const other = "e".repeat(32);
  await registerPlayerAccount({ playerId: other, recoveryKey: "otherrk".padEnd(64, "0"), displayName: "Player" });
  const token = await createAccountSession(other);
  process.env.ADMIN_PLAYER_IDS = "f".repeat(32); // some OTHER id, not `other`

  const res = await adminOverviewGET(
    new Request("https://barkoba.test/api/admin/overview", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof adminOverviewGET>[0]
  );
  assert.equal(res.status, 403);
});

test("GET /api/admin/overview refuses an anonymous caller with no session at all", async () => {
  const res = await adminOverviewGET(
    new Request("https://barkoba.test/api/admin/overview") as Parameters<typeof adminOverviewGET>[0]
  );
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// V2.9.2.2 PRODUCTION FIX — reported symptom: the owner set
// ADMIN_PLAYER_IDS to their exact player_id (read from /api/account/profile,
// which uses the SAME resolveActingPlayer identity resolution as this
// route) and redeployed, yet /admin/overview still showed "Nincs
// jogosultságod ehhez az oldalhoz." Root cause: env.adminPlayerIds() only
// ever trimmed whitespace, never stripped surrounding quotes — a value
// typed or pasted into a hosting dashboard (e.g. copied out of a JSON
// response's `"player_id":"…"` field, or out of habit from quoting a shell
// export) routinely keeps a leading/trailing quote character, which then
// never exact-matches the raw, unquoted id resolveAccountSession returns.
// This is the SAME class of dashboard-input hygiene bug booleanFlag() above
// already guards against, for the identical reason.
// ---------------------------------------------------------------------------

test("env.adminPlayerIds strips surrounding quotes (single or double) in addition to whitespace, per id", () => {
  const id = "a".repeat(32);
  process.env.ADMIN_PLAYER_IDS = `"${id}"`;
  assert.ok(env.adminPlayerIds().has(id), "a double-quoted id must still match the raw id");

  process.env.ADMIN_PLAYER_IDS = `'${id}'`;
  assert.ok(env.adminPlayerIds().has(id), "a single-quoted id must still match the raw id");

  process.env.ADMIN_PLAYER_IDS = `  "${id}"  `;
  assert.ok(env.adminPlayerIds().has(id), "surrounding whitespace AND quotes together must still match");
});

test("env.adminPlayerIds / isAdminPlayer: quote-stripping never loosens the allowlist -- a genuinely different id is still refused", () => {
  const admin = "b".repeat(32);
  const other = "c".repeat(32);
  process.env.ADMIN_PLAYER_IDS = `"${admin}"`;
  assert.equal(isAdminPlayer(admin), true);
  assert.equal(isAdminPlayer(other), false, "an unrelated id must never be granted, quoted config or not");
  assert.equal(isAdminPlayer(`"${admin}"`), false, "the literal quoted string itself is never itself a valid id to check against");
});

test("GET /api/admin/overview grants the allowlisted admin even when ADMIN_PLAYER_IDS was pasted with surrounding quotes -- the exact reported production symptom", async () => {
  const owner = "1".repeat(32);
  process.env.ADMIN_PLAYER_IDS = `"${owner}"`;
  await registerPlayerAccount({ playerId: owner, recoveryKey: "quotedownerrk".padEnd(64, "0"), displayName: "Owner" });
  const token = await createAccountSession(owner);

  const res = await adminOverviewGET(
    new Request("https://barkoba.test/api/admin/overview", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof adminOverviewGET>[0]
  );
  assert.equal(res.status, 200, "a quoted ADMIN_PLAYER_IDS value must not deny the owner it names");
});

test("GET /api/admin/overview grants the allowlisted admin, returning bounded account totals and recent signups", async () => {
  const token = await ownerSession();
  const res = await adminOverviewGET(
    new Request("https://barkoba.test/api/admin/overview?range=all", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof adminOverviewGET>[0]
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.range, "all");
  assert.ok(body.account_totals);
  assert.equal(body.account_totals.registered, 1);
  assert.ok("recent_signups" in body);
  assert.ok("generated_at" in body);
});

test("SOURCE: the admin overview reuses the SAME authorization shape as the existing feedback inbox, not accounts.unlimited_play", () => {
  const route = readFileSync("app/api/admin/overview/route.ts", "utf8");
  assert.match(route, /context\.kind !== "account" \|\| !isAdminPlayer\(context\.playerId\)/);
  assert.doesNotMatch(route, /hasUnlimitedPlay|FROM accounts\.unlimited_play/);
});

// ---------------------------------------------------------------------------
// lib/adminOverview.ts helpers, in isolation.
// ---------------------------------------------------------------------------

test("rangeSince: today is UTC midnight, 7d is exactly 7*24h ago, all is null", () => {
  const today = rangeSince("today");
  assert.ok(today);
  assert.equal(today!.getUTCHours(), 0);
  assert.equal(today!.getUTCMinutes(), 0);

  const sevenDays = rangeSince("7d");
  assert.ok(sevenDays);
  const diffMs = Date.now() - sevenDays!.getTime();
  assert.ok(diffMs >= 7 * 24 * 60 * 60 * 1000 - 1000 && diffMs <= 7 * 24 * 60 * 60 * 1000 + 60_000);

  assert.equal(rangeSince("all"), null);
});

test("getAccountTotals reports registered/verified/pending from the accounts.players aggregate", async () => {
  await registerPlayerAccount({ playerId: "1".repeat(32), recoveryKey: "a".padEnd(64, "0"), displayName: "A", email: "a@example.com", emailVerificationTokenHash: "h1", emailVerificationExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  await registerPlayerAccount({ playerId: "2".repeat(32), recoveryKey: "b".padEnd(64, "0"), displayName: "B", email: "b@example.com", emailVerificationTokenHash: "h2", emailVerificationExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  accounts.get("2".repeat(32))!.email_verified_at = new Date().toISOString();

  const totals = await getAccountTotals();
  assert.ok(totals);
  assert.equal(totals!.registered, 2);
  assert.equal(totals!.verified, 1);
  assert.equal(totals!.pending_verification, 1);
});

test("getAccountTotals returns null (labelled unavailable, never a fabricated zero) when corpus is not configured", async () => {
  delete process.env.CORPUS_ENABLED;
  const totals = await getAccountTotals();
  assert.equal(totals, null);
});

// ---------------------------------------------------------------------------
// Owner-access self-service discovery: the root cause of "the owner got
// access denied" was that no shipped surface let a logged-in player see
// their own raw player_id — app/api/account/diagnostic/route.ts
// deliberately returns only a truncated SHA-256 fingerprint (unchanged by
// this pass). ADMIN_PLAYER_IDS grants by the raw id, so the operator had
// no self-service way to learn what value to add to it. This does NOT
// loosen isAdminPlayer()/ADMIN_PLAYER_IDS in any way — it only lets an
// authenticated player read their OWN account's own id, same authorization
// posture as the rest of GET /api/account/profile.
// ---------------------------------------------------------------------------

test("SOURCE: the profile API returns the caller's own player_id, resolved server-side, never client-suppliable", () => {
  const source = readFileSync("app/api/account/profile/route.ts", "utf8");
  assert.match(source, /player_id: context\.playerId/);
  // Still gated exactly like before: no code path returns a profile
  // (with or without player_id) for anyone but context.kind === "account".
  assert.match(source, /context\.kind !== "account"/);
});

test("SOURCE: the diagnostic endpoint's truncated-fingerprint behavior is untouched by this pass", () => {
  const source = readFileSync("app/api/account/diagnostic/route.ts", "utf8");
  assert.match(source, /fingerprint\(playerId\)/);
  assert.doesNotMatch(source, /player_id: playerId|raw_player_id/);
});

test("SOURCE: AccountProfile.tsx displays the player's own player_id, plainly labelled, not promoted as a primary feature", () => {
  const source = readFileSync("app/components/AccountProfile.tsx", "utf8");
  assert.match(source, /profile\.player_id/);
  assert.match(source, /admin hozzáféréshez/);
});

test("SOURCE: isAdminPlayer's own allowlist mechanism is completely untouched by this pass", () => {
  const source = readFileSync("lib/admin.ts", "utf8");
  assert.match(source, /env\.adminPlayerIds\(\)\.has\(playerId\)/);
  assert.doesNotMatch(source, /hasUnlimitedPlay|FROM accounts\.unlimited_play|ownerNotificationEmail/);
});

test("SOURCE: OWNER_NOTIFICATION_EMAIL and ADMIN_PLAYER_IDS are separate env vars — configuring one never silently grants the other", () => {
  const envSource = readFileSync("lib/env.ts", "utf8");
  assert.match(envSource, /ownerNotificationEmail: \(\) => process\.env\.OWNER_NOTIFICATION_EMAIL \|\| null/);
  assert.match(envSource, /adminPlayerIds: \(\)/);
  const adminFnAt = envSource.indexOf("adminPlayerIds: ()");
  const ownerFnAt = envSource.indexOf("ownerNotificationEmail: ()");
  assert.notEqual(adminFnAt, ownerFnAt);
});
