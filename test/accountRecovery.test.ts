import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { registerPlayerAccount } from "../lib/playerAccounts";
import { resolveAccountSession } from "../lib/accountSession";
import { POST as requestRecovery } from "../app/api/account/recovery-request/route";
import {
  GET as recoveryStatus,
  POST as confirmRecovery,
} from "../app/api/account/recovery-confirm/route";
process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";

// ---------------------------------------------------------------------------
// V2.7.x — email-based account recovery, independent of and additional to
// the existing recovery-code login. Covers the 9 targeted behaviors from the
// task: generic response regardless of account/verification state, no
// mutation on GET, exactly-once consumption on POST, purpose separation
// (structural: a different Redis namespace entirely, exercised implicitly —
// nothing here can accidentally satisfy /api/account/verify-email since
// that route never reads this module's keys), rate limiting, and identity
// preservation (existing player_id, unchanged ledger/history).
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

  if (/FROM accounts\.players/.test(query) && /LOWER\(email\)/.test(query)) {
    const email = String(v[0]).toLowerCase();
    const row = [...accounts.values()].find(
      (a) => (a.email ?? "").toLowerCase() === email && !a.disabled_at
    );
    return Promise.resolve(row ? [row] : []);
  }

  if (/FROM accounts\.players/.test(query) && /player_id =/.test(query)) {
    const row = accounts.get(String(v[0]));
    return Promise.resolve(row ? [row] : []);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

type KvEntry = { value: unknown; expiresAt: number | null };
const devStore = globalThis as unknown as { __barkobaDevKV?: Map<string, KvEntry> };

const SAVED = {
  database: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
  resendKey: process.env.RESEND_API_KEY,
  siteUrl: process.env.SITE_URL,
  rateLimitDisabled: process.env.RATE_LIMIT_DISABLED,
};
const realFetch = globalThis.fetch;

let sentEmails: { to: string; html: string }[];

beforeEach(() => {
  accounts = new Map();
  sessions = new Map();
  sentEmails = [];
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.SITE_URL = "https://barkoba.example";
  delete process.env.RATE_LIMIT_DISABLED;
  (devStore.__barkobaDevKV ??= new Map()).clear();
  __setSqlClientForTests(fakeSql);
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    sentEmails.push({ to: body.to?.[0], html: body.html });
    return new Response(JSON.stringify({ id: "email-id-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  __setSqlClientForTests(null);
  globalThis.fetch = realFetch;
  (devStore.__barkobaDevKV ??= new Map()).clear();
  if (SAVED.database === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED.database;
  if (SAVED.corpus === undefined) delete process.env.CORPUS_ENABLED;
  else process.env.CORPUS_ENABLED = SAVED.corpus;
  if (SAVED.resendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = SAVED.resendKey;
  if (SAVED.siteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = SAVED.siteUrl;
  if (SAVED.rateLimitDisabled === undefined) delete process.env.RATE_LIMIT_DISABLED;
  else process.env.RATE_LIMIT_DISABLED = SAVED.rateLimitDisabled;
});

function requestFrom(ip: string, email: string) {
  return requestRecovery(
    new Request("https://barkoba.test/api/account/recovery-request", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email }),
    }) as Parameters<typeof requestRecovery>[0]
  );
}

function extractToken(): string {
  assert.equal(sentEmails.length, 1, "exactly one recovery email must have been sent");
  const match = sentEmails[0]!.html.match(/token=([0-9a-f]+)/);
  assert.ok(match, "recovery URL must carry a token");
  return match![1]!;
}

// --- 1/2/3: identical outward response, whatever the truth -----------------

test("1/2/3. verified, unverified, and unknown emails all get the exact same generic response", async () => {
  const verifiedId = "1".repeat(32);
  await registerPlayerAccount({
    playerId: verifiedId,
    recoveryKey: "1".repeat(64),
    displayName: "Zsolt",
    email: "verified@example.com",
  });
  accounts.get(verifiedId)!.email_verified_at = new Date().toISOString();

  const unverifiedId = "2".repeat(32);
  await registerPlayerAccount({
    playerId: unverifiedId,
    recoveryKey: "2".repeat(64),
    displayName: "Someone",
    email: "unverified@example.com",
  });

  const [verifiedRes, unverifiedRes, unknownRes] = await Promise.all([
    requestFrom("10.0.0.1", "verified@example.com"),
    requestFrom("10.0.0.2", "unverified@example.com"),
    requestFrom("10.0.0.3", "nobody@example.com"),
  ]);

  assert.equal(verifiedRes.status, unverifiedRes.status);
  assert.equal(verifiedRes.status, unknownRes.status);
  const [vBody, uBody, nBody] = await Promise.all([
    verifiedRes.json(),
    unverifiedRes.json(),
    unknownRes.json(),
  ]);
  assert.deepEqual(vBody, uBody);
  assert.deepEqual(vBody, nBody);

  // Only the verified account actually gets an email — the CAUSE of the
  // identical response is that this route sends conditionally but replies
  // unconditionally, not that nothing happened.
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0]!.to, "verified@example.com");
});

// --- 4: GET is completely inert ---------------------------------------------

test("4. repeated/prefetch GETs on the recovery link cause zero mutation and the token remains usable", async () => {
  const playerId = "3".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "3".repeat(64), displayName: "Zsolt", email: "z@example.com" });
  accounts.get(playerId)!.email_verified_at = new Date().toISOString();

  await requestFrom("10.0.0.4", "z@example.com");
  const token = extractToken();

  for (let i = 0; i < 5; i += 1) {
    const res = await recoveryStatus(
      new Request(`https://barkoba.test/api/account/recovery-confirm?token=${token}`)
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "pending");
  }

  // The token must still be consumable after all those GETs.
  const confirmed = await confirmRecovery(
    new Request("https://barkoba.test/api/account/recovery-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }) as Parameters<typeof confirmRecovery>[0]
  );
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).recovered, true);
});

// --- 5/6/9: POST consumes exactly once, issues a real session, preserves identity ---

test("5/6/9. explicit POST issues a working session for the EXISTING account exactly once", async () => {
  const playerId = "4".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "4".repeat(64), displayName: "Zsolt", email: "z2@example.com" });
  accounts.get(playerId)!.email_verified_at = new Date().toISOString();

  await requestFrom("10.0.0.5", "z2@example.com");
  const token = extractToken();

  const post = () =>
    confirmRecovery(
      new Request("https://barkoba.test/api/account/recovery-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }) as Parameters<typeof confirmRecovery>[0]
    );

  const first = await post();
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.recovered, true);
  assert.equal(firstBody.display_name, "Zsolt");

  const cookieHeader = first.headers.get("set-cookie") ?? "";
  const sessionMatch = cookieHeader.match(/bk_account_session=([^;]+)/);
  assert.ok(sessionMatch, "a session cookie must be set");
  const resolved = await resolveAccountSession(sessionMatch![1]!);
  assert.equal(resolved, playerId, "the session must resolve to the SAME existing player_id");

  // Identity/account facts are untouched by recovery.
  assert.equal(accounts.get(playerId)!.recovery_key, "4".repeat(64));
  assert.equal(accounts.get(playerId)!.email, "z2@example.com");
  assert.ok(accounts.get(playerId)!.email_verified_at);

  // Second POST — token cannot be reused.
  const second = await post();
  assert.equal(second.status, 404);
  const secondBody = await second.json();
  assert.equal(secondBody.recovered, false);
  assert.equal(secondBody.error, "invalid_token");
});

// --- 1 (this review): atomic consumption under a genuine race --------------

test("1. two concurrent POSTs for the SAME token: exactly one consumes, exactly one session is issued", async () => {
  const playerId = "5".repeat(32);
  await registerVerified(playerId, "concurrent@example.com");

  await requestFrom("10.0.2.1", "concurrent@example.com");
  const token = extractToken();

  const post = () =>
    confirmRecovery(
      new Request("https://barkoba.test/api/account/recovery-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }) as Parameters<typeof confirmRecovery>[0]
    );

  // Fired together, not awaited sequentially — this exercises
  // consumeAccountRecoveryToken's getKV().getdel() call from both requests
  // without either one waiting for the other to finish first.
  const [a, b] = await Promise.all([post(), post()]);
  const [aBody, bBody] = await Promise.all([a.json(), b.json()]);

  const outcomes = [
    { res: a, body: aBody },
    { res: b, body: bBody },
  ];
  const succeeded = outcomes.filter((o) => o.body.recovered === true);
  const failed = outcomes.filter((o) => o.body.recovered === false);

  assert.equal(succeeded.length, 1, "exactly one of the two concurrent POSTs may succeed");
  assert.equal(failed.length, 1, "the other must fail, not silently succeed too");
  assert.equal(failed[0]!.res.status, 404);
  assert.equal(failed[0]!.body.error, "invalid_token");
  assert.equal(failed[0]!.res.headers.get("set-cookie"), null, "the losing request must not set a session");

  const winnerCookie = succeeded[0]!.res.headers.get("set-cookie") ?? "";
  const sessionMatch = winnerCookie.match(/bk_account_session=([^;]+)/);
  assert.ok(sessionMatch, "the winning request must set a real session");
  assert.equal(await resolveAccountSession(sessionMatch![1]!), playerId);

  // Nothing about the account changed as a side effect of the race itself.
  assert.equal(accounts.get(playerId)!.recovery_key, playerId.repeat(2));
});

// --- 7: expired/invalid token ------------------------------------------------

test("7. an unknown or already-consumed token reports a human-readable failure, no session", async () => {
  const res = await confirmRecovery(
    new Request("https://barkoba.test/api/account/recovery-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "totally-made-up" }),
    }) as Parameters<typeof confirmRecovery>[0]
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.recovered, false);
  assert.equal(body.error, "invalid_token");
  assert.equal(res.headers.get("set-cookie"), null, "no session may be set for an invalid token");

  const statusRes = await recoveryStatus(
    new Request("https://barkoba.test/api/account/recovery-confirm?token=totally-made-up")
  );
  assert.equal(statusRes.status, 404);
  assert.equal((await statusRes.json()).status, "invalid");
});

// --- rate limiting: two independent buckets, both silent on overflow -------
//
// The route now returns the byte-identical 200 body regardless of WHY it
// declined to send — no account, unverified, IP-limited, or target-email-
// limited — per the reviewed enumeration invariant. So these tests observe
// the only thing that actually distinguishes "throttled" from "sent":
// whether an email landed in Resend's outbox. sentEmails.length is the
// ground truth; response bodies are asserted identical throughout.

async function registerVerified(id: string, email: string) {
  await registerPlayerAccount({ playerId: id, recoveryKey: id.repeat(2), displayName: "Zsolt", email });
  accounts.get(id)!.email_verified_at = new Date().toISOString();
}

test("2/3. the per-IP bucket throttles across DIFFERENT target emails from one source", async () => {
  const ip = "10.0.0.20";
  const bodies: unknown[] = [];
  // IP limit is 5/hour; six distinct, individually-fresh verified emails
  // from the SAME ip must still stop sending after the fifth.
  for (let i = 0; i < 6; i += 1) {
    const id = `a${i}`.padStart(32, "0");
    await registerVerified(id, `target-${i}@example.com`);
    const res = await requestFrom(ip, `target-${i}@example.com`);
    assert.equal(res.status, 200);
    bodies.push(await res.json());
  }
  assert.deepEqual(new Set(bodies.map((b) => JSON.stringify(b))).size, 1, "every response must be identical");
  assert.equal(sentEmails.length, 5, "the 6th request must be silently throttled by the IP bucket");
});

test("2. the per-target-email bucket throttles across ROTATING IPs for the SAME address", async () => {
  const id = "b".repeat(32);
  await registerVerified(id, "victim@example.com");
  const bodies: unknown[] = [];
  // Email-target limit is 4/hour; five distinct IPs requesting the SAME
  // address must still stop sending after the fourth, even though no
  // single IP ever approaches the (much higher) per-IP limit.
  for (let i = 0; i < 5; i += 1) {
    const res = await requestFrom(`10.0.1.${i}`, "victim@example.com");
    assert.equal(res.status, 200);
    bodies.push(await res.json());
  }
  assert.deepEqual(new Set(bodies.map((b) => JSON.stringify(b))).size, 1, "every response must be identical");
  assert.equal(sentEmails.length, 4, "the 5th request must be silently throttled by the email-target bucket");
  // Case/whitespace must not evade the bucket — normalization matches
  // account lookup (trim + lowercase).
  const evasionAttempt = await requestFrom("10.0.1.99", "  VICTIM@EXAMPLE.com  ");
  assert.equal(evasionAttempt.status, 200);
  assert.equal(sentEmails.length, 4, "differently-cased/spaced same address must hit the same bucket");
});

// --- structural: purpose separation -----------------------------------------

test("the recovery token module is structurally incapable of touching Postgres at all", () => {
  // Not a substring check against prose (this file's own comments explain
  // the CONTRAST with email_verification_token, which would trip a naive
  // regex) — a structural one: no SQL client import at all means no code
  // path here can reach accounts.players, recovery_key, or any other
  // column, regardless of what the comments say about them.
  const src = readFileSync("lib/accountRecovery.ts", "utf8");
  assert.doesNotMatch(src, /from ["']\.\/corpus\/db["']|getSql\(|requireSql\(/);
  assert.match(src, /account_recovery:/);
});

test("consumeAccountRecoveryToken uses the atomic getdel primitive, not a separate get+del", () => {
  const src = readFileSync("lib/accountRecovery.ts", "utf8");
  const fn = src.slice(
    src.indexOf("export async function consumeAccountRecoveryToken"),
    src.indexOf("export interface SendAccountRecoveryEmailResult")
  );
  assert.match(fn, /getKV\(\)\.getdel</);
  assert.doesNotMatch(fn, /getKV\(\)\.get</, "must not read via a separate, non-atomic get()");
  assert.doesNotMatch(fn, /getKV\(\)\.del\(/, "must not delete via a separate, non-atomic del()");

  const kv = readFileSync("lib/kv.ts", "utf8");
  assert.match(kv, /this\.client\.getdel</, "UpstashKV must call the real Redis GETDEL command");
});
