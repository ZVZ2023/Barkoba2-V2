import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { POST as feedbackPOST } from "../app/api/feedback/route";
import { GET as feedbackAdminGET } from "../app/api/feedback/admin/route";
import { createAccountSession } from "../lib/accountSession";
import { registerPlayerAccount } from "../lib/playerAccounts";

process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";

// ---------------------------------------------------------------------------
// V2.9.1 — the player-facing feedback surface: the standalone /feedback
// page, and the discreet per-game action on completed-game screens.
//
// The backend (POST /api/feedback, GET /api/feedback/admin) is UNCHANGED
// from V2.9.0 and already has its own full behavioral suite
// (test/betaRoutes.test.ts, test/adminFeedback.test.ts) -- this file does
// not re-prove server-side validation/rate-limiting/pagination from
// scratch. What is new here: (a) SOURCE-CONTRACT proof that the new client
// components send exactly the right wire shape and nothing more, matching
// this repo's established idiom for React components with no rendering
// harness, and (b) an end-to-end executable proof that the EXACT request
// shape these new components send round-trips correctly through the
// existing, unmodified backend into the existing, unmodified admin inbox.
// ---------------------------------------------------------------------------

const FEEDBACK_FORM = readFileSync("app/components/FeedbackForm.tsx", "utf8");
const FEEDBACK_ACTION = readFileSync("app/components/FeedbackAction.tsx", "utf8");
const FEEDBACK_PAGE = readFileSync("app/feedback/page.tsx", "utf8");
const FEEDBACK_PAGE_CLIENT = readFileSync("app/feedback/FeedbackPageClient.tsx", "utf8");
const RESULT_PANEL = readFileSync("app/game/[id]/ResultPanel.tsx", "utf8");
const RACER_CLIENT = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");
const HUMAN_CLIENT = readFileSync("app/game/[id]/HumanClient.tsx", "utf8");
const ROOT_PAGE = readFileSync("app/page.tsx", "utf8");

// ---------------------------------------------------------------------------
// Availability: no gate of any kind, regardless of account/beta status.
// ---------------------------------------------------------------------------

test("SOURCE: /feedback carries no flag check, no account check, no beta-membership check at all", () => {
  assert.doesNotMatch(FEEDBACK_PAGE, /betaCommunityEnabled|betaCommunityConfigured|isAdminPlayer|isBetaMember|notFound/);
  assert.doesNotMatch(FEEDBACK_PAGE_CLIENT, /resolveActingPlayer|account_required|membership_required/);
});

test("SOURCE: the standalone page works without a game reference — it never passes a gameId to FeedbackForm", () => {
  assert.doesNotMatch(FEEDBACK_PAGE_CLIENT, /gameId=/);
  assert.match(FEEDBACK_PAGE_CLIENT, /<FeedbackForm lang=\{lang\} \/>/);
});

// ---------------------------------------------------------------------------
// Data submitted: exactly message + lang + (optional) game_id. Nothing else.
// ---------------------------------------------------------------------------

test("SOURCE: the client sends exactly {message, lang, game_id?} — no target, guess, transcript, player identity, or provider/model field exists anywhere to send", () => {
  const bodyAt = FEEDBACK_FORM.indexOf("body: JSON.stringify(");
  const body = FEEDBACK_FORM.slice(bodyAt, FEEDBACK_FORM.indexOf("}),", bodyAt) + 3);
  assert.match(body, /message: trimmed/);
  assert.match(body, /lang,/);
  assert.match(body, /game_id: gameId/);
  for (const forbidden of [
    "target", "guess", "transcript", "revealed_target", "final_guess_text",
    "player_id", "playerId", "provider", "model", "racer_provider",
  ]) {
    assert.doesNotMatch(body, new RegExp(`\\b${forbidden}\\b`, "i"), `must never send "${forbidden}"`);
  }
});

test("SOURCE: FeedbackForm and FeedbackAction never IMPORT any game-content module", () => {
  // Checks actual import statements only — this file's own comments
  // legitimately name lib/corpus/gameCorpus.ts to explain why
  // FEEDBACK_MESSAGE_MAX_LENGTH is duplicated rather than imported, which a
  // plain substring scan over the whole file would false-positive on.
  for (const src of [FEEDBACK_FORM, FEEDBACK_ACTION]) {
    const imports = (src.match(/^\s*import[\s\S]*?from\s+["'][^"']+["']/gm) || []).join("\n");
    assert.doesNotMatch(imports, /gameView|gameStore|secretStore|gameCorpus/i);
  }
});

test("SOURCE: gameId is never rendered as a JSX text child — every occurrence is either a prop value or the fetch body's game_id key", () => {
  // Strip every KNOWN-SAFE occurrence (`someProp={gameId}` prop-passing, and
  // the `game_id: gameId` object-shorthand in the fetch body); anything
  // left over containing a bare `{gameId}` would be a JSX text render.
  for (const src of [FEEDBACK_FORM, FEEDBACK_ACTION]) {
    const stripped = src
      .replace(/\w+=\{gameId\}/g, "")
      .replace(/game_id:\s*gameId/g, "");
    assert.doesNotMatch(stripped, /\{gameId\}/, `${src === FEEDBACK_FORM ? "FeedbackForm" : "FeedbackAction"} must never render gameId as text`);
  }
});

test("SOURCE: each result screen wires the action to its OWN game's id and language, never a hardcoded or foreign value", () => {
  assert.match(RESULT_PANEL, /<FeedbackAction gameId=\{game\.game_id\} gameLanguage=\{game\.game_language\} \/>/);
  assert.match(RACER_CLIENT, /<FeedbackAction gameId=\{game\.game_id\} gameLanguage=\{game\.game_language\} \/>/);
  assert.match(HUMAN_CLIENT, /<FeedbackAction gameId=\{view\.game_id\} gameLanguage=\{view\.game_language\} \/>/);
});

// ---------------------------------------------------------------------------
// Discreet placement, approved bilingual label.
// ---------------------------------------------------------------------------

test("SOURCE: the collapsed action is a small text link, not a prominent button, and carries the exact approved bilingual label", () => {
  assert.match(FEEDBACK_ACTION, /"Send feedback"/);
  assert.match(FEEDBACK_ACTION, /"Visszajelzés küldése"/);
  // Discreet styling: text link classes, not the primary button treatment
  // ("Új játék" uses bg-[var(--green)]" + larger padding; this must not).
  const collapsedAt = FEEDBACK_ACTION.indexOf("if (!open)");
  const collapsedBlock = FEEDBACK_ACTION.slice(collapsedAt, FEEDBACK_ACTION.indexOf(";", FEEDBACK_ACTION.indexOf("</button>", collapsedAt)));
  assert.match(collapsedBlock, /underline-offset-2 hover:underline/);
  assert.doesNotMatch(collapsedBlock, /bg-\[var\(--green\)\]/);
});

test("SOURCE: the action does not appear before the primary 'Új játék' / new-game link in either GameClient's or RacerClient's result markup", () => {
  const panelNewGameAt = RESULT_PANEL.indexOf("Új játék");
  const panelActionAt = RESULT_PANEL.indexOf("<FeedbackAction");
  assert.ok(panelNewGameAt > 0 && panelActionAt > panelNewGameAt);

  const racerNewGameAt = RACER_CLIENT.indexOf("Új játék");
  const racerActionAt = RACER_CLIENT.indexOf("<FeedbackAction");
  assert.ok(racerNewGameAt > 0 && racerActionAt > racerNewGameAt);
});

// ---------------------------------------------------------------------------
// Character count, maximum length, validation.
// ---------------------------------------------------------------------------

test("SOURCE: the form shows a live character count against the server's own maximum, and the textarea is hard-capped at it", () => {
  assert.match(FEEDBACK_FORM, /const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;/);
  assert.match(FEEDBACK_FORM, /\{message\.length\} \/ \{FEEDBACK_MESSAGE_MAX_LENGTH\}/);
  assert.match(FEEDBACK_FORM, /maxLength=\{FEEDBACK_MESSAGE_MAX_LENGTH\}/);
});

test("SOURCE: an empty message cannot be submitted — the submit button is disabled, and a client-side check refuses it even so", () => {
  assert.match(FEEDBACK_FORM, /disabled=\{submitting \|\| message\.trim\(\)\.length === 0\}/);
  assert.match(FEEDBACK_FORM, /if \(trimmed\.length === 0\) \{/);
});

// ---------------------------------------------------------------------------
// Repeated taps cannot duplicate a submission.
// ---------------------------------------------------------------------------

test("SOURCE: a synchronous ref guard, checked before any state update, prevents a double-tap from firing twice", () => {
  assert.match(FEEDBACK_FORM, /const submittingRef = useRef\(false\);/);
  const submitAt = FEEDBACK_FORM.indexOf("async function submit()");
  const submitBody = FEEDBACK_FORM.slice(submitAt, submitAt + 200);
  assert.match(submitBody, /if \(submittingRef\.current\) return;/, "the guard must be the FIRST check inside submit()");
  assert.match(FEEDBACK_FORM, /submittingRef\.current = true;/);
  assert.match(FEEDBACK_FORM, /submittingRef\.current = false;/);
});

// ---------------------------------------------------------------------------
// Rate-limit, network-failure, and unavailability states are distinct and
// understandable, in both languages.
// ---------------------------------------------------------------------------

test("SOURCE: rate-limit (429), network failure, and service unavailability (503) each have their OWN distinct, bilingual message", () => {
  assert.match(FEEDBACK_FORM, /if \(res\.status === 429\)/);
  assert.match(FEEDBACK_FORM, /rateLimitError: "Túl sok visszajelzés érkezett/);
  assert.match(FEEDBACK_FORM, /rateLimitError: "Too many submissions/);

  assert.match(FEEDBACK_FORM, /catch \{[\s\S]*?networkError/);
  assert.match(FEEDBACK_FORM, /networkError: "Hálózati hiba/);
  assert.match(FEEDBACK_FORM, /networkError: "Network error/);

  assert.match(FEEDBACK_FORM, /if \(!res\.ok\) \{/);
  assert.match(FEEDBACK_FORM, /unavailableError: "Most nem sikerült elküldeni/);
  assert.match(FEEDBACK_FORM, /unavailableError: "Could not send feedback/);
});

test("SOURCE: a successful submission shows a clear confirmation, in both languages", () => {
  assert.match(FEEDBACK_FORM, /success: "Köszönjük a visszajelzést!"/);
  assert.match(FEEDBACK_FORM, /success: "Thanks for your feedback!"/);
  assert.match(FEEDBACK_FORM, /step\.kind === "success"/);
});

// ---------------------------------------------------------------------------
// Hungarian and English copy — complete, parallel key sets.
// ---------------------------------------------------------------------------

test("SOURCE: FeedbackForm's copy object has complete, parallel Hungarian and English keys", () => {
  const huKeys = [...FEEDBACK_FORM.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]!);
  const uniqueKeys = [...new Set(huKeys)];
  assert.ok(uniqueKeys.length >= 8);
  for (const key of uniqueKeys) {
    assert.equal(huKeys.filter((k) => k === key).length % 2, 0, `"${key}" must exist in both hu and en`);
  }
});

test("SOURCE: FeedbackPageClient's own intro copy is complete in both languages", () => {
  assert.match(FEEDBACK_PAGE_CLIENT, /hu: \{/);
  assert.match(FEEDBACK_PAGE_CLIENT, /en: \{/);
  assert.match(FEEDBACK_PAGE_CLIENT, /title: "Visszajelzés"/);
  assert.match(FEEDBACK_PAGE_CLIENT, /title: "Feedback"/);
});

// ---------------------------------------------------------------------------
// User text cannot execute HTML.
// ---------------------------------------------------------------------------

test("SOURCE: no new file ever uses dangerouslySetInnerHTML", () => {
  for (const src of [FEEDBACK_FORM, FEEDBACK_ACTION, FEEDBACK_PAGE_CLIENT]) {
    assert.doesNotMatch(src, /dangerouslySetInnerHTML\s*=/);
  }
});

// ---------------------------------------------------------------------------
// Mobile usability, no file uploads / email field / public display.
// ---------------------------------------------------------------------------

test("SOURCE: no file input, no email field, and no public-display rendering exist anywhere in the new surface", () => {
  for (const src of [FEEDBACK_FORM, FEEDBACK_ACTION, FEEDBACK_PAGE_CLIENT]) {
    assert.doesNotMatch(src, /type="file"|type="email"/);
  }
});

test("SOURCE: the compact (embedded) form uses a smaller textarea, and every touch target meets the existing min-h-11 convention", () => {
  assert.match(FEEDBACK_FORM, /compact \? "h-20" : "h-32"/);
  assert.match(FEEDBACK_FORM, /min-h-11/);
});

// ---------------------------------------------------------------------------
// Root page and gameplay behavior unchanged.
// ---------------------------------------------------------------------------

test("SOURCE: app/page.tsx has no reference to /feedback and is otherwise unchanged", () => {
  assert.match(ROOT_PAGE, /<Stage \/>/);
  assert.match(ROOT_PAGE, /<FrontDoor version=\{label\} \/>/);
  assert.doesNotMatch(ROOT_PAGE, /feedback|Feedback/);
});

test("SOURCE: gameplay/turn/resolve routes are untouched by this feature — no reference to feedback anywhere in them", () => {
  for (const file of [
    "app/api/game/create/route.ts",
    "app/api/game/[id]/turn/route.ts",
    "app/api/game/[id]/resolve/route.ts",
    "app/api/game/[id]/ask/route.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /feedback/i, `${file} must not reference feedback`);
  }
});

// ---------------------------------------------------------------------------
// End-to-end: the EXACT wire shape the new client sends round-trips
// correctly through the existing, unmodified backend and admin inbox.
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
let nextSubmissionId: number;
let nextCreatedAtMs: number;

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
    feedbackRows.push({
      submission_id: nextSubmissionId++,
      player_id: v[0] === null ? null : String(v[0]),
      operational_game_id: v[1] === null ? null : String(v[1]),
      category: v[2] === null ? null : String(v[2]),
      language: v[3] === null ? null : String(v[3]),
      message: String(v[4]),
      created_at: new Date(++nextCreatedAtMs).toISOString(),
    });
    return Promise.resolve([]);
  }
  if (/FROM feedback\.submissions/.test(query)) {
    const sorted = [...feedbackRows].sort((a, b) =>
      a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : b.submission_id - a.submission_id
    );
    const limit = /WHERE \(created_at, submission_id\) </.test(query) ? Number(v[2]) : Number(v[0]);
    return Promise.resolve(sorted.slice(0, limit) as unknown as Record<string, unknown>[]);
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
  nextSubmissionId = 1;
  nextCreatedAtMs = 1_750_000_000_000;
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  process.env.RATE_LIMIT_DISABLED = "true";
  delete process.env.ADMIN_PLAYER_IDS;
  delete process.env.BETA_COMMUNITY_ENABLED;
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

const P1 = "5".repeat(32);
const ADMIN = "d".repeat(32);
const GAME_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** The EXACT body shape FeedbackForm.tsx constructs for its fetch call. */
function clientWireBody(message: string, lang: "hu" | "en", gameId?: string) {
  return JSON.stringify({ message, lang, ...(gameId ? { game_id: gameId } : {}) });
}

async function makeAdmin(): Promise<string> {
  process.env.ADMIN_PLAYER_IDS = ADMIN;
  await registerPlayerAccount({ playerId: ADMIN, recoveryKey: "adminrk", displayName: "Admin" });
  return createAccountSession(ADMIN);
}

test("anonymous submission via the exact standalone-page wire shape (no game_id) works", async () => {
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: clientWireBody("Great game, minor UI nit on mobile.", "hu"),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 200);
  assert.equal(feedbackRows.length, 1);
  assert.equal(feedbackRows[0]!.player_id, null);
  assert.equal(feedbackRows[0]!.operational_game_id, null);
});

test("registered submission via the exact standalone-page wire shape works and carries the player's id server-side", async () => {
  await registerPlayerAccount({ playerId: P1, recoveryKey: "p1rk", displayName: "Player" });
  const token = await createAccountSession(P1);
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}` },
      body: clientWireBody("Loved the Friendly mode tone.", "en"),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 200);
  assert.equal(feedbackRows[0]!.player_id, P1);
});

test("beta flag OFF does not hide or disable feedback submission", async () => {
  assert.equal(process.env.BETA_COMMUNITY_ENABLED, undefined);
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: clientWireBody("Works with the beta program entirely off.", "hu"),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 200);
});

test("result-screen feedback via the exact embedded wire shape carries the game_id, and it is never displayed anywhere in the response the player receives", async () => {
  const res = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: clientWireBody("The Racer's final question felt like a guess.", "hu", GAME_ID),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  // The success response is a bare {ok:true} — the game id is never echoed
  // back to the player who just submitted it.
  assert.deepEqual(body, { ok: true });
  assert.equal(feedbackRows[0]!.operational_game_id, GAME_ID);
});

test("empty and oversized messages are rejected server-side even if a client-side check were ever bypassed", async () => {
  const empty = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: clientWireBody("   ", "hu"),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(empty.status, 400);

  const oversized = await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: clientWireBody("x".repeat(2001), "hu"),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  assert.equal(oversized.status, 400);
  assert.equal(feedbackRows.length, 0, "neither refused attempt may write a row");
});

test("the existing admin inbox receives the submitted language, message, and game reference from the new client's exact wire shape, unmodified", async () => {
  await feedbackPOST(
    new Request("https://barkoba.test/api/feedback", {
      method: "POST",
      body: clientWireBody("<b>bold</b> feedback with markup", "en", GAME_ID),
    }) as Parameters<typeof feedbackPOST>[0]
  );
  const adminToken = await makeAdmin();
  const res = await feedbackAdminGET(
    new Request("https://barkoba.test/api/feedback/admin", {
      headers: { cookie: `bk_account_session=${adminToken}` },
    }) as Parameters<typeof feedbackAdminGET>[0]
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].language, "en");
  assert.equal(body.items[0].message, "<b>bold</b> feedback with markup", "stored and returned VERBATIM — safety is the admin UI's rendering escape, not server-side stripping");
  assert.equal(body.items[0].operational_game_id, GAME_ID);
});
