import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { createAccountSession } from "../lib/accountSession";
import { registerPlayerAccount } from "../lib/playerAccounts";
import { GET as feedbackAdminGET } from "../app/api/feedback/admin/route";
import { POST as feedbackPOST } from "../app/api/feedback/route";

process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 COMPLETION — the admin feedback inbox.
//
// Reuses the same account-session fake idiom as test/betaRoutes.test.ts
// (registerPlayerAccount + createAccountSession are the REAL functions;
// only the SQL layer is faked), extended with feedback.submissions storage
// and retrieval.
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

interface FeedbackRow {
  submission_id: number;
  player_id: string | null;
  operational_game_id: string | null;
  category: string | null;
  language: string | null;
  message: string;
  created_at: string;
}

let accounts: Map<string, AccountRow>;
let sessions: Map<string, SessionRow>;
let feedbackRows: FeedbackRow[];
let nextCreatedAtMs: number;
let nextSubmissionId: number;
/** Explicit created_at (epoch ms) values a test wants the NEXT inserts to use, consumed FIFO. */
let pinnedTimestampsMs: number[];

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

  if (/INSERT INTO feedback\.submissions/.test(query)) {
    // Synthetic strictly-increasing timestamps by default, so insertion
    // order is deterministic and distinguishable even when several
    // submissions happen within the same millisecond of real wall-clock
    // time. A test may instead queue an explicit (possibly REPEATED)
    // timestamp via pinnedTimestampsMs, to model two rows genuinely sharing
    // the same created_at — the exact scenario a created_at-only cursor
    // would mishandle.
    const createdAtMs = pinnedTimestampsMs.length > 0 ? pinnedTimestampsMs.shift()! : ++nextCreatedAtMs;
    const submissionId = nextSubmissionId++;
    feedbackRows.push({
      submission_id: submissionId,
      player_id: v[0] === null ? null : String(v[0]),
      operational_game_id: v[1] === null ? null : String(v[1]),
      category: v[2] === null ? null : String(v[2]),
      language: v[3] === null ? null : String(v[3]),
      message: String(v[4]),
      created_at: new Date(createdAtMs).toISOString(),
    });
    return Promise.resolve([]);
  }

  if (/FROM feedback\.submissions/.test(query)) {
    // Stable ordering: (created_at DESC, submission_id DESC) — the exact
    // composite key the real query orders and filters by.
    const sorted = [...feedbackRows].sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      return b.submission_id - a.submission_id;
    });

    const hasCursor = /WHERE \(created_at, submission_id\) </.test(query);
    let rows = sorted;
    let limit: number;
    if (hasCursor) {
      const cursorCreatedAt = String(v[0]);
      const cursorSubmissionId = Number(v[1]);
      limit = Number(v[2]);
      rows = sorted.filter((r) => {
        if (r.created_at !== cursorCreatedAt) return r.created_at < cursorCreatedAt;
        return r.submission_id < cursorSubmissionId;
      });
    } else {
      limit = Number(v[0]);
    }
    return Promise.resolve(rows.slice(0, limit) as unknown as Record<string, unknown>[]);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (q: Promise<Record<string, unknown>[]>[]) => Promise.all(q);

const SAVED = {
  db: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
  admin: process.env.ADMIN_PLAYER_IDS,
  rateLimit: process.env.RATE_LIMIT_DISABLED,
  betaFlag: process.env.BETA_COMMUNITY_ENABLED,
};

beforeEach(() => {
  accounts = new Map();
  sessions = new Map();
  feedbackRows = [];
  nextCreatedAtMs = 1_700_000_000_000;
  nextSubmissionId = 1;
  pinnedTimestampsMs = [];
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  process.env.RATE_LIMIT_DISABLED = "true";
  delete process.env.ADMIN_PLAYER_IDS;
  delete process.env.BETA_COMMUNITY_ENABLED; // proves the inbox works with the beta flag OFF / unset
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  for (const [k, val] of Object.entries(SAVED)) {
    const envKey =
      k === "db" ? "DATABASE_URL" :
      k === "corpus" ? "CORPUS_ENABLED" :
      k === "admin" ? "ADMIN_PLAYER_IDS" :
      k === "betaFlag" ? "BETA_COMMUNITY_ENABLED" : "RATE_LIMIT_DISABLED";
    if (val === undefined) delete process.env[envKey];
    else process.env[envKey] = val;
  }
});

const P1 = "1".repeat(32);
const ADMIN = "a".repeat(32);

async function submitOne(message: string, lang?: string) {
  await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      headers: { "x-forwarded-for": `198.51.100.${feedbackRows.length + 1}` },
      body: JSON.stringify({ message, lang }),
    }) as Parameters<typeof feedbackPOST>[0]
  );
}

async function makeAdmin(): Promise<string> {
  process.env.ADMIN_PLAYER_IDS = ADMIN;
  await registerPlayerAccount({ playerId: ADMIN, recoveryKey: "adminrk", displayName: "Admin" });
  return createAccountSession(ADMIN);
}

async function makeVerifiedNonAdmin(): Promise<string> {
  await registerPlayerAccount({ playerId: P1, recoveryKey: "p1rk", displayName: "Player" });
  const row = accounts.get(P1)!;
  row.email_verified_at = new Date().toISOString();
  return createAccountSession(P1);
}

// ---------------------------------------------------------------------------
// Admin can retrieve; nobody else can.
// ---------------------------------------------------------------------------

test("an admin can retrieve feedback", async () => {
  await submitOne("Great game!");
  const token = await makeAdmin();

  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].message, "Great game!");
});

test("an anonymous caller cannot retrieve feedback", async () => {
  await submitOne("Secret note");
  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin") as Parameters<typeof feedbackAdminGET>[0]
  );
  assert.equal(res.status, 403);
});

test("a verified, registered, but NON-ADMIN caller cannot retrieve feedback", async () => {
  await submitOne("Secret note");
  const token = await makeVerifiedNonAdmin();
  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  assert.equal(res.status, 403);
});

test("another kind of non-admin (unverified account) cannot retrieve feedback either", async () => {
  await submitOne("Secret note");
  await registerPlayerAccount({ playerId: "9".repeat(32), recoveryKey: "unverifiedrk", displayName: "Unverified" });
  const token = await createAccountSession("9".repeat(32));
  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// Newest-first ordering; server-side limit/pagination.
// ---------------------------------------------------------------------------

test("results are ordered newest first", async () => {
  await submitOne("first");
  await submitOne("second");
  await submitOne("third");
  const token = await makeAdmin();

  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  const body = await res.json();
  assert.deepEqual(
    body.items.map((i: { message: string }) => i.message),
    ["third", "second", "first"]
  );
});

test("the server enforces a conservative page size and returns an opaque next_cursor, and the cursor page fetches strictly older rows", async () => {
  const token = await makeAdmin();
  for (let i = 0; i < 55; i += 1) {
    await submitOne(`message ${i}`);
  }

  const first = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  const firstBody = await first.json();
  assert.equal(firstBody.items.length, 50, "the page size must be capped, not all 55 rows at once");
  assert.equal(typeof firstBody.next_cursor, "string");
  assert.ok(firstBody.next_cursor.length > 0);
  // Opaque: not a plain timestamp, not a plain integer — a caller cannot
  // read a submission_id off it by inspection.
  assert.ok(!/^\d+$/.test(firstBody.next_cursor));
  assert.equal(Number.isNaN(Date.parse(firstBody.next_cursor)), true, "must not itself be a bare, directly-usable timestamp");

  const second = await feedbackAdminGET(
    new Request(`https://barkoba.test/api/feedback/admin?cursor=${encodeURIComponent(firstBody.next_cursor)}`, {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  const secondBody = await second.json();
  assert.equal(secondBody.items.length, 5, "the remaining 5 rows");
  assert.equal(secondBody.next_cursor, null);
  // No overlap between the two pages.
  const firstMessages = new Set(firstBody.items.map((i: { message: string }) => i.message));
  for (const item of secondBody.items) {
    assert.ok(!firstMessages.has(item.message), "the second page must not repeat a row from the first");
  }
});

// ---------------------------------------------------------------------------
// V2.9.0 Slice 1 FINAL CORRECTION — stable pagination under equal
// created_at values. This is the defect the correction exists to close: a
// created_at-only cursor can skip or duplicate rows when several
// submissions land in the same instant. (created_at, submission_id) as a
// composite, strictly-decreasing key cannot exhibit either failure.
// ---------------------------------------------------------------------------

test("two submissions with the EXACT SAME created_at are both returned, none skipped, across a page boundary", async () => {
  const token = await makeAdmin();
  const tiedMs = 1_800_000_000_000;
  // Two rows sharing one timestamp, straddling a page boundary: page size
  // is 50, so put 49 strictly-newer rows first, then the two tied rows,
  // forcing exactly one of the pair onto each side of the 50-row cut.
  for (let i = 0; i < 49; i += 1) await submitOne(`newer ${i}`);
  pinnedTimestampsMs.push(tiedMs, tiedMs);
  await submitOne("tied A");
  await submitOne("tied B");

  const first = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  const firstBody = await first.json();
  assert.equal(firstBody.items.length, 50);
  assert.ok(firstBody.next_cursor, "one of the tied pair must be pushed to a second page");

  const second = await feedbackAdminGET(
    new Request(`https://barkoba.test/api/feedback/admin?cursor=${encodeURIComponent(firstBody.next_cursor)}`, {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  const secondBody = await second.json();

  const allMessages = [...firstBody.items, ...secondBody.items].map((i: { message: string }) => i.message);
  assert.ok(allMessages.includes("tied A"), "tied A must not be skipped");
  assert.ok(allMessages.includes("tied B"), "tied B must not be skipped");
  assert.equal(allMessages.filter((m) => m === "tied A").length, 1, "tied A must not be duplicated");
  assert.equal(allMessages.filter((m) => m === "tied B").length, 1, "tied B must not be duplicated");
  assert.equal(allMessages.length, 51, "every one of the 51 submitted rows must appear exactly once in total");
});

test("ordering is deterministic even among rows sharing a created_at — repeating the same two-page walk yields the identical sequence", async () => {
  const tiedMs = 1_800_000_100_000;
  pinnedTimestampsMs.push(tiedMs, tiedMs, tiedMs);
  await submitOne("alpha");
  await submitOne("beta");
  await submitOne("gamma");
  const token = await makeAdmin();

  async function fullWalk(): Promise<string[]> {
    const messages: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url: string = cursor
        ? `https://barkoba.test/api/feedback/admin?cursor=${encodeURIComponent(cursor)}`
        : "https://barkoba.test/api/feedback/admin";
      const res = await feedbackAdminGET(
        new Request(url, { headers: { cookie: `bk_account_session=${token}` } }) as Parameters<typeof feedbackAdminGET>[0]
      );
      const body = await res.json();
      messages.push(...body.items.map((i: { message: string }) => i.message));
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    return messages;
  }

  const first = await fullWalk();
  const second = await fullWalk();
  assert.deepEqual(first, second, "the exact same ordering must be produced every time, tie or no tie");
  assert.deepEqual(first, ["gamma", "beta", "alpha"], "within a tie, submission_id DESC breaks the tie deterministically (most recently inserted first)");
});

// ---------------------------------------------------------------------------
// Malformed cursors fail safely.
// ---------------------------------------------------------------------------

test("a malformed cursor is rejected with a generic 400, leaking no implementation detail", async () => {
  const token = await makeAdmin();
  for (const badCursor of ["not-base64!!!", "", "   ", Buffer.from("no-separator-here").toString("base64url"), Buffer.from("garbage|notanumber").toString("base64url")]) {
    if (badCursor === "") continue; // an empty cursor param is treated as "no cursor" — covered separately.
    const res = await feedbackAdminGET(
      new Request(`https://barkoba.test/api/feedback/admin?cursor=${encodeURIComponent(badCursor)}`, {
        headers: { cookie: `bk_account_session=${token}` },
      }) as Parameters<typeof feedbackAdminGET>[0]
    );
    assert.equal(res.status, 400, `expected 400 for cursor ${JSON.stringify(badCursor)}`);
    const body = await res.json();
    assert.equal(body.error, "invalid_cursor");
    // No stack trace, no mention of base64/encoding/submission_id/timestamp format.
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /base64|submission_id|stack|Error:/i);
  }
});

test("a well-formed cursor pointing at a submission_id that never existed does not crash — it is a valid boundary, not a malformed token", async () => {
  const token = await makeAdmin();
  await submitOne("only one");
  // A well-formed (decodable, well-typed) cursor referencing a submission_id
  // that happens not to exist is NOT the "malformed" case this correction
  // targets — decodeCursor only validates SHAPE, matching a real cursor's
  // own contract (it is never re-verified against the table, the same way
  // an ordinary keyset boundary would not be). The only requirement is that
  // it behaves as a normal boundary rather than throwing.
  const bogusCursor = Buffer.from(`${new Date(1_600_000_000_000).toISOString()}|999999999`, "utf8").toString(
    "base64url"
  );
  const res = await feedbackAdminGET(
    new Request(`https://barkoba.test/api/feedback/admin?cursor=${encodeURIComponent(bogusCursor)}`, {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// No internal IDs, emails, provider/model info, or unrelated player data.
// ---------------------------------------------------------------------------

test("the response never includes player_id, an internal submission id, or anything beyond the approved field list", async () => {
  await submitOne("Feedback with identity attached", "hu");
  const token = await makeAdmin();
  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  const body = await res.json();
  const item = body.items[0];
  assert.deepEqual(
    Object.keys(item).sort(),
    ["created_at", "language", "message", "operational_game_id"].sort()
  );
});

// ---------------------------------------------------------------------------
// Feedback text cannot execute HTML.
// ---------------------------------------------------------------------------

test("SOURCE: the admin inbox never uses dangerouslySetInnerHTML — feedback is always rendered as a plain text child", () => {
  const src = readFileSync("app/admin/feedback/AdminFeedbackClient.tsx", "utf8");
  // Checks for actual JSX USAGE (the prop with its `=`), not the bare word —
  // this file's own comments legitimately mention the prop name to explain
  // why it is absent, which a plain substring scan would false-positive on.
  assert.doesNotMatch(src, /dangerouslySetInnerHTML\s*=/);
  assert.match(src, /\{item\.message\}/, "the message must be rendered as a plain JSX text child, which React auto-escapes");
});

test("a submission containing markup is stored and returned VERBATIM, unmodified — safety is React's rendering escape, not string mangling", async () => {
  const payload = "<script>alert(1)</script>";
  await submitOne(payload);
  const token = await makeAdmin();
  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  const body = await res.json();
  assert.equal(body.items[0].message, payload, "the server must not attempt its own escaping/stripping");
});

// ---------------------------------------------------------------------------
// Empty and failure states, Hungarian and English.
// ---------------------------------------------------------------------------

test("SOURCE: the inbox has bilingual empty and failure/forbidden copy", () => {
  const src = readFileSync("app/admin/feedback/AdminFeedbackClient.tsx", "utf8");
  assert.match(src, /Egyelőre nincs visszajelzés\./);
  assert.match(src, /No feedback yet\./);
  assert.match(src, /Nincs jogosultságod ehhez az oldalhoz\./);
  assert.match(src, /You are not authorized to view this page\./);
  assert.match(src, /A visszajelzések most nem érhetők el\./);
  assert.match(src, /Feedback is not available right now\./);
});

test("an empty inbox is a distinct, safe state, not an error", async () => {
  const token = await makeAdmin();
  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.items, []);
  assert.equal(body.next_cursor, null);
});

test("a store outage refuses with a clean 503, never a partial or fabricated list", async () => {
  const token = await makeAdmin();
  // Only feedback.submissions fails — account/session lookups (needed for
  // authorization itself to succeed) still work, so this genuinely tests
  // the DATA read failing closed, not authorization failing closed for an
  // unrelated reason.
  __setSqlClientForTests(((strings: TemplateStringsArray, ...values: SqlValue[]) => {
    const query = strings.join(" ");
    if (/FROM feedback\.submissions/.test(query)) return Promise.reject(new Error("neon unavailable"));
    return fakeSql(strings, ...values);
  }) as typeof fakeSql);
  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  assert.equal(res.status, 503);
});

// ---------------------------------------------------------------------------
// Feedback submission and /beta stay correctly independent of the flag.
// ---------------------------------------------------------------------------

test("feedback submission works with BETA_COMMUNITY_ENABLED unset/OFF, and so does the admin inbox reading it", async () => {
  assert.equal(process.env.BETA_COMMUNITY_ENABLED, undefined);
  await submitOne("Works with the flag off");
  const token = await makeAdmin();
  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  const body = await res.json();
  assert.equal(body.items.length, 1);
});

test("SOURCE: the admin feedback route does not check the beta flag at all", () => {
  const src = readFileSync("app/api/feedback/admin/route.ts", "utf8");
  assert.doesNotMatch(src, /betaCommunityEnabled|betaCommunityConfigured/);
});
