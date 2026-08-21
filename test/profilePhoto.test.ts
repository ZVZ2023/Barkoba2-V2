import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { createAccountSession } from "../lib/accountSession";
import { registerPlayerAccount, getPlayerAccount, setAccountPhotoUrl } from "../lib/playerAccounts";
import { isAllowedPhotoType, isPhotoSizeAllowed, uploadProfilePhoto } from "../lib/photoUpload";
import { PLAYER_HEADER } from "../lib/playerIdentity";
import { POST as uploadPhoto } from "../app/api/account/photo/route";

// ---------------------------------------------------------------------------
// V2.6.x — profile photo upload: validation, the real Vercel Blob
// integration, setAccountPhotoUrl, and POST /api/account/photo. This route
// uses only req.headers and req.formData(), so — unlike register/route.ts —
// it is fully directly testable, and every layer here is behavioral, not
// structural.
//
// @vercel/blob calls `fetch` imported FROM UNDICI, not the ambient global —
// confirmed by reading node_modules/@vercel/blob/dist/chunk-YYMLUMXS.js
// ("import { fetch } from 'undici'"). Reassigning globalThis.fetch therefore
// would not intercept it; undici's own MockAgent, the mechanism it documents
// for exactly this case, is what actually sits in the request path.
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

  if (/UPDATE accounts\.players/.test(query) && /SET photo_url =/.test(query)) {
    const photoUrl = v[0] === null ? null : String(v[0]);
    const playerId = String(v[1]);
    const row = accounts.get(playerId);
    if (!row || row.disabled_at) return Promise.resolve([]);
    row.photo_url = photoUrl;
    return Promise.resolve([{ player_id: playerId }]);
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

const BLOB_ENV_VARS = ["BLOB_READ_WRITE_TOKEN", "VERCEL_BLOB_RETRIES"] as const;
let savedBlobEnv: Record<string, string | undefined>;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
let mockAgent: MockAgent;

beforeEach(() => {
  savedBlobEnv = Object.fromEntries(BLOB_ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of BLOB_ENV_VARS) delete process.env[k];
  // No retries: a mocked failure response must be observed once, immediately,
  // not after undici's own backoff/retry loop for a real transient error.
  process.env.VERCEL_BLOB_RETRIES = "0";

  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  for (const k of BLOB_ENV_VARS) {
    if (savedBlobEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedBlobEnv[k];
  }
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

/** Intercepts the one PUT @vercel/blob's put() issues for a plain (non-multipart) upload. */
function mockBlobPut(reply: { statusCode: number; body: Record<string, unknown> }) {
  mockAgent
    .get("https://vercel.com")
    .intercept({ path: /^\/api\/blob\/.*/, method: "PUT" })
    .reply(reply.statusCode, reply.body, {
      headers: { "content-type": "application/json" },
    });
}

function photoFile(overrides: { name?: string; type?: string; bytes?: number } = {}): File {
  const bytes = overrides.bytes ?? 1024;
  return new File([new Uint8Array(bytes)], overrides.name ?? "photo.jpg", {
    type: overrides.type ?? "image/jpeg",
  });
}

// ---------------------------------------------------------------------------
// Pure validators and the stub.
// ---------------------------------------------------------------------------

test("isAllowedPhotoType accepts exactly jpeg/png/webp", () => {
  for (const ok of ["image/jpeg", "image/png", "image/webp"]) assert.equal(isAllowedPhotoType(ok), true, ok);
  for (const bad of ["image/gif", "image/svg+xml", "application/pdf", "", "text/plain"]) {
    assert.equal(isAllowedPhotoType(bad), false, bad);
  }
});

test("isPhotoSizeAllowed enforces a positive size within the 5 MB cap", () => {
  assert.equal(isPhotoSizeAllowed(1), true);
  assert.equal(isPhotoSizeAllowed(5 * 1024 * 1024), true);
  assert.equal(isPhotoSizeAllowed(5 * 1024 * 1024 + 1), false);
  assert.equal(isPhotoSizeAllowed(0), false);
  assert.equal(isPhotoSizeAllowed(-1), false);
  assert.equal(isPhotoSizeAllowed(NaN), false);
});

test("uploadProfilePhoto throws, without touching the network, when BLOB_READ_WRITE_TOKEN is unset", async () => {
  await assert.rejects(
    () => uploadProfilePhoto(photoFile()),
    /BLOB_READ_WRITE_TOKEN is not set/
  );
  // MockAgent.disableNetConnect() means any real attempt would itself throw
  // a distinct "connect ECONNREFUSED"-style error — the assertion above
  // failing on OUR message, not undici's, is what proves no call was made.
});

test("uploadProfilePhoto calls Vercel Blob and returns its public URL", async () => {
  mockBlobPut({
    statusCode: 200,
    body: {
      url: "https://example.public.blob.vercel-storage.com/profile-photos/abc.jpg",
      downloadUrl:
        "https://example.public.blob.vercel-storage.com/profile-photos/abc.jpg?download=1",
      pathname: "profile-photos/abc.jpg",
      contentType: "image/jpeg",
      contentDisposition: 'attachment; filename="abc.jpg"',
      etag: "\"etag123\"",
    },
  });

  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_teststore_testsecret";
  const result = await uploadProfilePhoto(photoFile());

  assert.equal(result.url, "https://example.public.blob.vercel-storage.com/profile-photos/abc.jpg");
  assert.equal(result.pathname, "profile-photos/abc.jpg");
});

test("uploadProfilePhoto rejects, rather than swallowing the failure, when Vercel Blob refuses the upload", async () => {
  mockBlobPut({
    statusCode: 403,
    body: { error: { code: "forbidden", message: "Invalid token" } },
  });

  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_teststore_testsecret";
  await assert.rejects(() => uploadProfilePhoto(photoFile()));
});

// ---------------------------------------------------------------------------
// setAccountPhotoUrl
// ---------------------------------------------------------------------------

test("setAccountPhotoUrl sets exactly the photo_url column", async () => {
  const playerId = "1".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "a".repeat(64), displayName: "Zsolt" });

  assert.equal(await setAccountPhotoUrl(playerId, "stub://profile-photo/x"), true);
  const account = await getPlayerAccount(playerId);
  assert.equal(account?.photo_url, "stub://profile-photo/x");
  assert.equal(account?.display_name, "Zsolt", "unrelated columns must be untouched");
});

// ---------------------------------------------------------------------------
// POST /api/account/photo
// ---------------------------------------------------------------------------

async function registeredSession(playerId: string): Promise<string> {
  await registerPlayerAccount({ playerId, recoveryKey: `${playerId}-key`.padEnd(64, "0"), displayName: "Zsolt" });
  return createAccountSession(playerId);
}

function uploadRequest(token: string | null, form: FormData): Request {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `bk_account_session=${token}`;
  return new Request("https://barkoba.test/api/account/photo", { method: "POST", headers, body: form });
}

test("photo upload refuses a caller without an active session", async () => {
  const form = new FormData();
  form.append("photo", photoFile());
  const response = await uploadPhoto(
    new Request("https://barkoba.test/api/account/photo", {
      method: "POST",
      headers: { [PLAYER_HEADER]: "2".repeat(32) },
      body: form,
    })
  );
  assert.equal(response.status, 401);
});

test("photo upload refuses a missing file", async () => {
  const playerId = "3".repeat(32);
  const token = await registeredSession(playerId);
  const response = await uploadPhoto(uploadRequest(token, new FormData()));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "missing_file");
});

test("photo upload refuses an unsupported type", async () => {
  const playerId = "4".repeat(32);
  const token = await registeredSession(playerId);
  const form = new FormData();
  form.append("photo", photoFile({ type: "image/gif", name: "x.gif" }));
  const response = await uploadPhoto(uploadRequest(token, form));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "unsupported_type");
});

test("photo upload refuses a file over 5 MB", async () => {
  const playerId = "5".repeat(32);
  const token = await registeredSession(playerId);
  const form = new FormData();
  form.append("photo", photoFile({ bytes: 5 * 1024 * 1024 + 1 }));
  const response = await uploadPhoto(uploadRequest(token, form));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "file_too_large");
});

test("photo upload succeeds for a valid file and persists the URL to exactly this account", async () => {
  mockBlobPut({
    statusCode: 200,
    body: {
      url: "https://example.public.blob.vercel-storage.com/profile-photos/route-test.jpg",
      downloadUrl:
        "https://example.public.blob.vercel-storage.com/profile-photos/route-test.jpg?download=1",
      pathname: "profile-photos/route-test.jpg",
      contentType: "image/jpeg",
      contentDisposition: 'attachment; filename="route-test.jpg"',
      etag: "\"etag456\"",
    },
  });
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_teststore_testsecret";

  const playerId = "6".repeat(32);
  const other = "7".repeat(32);
  const token = await registeredSession(playerId);
  await registerPlayerAccount({ playerId: other, recoveryKey: "o".repeat(64), displayName: "Other" });

  const form = new FormData();
  form.append("photo", photoFile());
  const response = await uploadPhoto(uploadRequest(token, form));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    body.photo_url,
    "https://example.public.blob.vercel-storage.com/profile-photos/route-test.jpg"
  );

  assert.equal((await getPlayerAccount(playerId))?.photo_url, body.photo_url);
  assert.equal((await getPlayerAccount(other))?.photo_url, null, "another account's photo must be untouched");
});
