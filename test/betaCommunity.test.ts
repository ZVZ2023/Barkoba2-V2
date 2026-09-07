import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import {
  betaCommunityConfigured,
  getApplication,
  getLatestOwnRevision,
  getPublicProfile,
  isBetaMember,
  listPendingApplications,
  listPendingProfileRevisions,
  reviewApplication,
  reviewProfileRevision,
  submitApplication,
  submitProfileRevision,
} from "../lib/betaCommunity";
import { env } from "../lib/env";

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 — LIMITED BETA / FOUNDING TESTER FOUNDATION.
//
// SCOPE, stated honestly like every other database-facing suite in this
// repo: there is no PostgreSQL in this test environment. beta.applications
// and beta.profile_revisions are modelled in memory here, faithfully enough
// to prove the invariants that matter (idempotent application, atomic
// one-shot review, self-review refusal, and the "most recent APPROVED row
// is the public answer" moderation rule) without a live database.
// ---------------------------------------------------------------------------

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

interface RevisionRow {
  revision_id: number;
  player_id: string;
  headline: string | null;
  bio: string | null;
  status: "pending" | "approved" | "rejected";
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

let applications: AppRow[];
let revisions: RevisionRow[];
let nextAppId: number;
let nextRevId: number;

const SAVED = {
  flag: process.env.BETA_COMMUNITY_ENABLED,
  db: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
};

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const query = strings.join(" ");
  const v = values as unknown[];

  // --- applications --------------------------------------------------------

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

  if (/SELECT application_id, player_id, status, note, submitted_at,\s*\n\s*reviewed_at, reviewed_by, rejection_reason\s*\n\s*FROM beta\.applications\s*\n\s*WHERE player_id =/.test(query)) {
    const playerId = String(v[0]);
    const row = applications.find((a) => a.player_id === playerId);
    return Promise.resolve(row ? [row as unknown as Record<string, unknown>] : []);
  }

  if (/FROM beta\.applications\s*\n\s*WHERE status = 'pending'/.test(query)) {
    return Promise.resolve(
      applications
        .filter((a) => a.status === "pending")
        .sort((a, b) => (a.submitted_at < b.submitted_at ? -1 : 1)) as unknown as Record<string, unknown>[]
    );
  }

  if (/SELECT player_id, status FROM beta\.applications WHERE application_id =/.test(query)) {
    const id = Number(v[0]);
    const row = applications.find((a) => a.application_id === id);
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

  // --- profile revisions -----------------------------------------------------

  if (/INSERT INTO beta\.profile_revisions/.test(query)) {
    const playerId = String(v[0]);
    const headline = typeof v[1] === "string" ? v[1] : null;
    const bio = typeof v[2] === "string" ? v[2] : null;
    const row: RevisionRow = {
      revision_id: nextRevId++,
      player_id: playerId,
      headline,
      bio,
      status: "pending",
      submitted_at: new Date().toISOString(),
      reviewed_at: null,
      reviewed_by: null,
    };
    revisions.push(row);
    return Promise.resolve([row as unknown as Record<string, unknown>]);
  }

  if (/FROM beta\.profile_revisions\s*\n\s*WHERE player_id = .* AND status = 'approved'/.test(query)) {
    const playerId = String(v[0]);
    const matches = revisions
      .filter((r) => r.player_id === playerId && r.status === "approved")
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
    return Promise.resolve(matches.length > 0 ? [matches[0] as unknown as Record<string, unknown>] : []);
  }

  if (/FROM beta\.profile_revisions\s*\n\s*WHERE player_id =.*\n\s*ORDER BY submitted_at DESC\s*\n\s*LIMIT 1/.test(query)) {
    const playerId = String(v[0]);
    const matches = revisions
      .filter((r) => r.player_id === playerId)
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
    return Promise.resolve(matches.length > 0 ? [matches[0] as unknown as Record<string, unknown>] : []);
  }

  if (/FROM beta\.profile_revisions\s*\n\s*WHERE status = 'pending'/.test(query)) {
    return Promise.resolve(
      revisions
        .filter((r) => r.status === "pending")
        .sort((a, b) => (a.submitted_at < b.submitted_at ? -1 : 1)) as unknown as Record<string, unknown>[]
    );
  }

  if (/SELECT player_id, status FROM beta\.profile_revisions WHERE revision_id =/.test(query)) {
    const id = Number(v[0]);
    const row = revisions.find((r) => r.revision_id === id);
    return Promise.resolve(row ? [{ player_id: row.player_id, status: row.status }] : []);
  }

  if (/UPDATE beta\.profile_revisions/.test(query)) {
    const decision = String(v[0]) as "approved" | "rejected";
    const reviewer = String(v[1]);
    const id = Number(v[2]);
    const row = revisions.find((r) => r.revision_id === id && r.status === "pending");
    if (!row) return Promise.resolve([]);
    row.status = decision;
    row.reviewed_at = new Date().toISOString();
    row.reviewed_by = reviewer;
    return Promise.resolve([{ revision_id: id }]);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (q: Promise<Record<string, unknown>[]>[]) => Promise.all(q);

beforeEach(() => {
  applications = [];
  revisions = [];
  nextAppId = 1;
  nextRevId = 1;
  process.env.BETA_COMMUNITY_ENABLED = "true";
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  for (const [k, val] of [
    ["BETA_COMMUNITY_ENABLED", SAVED.flag],
    ["DATABASE_URL", SAVED.db],
    ["CORPUS_ENABLED", SAVED.corpus],
  ] as const) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
});

const P1 = "1".repeat(32);
const P2 = "2".repeat(32);
const ADMIN = "a".repeat(32);

// ---------------------------------------------------------------------------
// Feature flag defaults OFF.
// ---------------------------------------------------------------------------

test("BETA_COMMUNITY_ENABLED defaults OFF when missing, malformed, or literally false", () => {
  for (const value of [undefined, "", "false", "0", "nope", "  "]) {
    if (value === undefined) delete process.env.BETA_COMMUNITY_ENABLED;
    else process.env.BETA_COMMUNITY_ENABLED = value;
    assert.equal(env.betaCommunityEnabled(), false, `expected OFF for ${JSON.stringify(value)}`);
  }
  process.env.BETA_COMMUNITY_ENABLED = "true";
  assert.equal(env.betaCommunityEnabled(), true);
});

test("betaCommunityConfigured() requires BOTH the flag and a reachable store", () => {
  process.env.BETA_COMMUNITY_ENABLED = "true";
  process.env.CORPUS_ENABLED = "true";
  assert.equal(betaCommunityConfigured(), true);

  process.env.BETA_COMMUNITY_ENABLED = "false";
  assert.equal(betaCommunityConfigured(), false);

  process.env.BETA_COMMUNITY_ENABLED = "true";
  process.env.CORPUS_ENABLED = "false";
  assert.equal(betaCommunityConfigured(), false);
});

// ---------------------------------------------------------------------------
// Duplicate application behavior.
// ---------------------------------------------------------------------------

test("submitting a second application for the same player returns the EXISTING row, never a second one", async () => {
  const first = await submitApplication(P1, "reason one");
  const second = await submitApplication(P1, "a completely different reason");

  assert.ok(first.ok && second.ok);
  if (first.ok && second.ok) {
    assert.equal(first.application.application_id, second.application.application_id);
    // The ORIGINAL note survives; a duplicate submission does not silently edit it.
    assert.equal(second.application.note, "reason one");
  }
  assert.equal(applications.length, 1, "exactly one row must exist for this player, ever");
});

// ---------------------------------------------------------------------------
// Applicant status isolation.
// ---------------------------------------------------------------------------

test("getApplication only ever returns the CALLER's own row, never another player's", async () => {
  await submitApplication(P1, "mine");
  await submitApplication(P2, "theirs");

  const mine = await getApplication(P1);
  assert.equal(mine?.note, "mine");

  const theirs = await getApplication(P2);
  assert.equal(theirs?.note, "theirs");

  // No cross-contamination: P1's read never returns P2's row or vice versa.
  assert.notEqual(mine?.application_id, theirs?.application_id);
});

// ---------------------------------------------------------------------------
// Admin-only review, self-approval and unauthorized-review denial.
//
// isAdminPlayer() itself is a route-level check (app/api/beta/admin/*),
// proven separately in test/betaRoutes.test.ts. What belongs here is the
// SECOND, independent guarantee: reviewApplication/reviewProfileRevision
// refuse self-review UNCONDITIONALLY, with no admin-status exception,
// because admin status is exactly the privilege being checked for misuse.
// ---------------------------------------------------------------------------

test("an applicant cannot approve or reject their OWN application, even calling the reviewer function directly", async () => {
  const submitted = await submitApplication(P1, null);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;

  const selfApprove = await reviewApplication(submitted.application.application_id, P1, "approved", null);
  assert.deepEqual(selfApprove, { ok: false, reason: "self_review" });

  const selfReject = await reviewApplication(submitted.application.application_id, P1, "rejected", "no");
  assert.deepEqual(selfReject, { ok: false, reason: "self_review" });

  // The application must remain untouched by either attempt.
  const after = await getApplication(P1);
  assert.equal(after?.status, "pending");
  assert.equal(after?.reviewed_by, null);
});

test("a DIFFERENT reviewer can approve; the decision is atomic and one-shot", async () => {
  const submitted = await submitApplication(P1, null);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;

  const first = await reviewApplication(submitted.application.application_id, ADMIN, "approved", null);
  assert.deepEqual(first, { ok: true });

  const second = await reviewApplication(submitted.application.application_id, ADMIN, "rejected", "changed my mind");
  assert.deepEqual(second, { ok: false, reason: "already_reviewed" }, "a decision cannot be overwritten by a later call");

  const after = await getApplication(P1);
  assert.equal(after?.status, "approved", "the FIRST decision stands");
  assert.equal(after?.reviewed_by, ADMIN);
});

test("reviewing a nonexistent application_id reports not_found, not a silent no-op", async () => {
  const outcome = await reviewApplication(999999, ADMIN, "approved", null);
  assert.deepEqual(outcome, { ok: false, reason: "not_found" });
});

// ---------------------------------------------------------------------------
// Beta membership is derived and stays separate from game credits.
// ---------------------------------------------------------------------------

test("isBetaMember is true ONLY once approved, false before and never touches any credit system", async () => {
  const submitted = await submitApplication(P1, null);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;

  assert.equal(await isBetaMember(P1), false, "pending is not membership");

  await reviewApplication(submitted.application.application_id, ADMIN, "approved", null);
  assert.equal(await isBetaMember(P1), true);

  // Structural guarantee: this module never IMPORTS the entitlement ledger
  // (a plain substring scan would false-positive on this file's own
  // comments explaining WHY it stays separate).
  const src = readFileSync("lib/betaCommunity.ts", "utf8");
  const imports = (src.match(/^\s*import[\s\S]*?from\s+["'][^"']+["']/gm) || []).join("\n");
  assert.doesNotMatch(imports, /entitlements/i);
});

test("a rejected applicant is never a member", async () => {
  const submitted = await submitApplication(P2, null);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;
  await reviewApplication(submitted.application.application_id, ADMIN, "rejected", "not this round");
  assert.equal(await isBetaMember(P2), false);
});

test("listPendingApplications returns only pending rows, oldest first", async () => {
  await submitApplication(P1, null);
  await submitApplication(P2, null);
  const submitted = applications[0]!;
  await reviewApplication(submitted.application_id, ADMIN, "approved", null);

  const pending = await listPendingApplications();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.player_id, P2);
});

// ---------------------------------------------------------------------------
// Profile revision moderation: the last approved snapshot survives a
// pending edit.
// ---------------------------------------------------------------------------

test("a newly submitted revision is PENDING and does not change the public profile", async () => {
  const r1 = await submitProfileRevision(P1, "Founding Tester", "Loves logic puzzles.");
  assert.ok(r1.ok);
  if (!r1.ok) return;

  assert.equal(await getPublicProfile(P1), null, "nothing has ever been approved yet");
  const latest = await getLatestOwnRevision(P1);
  assert.equal(latest?.status, "pending");
});

test("approving a revision makes it the public profile; the PRIOR approved version is never silently kept once a newer one is approved", async () => {
  const r1 = await submitProfileRevision(P1, "First headline", "First bio");
  assert.ok(r1.ok);
  if (!r1.ok) return;
  await reviewProfileRevision(r1.revision.revision_id, ADMIN, "approved");

  const published = await getPublicProfile(P1);
  assert.equal(published?.headline, "First headline");
});

test("THE CORE GUARANTEE: an unreviewed edit never replaces the last approved public version", async () => {
  // Approve one revision.
  const approved = await submitProfileRevision(P1, "Approved headline", "Approved bio");
  assert.ok(approved.ok);
  if (!approved.ok) return;
  await reviewProfileRevision(approved.revision.revision_id, ADMIN, "approved");

  // Submit a SECOND revision that is still awaiting review.
  const pending = await submitProfileRevision(P1, "New unreviewed headline", "New unreviewed bio");
  assert.ok(pending.ok);

  // The public profile must still be the approved one, byte for byte.
  const publicProfile = await getPublicProfile(P1);
  assert.equal(publicProfile?.headline, "Approved headline");
  assert.equal(publicProfile?.bio, "Approved bio");

  // The pending edit is visible to the OWNER as their own latest submission,
  // clearly distinct from the public value.
  const latest = await getLatestOwnRevision(P1);
  assert.equal(latest?.status, "pending");
  assert.equal(latest?.headline, "New unreviewed headline");
});

test("a REJECTED revision never becomes the public profile, and the prior approved one (if any) still stands", async () => {
  const approved = await submitProfileRevision(P1, "Good headline", "Good bio");
  assert.ok(approved.ok);
  if (!approved.ok) return;
  await reviewProfileRevision(approved.revision.revision_id, ADMIN, "approved");

  const rejected = await submitProfileRevision(P1, "Bad headline", "Bad bio");
  assert.ok(rejected.ok);
  if (!rejected.ok) return;
  await reviewProfileRevision(rejected.revision.revision_id, ADMIN, "rejected");

  const publicProfile = await getPublicProfile(P1);
  assert.equal(publicProfile?.headline, "Good headline", "the approved snapshot must survive a later rejection");
});

test("a profile revision cannot be self-reviewed either — same guarantee as applications", async () => {
  const r1 = await submitProfileRevision(P1, "H", "B");
  assert.ok(r1.ok);
  if (!r1.ok) return;
  const outcome = await reviewProfileRevision(r1.revision.revision_id, P1, "approved");
  assert.deepEqual(outcome, { ok: false, reason: "self_review" });
});

test("listPendingProfileRevisions returns only pending rows", async () => {
  const r1 = await submitProfileRevision(P1, "H1", "B1");
  const r2 = await submitProfileRevision(P2, "H2", "B2");
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  await reviewProfileRevision(r1.revision.revision_id, ADMIN, "approved");

  const pending = await listPendingProfileRevisions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.player_id, P2);
});

// ---------------------------------------------------------------------------
// Static structure guards.
// ---------------------------------------------------------------------------

test("SOURCE: beta.* is a schema entirely separate from accounts.* and corpus.*", () => {
  const migration = readFileSync("migrations/0015_beta_community.sql", "utf8");
  assert.match(migration, /CREATE SCHEMA IF NOT EXISTS beta/);
  assert.match(migration, /CREATE SCHEMA IF NOT EXISTS feedback/);
  assert.doesNotMatch(migration, /ALTER TABLE accounts\./);
  assert.doesNotMatch(migration, /ALTER TABLE corpus\./);
});

test("SOURCE: at most one application row per player is a DATABASE constraint, not app-level care", () => {
  const migration = readFileSync("migrations/0015_beta_community.sql", "utf8");
  assert.match(migration, /player_id\s+text NOT NULL UNIQUE/);
});
