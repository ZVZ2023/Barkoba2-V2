import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { createAccountSession } from "../lib/accountSession";
import { registerPlayerAccount } from "../lib/playerAccounts";
import { GET as statusGET } from "../app/api/beta/status/route";
import { POST as applyPOST } from "../app/api/beta/apply/route";
import { GET as queueGET } from "../app/api/beta/admin/queue/route";
import { POST as reviewPOST } from "../app/api/beta/admin/review/route";
import { POST as feedbackPOST } from "../app/api/feedback/route";

process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 — route-level authorization: verified-account requirement,
// admin-only review, self-approval/unauthorized-review denial end to end,
// and feedback's unconditional availability.
//
// Reuses test/accountOwnership.test.ts's exact fakeSql idiom for
// accounts.players/accounts.player_sessions (registerPlayerAccount +
// createAccountSession are the REAL functions; only the SQL layer is
// faked), extended with this slice's own beta.applications handling.
// ---------------------------------------------------------------------------

interface AccountRow {
  player_id: string;
  recovery_key: string;
  display_name: string | null;
  created_at: string;
  registered_at: string;
  disabled_at: null;
  email_verified_at: string | null;
}

interface SessionRow {
  player_id: string;
  expires_at: string;
  revoked_at: string | null;
}

interface AppRow {
  application_id: number;
  player_id: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
}

let accounts: Map<string, AccountRow>;
let sessions: Map<string, SessionRow>;
let applications: AppRow[];
let nextAppId: number;
let feedbackRows: Array<{ player_id: string | null; message: string; category: string | null; operational_game_id: string | null }>;

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const query = strings.join(" ");
  const v = values as unknown[];

  if (/INSERT INTO accounts\.players/.test(query)) {
    const playerId = String(v[0]);
    const recovery = String(v[1]);
    if (accounts.has(playerId)) return Promise.resolve([]);
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
    return Promise.resolve([row as unknown as Record<string, unknown>]);
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
    return Promise.resolve(
      row && !row.revoked_at && Date.parse(row.expires_at) > Date.now() ? [{ player_id: row.player_id }] : []
    );
  }

  // --- beta.applications -----------------------------------------------------

  if (/INSERT INTO beta\.applications/.test(query)) {
    const playerId = String(v[0]);
    const note = typeof v[1] === "string" ? v[1] : null;
    if (applications.some((a) => a.player_id === playerId)) return Promise.resolve([]);
    applications.push({
      application_id: nextAppId++,
      player_id: playerId,
      status: "pending",
      note,
      submitted_at: new Date().toISOString(),
      reviewed_at: null,
      reviewed_by: null,
      rejection_reason: null,
    });
    return Promise.resolve([]);
  }

  if (/FROM beta\.applications\s*\n\s*WHERE player_id =/.test(query)) {
    const row = applications.find((a) => a.player_id === String(v[0]));
    return Promise.resolve(row ? [row as unknown as Record<string, unknown>] : []);
  }

  if (/FROM beta\.applications\s*\n\s*WHERE status = 'pending'/.test(query)) {
    return Promise.resolve(applications.filter((a) => a.status === "pending") as unknown as Record<string, unknown>[]);
  }

  if (/SELECT player_id, status FROM beta\.applications WHERE application_id =/.test(query)) {
    const row = applications.find((a) => a.application_id === Number(v[0]));
    return Promise.resolve(row ? [{ player_id: row.player_id, status: row.status }] : []);
  }

  if (/UPDATE beta\.applications/.test(query)) {
    const decision = String(v[0]) as "approved" | "rejected";
    const reviewer = String(v[1]);
    const rejectionReason = typeof v[2] === "string" ? v[2] : null;
    const id = Number(v[3]);
    const row = applications.find((a) => a.application_id === id && a.status === "pending");
    if (!row) return Promise.resolve([]);
    row.status = decision;
    row.reviewed_at = new Date().toISOString();
    row.reviewed_by = reviewer;
    row.rejection_reason = rejectionReason;
    return Promise.resolve([{ application_id: id }]);
  }

  // --- beta.profile_revisions (unused by these route tests, but must not throw) ---
  if (/beta\.profile_revisions/.test(query)) {
    return Promise.resolve([]);
  }

  // --- feedback.submissions ----------------------------------------------------

  if (/INSERT INTO feedback\.submissions/.test(query)) {
    feedbackRows.push({
      player_id: v[0] === null ? null : String(v[0]),
      operational_game_id: v[1] === null ? null : String(v[1]),
      category: v[2] === null ? null : String(v[2]),
      message: String(v[3]),
    });
    return Promise.resolve([]);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (q: Promise<Record<string, unknown>[]>[]) => Promise.all(q);

const SAVED = {
  flag: process.env.BETA_COMMUNITY_ENABLED,
  db: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
  admin: process.env.ADMIN_PLAYER_IDS,
  rateLimit: process.env.RATE_LIMIT_DISABLED,
};

beforeEach(() => {
  accounts = new Map();
  sessions = new Map();
  applications = [];
  nextAppId = 1;
  feedbackRows = [];
  process.env.BETA_COMMUNITY_ENABLED = "true";
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  process.env.RATE_LIMIT_DISABLED = "true";
  delete process.env.ADMIN_PLAYER_IDS;
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  for (const [k, val] of Object.entries(SAVED)) {
    const envKey =
      k === "flag" ? "BETA_COMMUNITY_ENABLED" :
      k === "db" ? "DATABASE_URL" :
      k === "corpus" ? "CORPUS_ENABLED" :
      k === "admin" ? "ADMIN_PLAYER_IDS" : "RATE_LIMIT_DISABLED";
    if (val === undefined) delete process.env[envKey];
    else process.env[envKey] = val;
  }
});

async function makeVerifiedAccount(playerId: string): Promise<string> {
  await registerPlayerAccount({ playerId, recoveryKey: `${playerId}rk`, displayName: "Tester" });
  const row = accounts.get(playerId)!;
  row.email_verified_at = new Date().toISOString();
  return createAccountSession(playerId);
}

const P1 = "1".repeat(32);
const P2 = "2".repeat(32);
const ADMIN = "a".repeat(32);

// ---------------------------------------------------------------------------
// /beta behavior while OFF and ON (status endpoint as the observable proxy —
// the page itself is a source-contract test in test/betaUi.test.ts, since
// next/navigation's notFound() cannot be invoked from a plain unit test).
// ---------------------------------------------------------------------------

test("the status endpoint reports enabled:false when the flag is OFF, revealing nothing else", async () => {
  process.env.BETA_COMMUNITY_ENABLED = "false";
  const res = await statusGET(new Request("https://barkoba.test/api/beta/status") as Parameters<typeof statusGET>[0]);
  const body = await res.json();
  assert.deepEqual(body, { enabled: false });
});

test("apply is refused with not_found while the flag is OFF, exactly like a nonexistent route", async () => {
  process.env.BETA_COMMUNITY_ENABLED = "false";
  const res = await applyPOST(
    new Request("https://barkoba.test/api/beta/apply", { method: "POST" }) as Parameters<typeof applyPOST>[0]
  );
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Verified-account application requirement.
// ---------------------------------------------------------------------------

test("an unauthenticated caller cannot apply", async () => {
  const res = await applyPOST(
    new Request("https://barkoba.test/api/beta/apply", { method: "POST", body: "{}" }) as Parameters<typeof applyPOST>[0]
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "account_required");
});

test("a registered but UNVERIFIED account cannot apply", async () => {
  await registerPlayerAccount({ playerId: P1, recoveryKey: "rk1", displayName: "Zsolt" });
  const token = await createAccountSession(P1);

  const res = await applyPOST(
    new Request("https://barkoba.test/api/beta/apply", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}` },
      body: "{}",
    }) as Parameters<typeof applyPOST>[0]
  );
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "verification_required");
  assert.equal(applications.length, 0, "no application row for a refused attempt");
});

test("a VERIFIED account can apply, and the same call is idempotent on retry", async () => {
  const token = await makeVerifiedAccount(P1);

  const first = await applyPOST(
    new Request("https://barkoba.test/api/beta/apply", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}` },
      body: JSON.stringify({ note: "I love Barkóba" }),
    }) as Parameters<typeof applyPOST>[0]
  );
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.status, "pending");

  const second = await applyPOST(
    new Request("https://barkoba.test/api/beta/apply", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}` },
      body: JSON.stringify({ note: "a different note entirely" }),
    }) as Parameters<typeof applyPOST>[0]
  );
  assert.equal(second.status, 200);
  assert.equal(applications.length, 1, "a duplicate submission must not create a second row");
  assert.equal(applications[0]!.note, "I love Barkóba", "the original note is preserved");
});

// ---------------------------------------------------------------------------
// Applicant status isolation, via /api/beta/status.
// ---------------------------------------------------------------------------

test("status reports ONLY the caller's own application", async () => {
  const tokenA = await makeVerifiedAccount(P1);
  const tokenB = await makeVerifiedAccount(P2);
  await applyPOST(
    new Request("https://barkoba.test/api/beta/apply", {
      method: "POST",
      headers: { cookie: `bk_account_session=${tokenA}` },
      body: JSON.stringify({ note: "player one's note" }),
    }) as Parameters<typeof applyPOST>[0]
  );

  const statusForB = await statusGET(
    new Request("https://barkoba.test/api/beta/status", {
      headers: { cookie: `bk_account_session=${tokenB}` },
    }) as Parameters<typeof statusGET>[0]
  );
  const bodyB = await statusForB.json();
  assert.equal(bodyB.application, null, "player two must not see player one's application");
});

// ---------------------------------------------------------------------------
// Admin-only review; self-approval and unauthorized-review denial.
// ---------------------------------------------------------------------------

test("the review queue refuses a non-admin caller, even a verified, authenticated one", async () => {
  const token = await makeVerifiedAccount(P1);
  const res = await queueGET(
    new Request("https://barkoba.test/api/beta/admin/queue", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof queueGET>[0]
  );
  assert.equal(res.status, 403);
});

test("the review queue refuses an unauthenticated caller", async () => {
  const res = await queueGET(
    new Request("https://barkoba.test/api/beta/admin/queue") as Parameters<typeof queueGET>[0]
  );
  assert.equal(res.status, 403);
});

test("an admin can list and approve a pending application", async () => {
  process.env.ADMIN_PLAYER_IDS = ADMIN;
  const applicantToken = await makeVerifiedAccount(P1);
  await applyPOST(
    new Request("https://barkoba.test/api/beta/apply", {
      method: "POST",
      headers: { cookie: `bk_account_session=${applicantToken}` },
      body: "{}",
    }) as Parameters<typeof applyPOST>[0]
  );

  await registerPlayerAccount({ playerId: ADMIN, recoveryKey: "adminrk", displayName: "Admin" });
  const adminToken = await createAccountSession(ADMIN);

  const queue = await queueGET(
    new Request("https://barkoba.test/api/beta/admin/queue", {
      headers: { cookie: `bk_account_session=${adminToken}` },
    }) as Parameters<typeof queueGET>[0]
  );
  assert.equal(queue.status, 200);
  const queueBody = await queue.json();
  assert.equal(queueBody.applications.length, 1);
  const applicationId = queueBody.applications[0].application_id;

  const review = await reviewPOST(
    new Request("https://barkoba.test/api/beta/admin/review", {
      method: "POST",
      headers: { cookie: `bk_account_session=${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ target: "application", id: applicationId, decision: "approved" }),
    }) as Parameters<typeof reviewPOST>[0]
  );
  assert.equal(review.status, 200);
  assert.equal(applications[0]!.status, "approved");
  assert.equal(applications[0]!.reviewed_by, ADMIN);
});

test("an admin CANNOT approve their own application — self-review is refused even for an admin", async () => {
  process.env.ADMIN_PLAYER_IDS = ADMIN;
  await registerPlayerAccount({ playerId: ADMIN, recoveryKey: "adminrk", displayName: "Admin" });
  const row = accounts.get(ADMIN)!;
  row.email_verified_at = new Date().toISOString();
  const adminToken = await createAccountSession(ADMIN);

  await applyPOST(
    new Request("https://barkoba.test/api/beta/apply", {
      method: "POST",
      headers: { cookie: `bk_account_session=${adminToken}` },
      body: "{}",
    }) as Parameters<typeof applyPOST>[0]
  );
  const applicationId = applications[0]!.application_id;

  const review = await reviewPOST(
    new Request("https://barkoba.test/api/beta/admin/review", {
      method: "POST",
      headers: { cookie: `bk_account_session=${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ target: "application", id: applicationId, decision: "approved" }),
    }) as Parameters<typeof reviewPOST>[0]
  );
  assert.equal(review.status, 403);
  const body = await review.json();
  assert.equal(body.error, "self_review");
  assert.equal(applications[0]!.status, "pending", "the admin's own application must remain untouched");
});

test("a non-admin cannot review anyone's application, even with a correctly shaped request", async () => {
  const applicantToken = await makeVerifiedAccount(P1);
  await applyPOST(
    new Request("https://barkoba.test/api/beta/apply", {
      method: "POST",
      headers: { cookie: `bk_account_session=${applicantToken}` },
      body: "{}",
    }) as Parameters<typeof applyPOST>[0]
  );
  const applicationId = applications[0]!.application_id;

  const otherToken = await makeVerifiedAccount(P2); // verified, but NOT on the admin allowlist
  const review = await reviewPOST(
    new Request("https://barkoba.test/api/beta/admin/review", {
      method: "POST",
      headers: { cookie: `bk_account_session=${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ target: "application", id: applicationId, decision: "approved" }),
    }) as Parameters<typeof reviewPOST>[0]
  );
  assert.equal(review.status, 403);
  assert.equal(applications[0]!.status, "pending");
});

// ---------------------------------------------------------------------------
// Feedback: available to anonymous and registered players, with limits.
// ---------------------------------------------------------------------------

test("an unauthenticated (fully anonymous) caller can submit feedback", async () => {
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: JSON.stringify({ message: "Loved the last game!" }),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 200);
  assert.equal(feedbackRows.length, 1);
  assert.equal(feedbackRows[0]!.player_id, null);
});

test("a registered, verified player's feedback carries their player_id", async () => {
  const token = await makeVerifiedAccount(P1);
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}` },
      body: JSON.stringify({ message: "A suggestion for the history page." }),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 200);
  assert.equal(feedbackRows[0]!.player_id, P1);
});

test("feedback never requires Founding Tester approval — an applicant with no application at all can still submit", async () => {
  const token = await makeVerifiedAccount(P1);
  assert.equal(applications.length, 0);
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}` },
      body: JSON.stringify({ message: "No beta application on file, and that is fine." }),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 200);
});

test("an empty message is refused with a 400, not silently stored", async () => {
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: JSON.stringify({ message: "   " }),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 400);
  assert.equal(feedbackRows.length, 0);
});

test("a message over the server-side length limit is refused, not truncated and stored", async () => {
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: JSON.stringify({ message: "x".repeat(2001) }),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 400);
  assert.equal(feedbackRows.length, 0);
});

test("feedback preserves a safe, opaque game reference only — never fetches or stores game content", async () => {
  const gameId = "11111111-2222-3333-4444-555555555555";
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: JSON.stringify({ message: "This specific game was confusing.", game_id: gameId }),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 200);
  assert.equal(feedbackRows[0]!.operational_game_id, gameId);
});

test("a malformed game_id is silently dropped, not refused", async () => {
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: JSON.stringify({ message: "Still useful feedback.", game_id: "not-a-uuid" }),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 200);
  assert.equal(feedbackRows[0]!.operational_game_id, null);
});

test("feedback is rate-limited per (ip, identity): the 21st submission in an hour is refused", async () => {
  delete process.env.RATE_LIMIT_DISABLED;
  // lib/kv.ts falls back to a real, working in-memory KV when Upstash is not
  // configured (the ordinary state for this test run), so the limiter's
  // actual "not allowed" branch can be exercised for real rather than only
  // asserted structurally. A unique IP keeps this test's bucket isolated
  // from any other test in this file that might also submit feedback.
  const uniqueIp = "203.0.113.9";
  let lastStatus = 0;
  for (let i = 0; i < 21; i += 1) {
    const res = await feedbackPOST(
      new Request("https://barkoba.test/api/feedback", {
        method: "POST",
        headers: { "x-forwarded-for": uniqueIp },
        body: JSON.stringify({ message: `attempt ${i}` }),
      }) as Parameters<typeof feedbackPOST>[0]
    );
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429, "the 21st submission within the hour must be refused");
});

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 FINAL CORRECTION — admin-only discoverability link.
//
// The link to /admin/feedback (app/beta/admin/AdminReviewClient.tsx) is
// rendered ONLY inside the "loaded" branch, which the component reaches
// exclusively when GET /api/beta/admin/queue returns 200 — proven
// EXECUTABLY here for both the admin and non-admin cases. Combined with
// test/betaUi.test.ts's structural proof that the link sits inside exactly
// that branch (and nowhere else), this is the full claim: the link is
// reachable only for a caller this endpoint itself has already authorized.
// ---------------------------------------------------------------------------

test("the queue call that gates the admin feedback link's visibility succeeds ONLY for an authorized administrator", async () => {
  process.env.ADMIN_PLAYER_IDS = ADMIN;
  await registerPlayerAccount({ playerId: ADMIN, recoveryKey: "adminrk", displayName: "Admin" });
  const adminToken = await createAccountSession(ADMIN);

  const asAdmin = await queueGET(
    new Request("https://barkoba.test/api/beta/admin/queue", {
      headers: { cookie: `bk_account_session=${adminToken}` },
    }) as Parameters<typeof queueGET>[0]
  );
  assert.equal(asAdmin.status, 200, "an admin must reach the branch containing the link");

  const verifiedNonAdminToken = await makeVerifiedAccount(P2);
  const asVerifiedNonAdmin = await queueGET(
    new Request("https://barkoba.test/api/beta/admin/queue", {
      headers: { cookie: `bk_account_session=${verifiedNonAdminToken}` },
    }) as Parameters<typeof queueGET>[0]
  );
  assert.equal(asVerifiedNonAdmin.status, 403, "a verified non-admin must never reach the branch containing the link");

  const anonymous = await queueGET(
    new Request("https://barkoba.test/api/beta/admin/queue") as Parameters<typeof queueGET>[0]
  );
  assert.equal(anonymous.status, 403, "an anonymous caller must never reach the branch containing the link");
});
