import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import { createAccountSession } from "../lib/accountSession";
import { resolveActingPlayer } from "../lib/actingPlayer";
import { registerPlayerAccount } from "../lib/playerAccounts";
import {
  PLAYER_COOKIE,
  PLAYER_NAME_COOKIE,
  issuePlayerCookie,
  issuePlayerNameCookie,
} from "../lib/playerIdentity";
import { shouldAskForName, type CookieReader } from "../lib/nameScreen";

process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";

// ---------------------------------------------------------------------------
// V2.9.1 CORRECTION — production evidence showed a signed-in registered
// player (authenticated Profile control and avatar visible) still receiving
// the blocking "Hogy szólítsunk?" screen. The previous fix only skipped it
// when the account lookup ALSO returned a nonblank display_name; it never
// checked whether the requester actually held a live account session at all.
//
// These tests exercise lib/nameScreen.ts's shouldAskForName() directly,
// against the same account-session fake-SQL harness established in
// test/accountOwnership.test.ts, rather than rendering app/compose/page.tsx
// or app/play/ai/page.tsx — there is no rendering harness for a Next.js
// Server Component in this suite, and the two page files now do nothing but
// call this shared function with real cookies()/headers().
// ---------------------------------------------------------------------------

interface AccountRow {
  player_id: string;
  recovery_key: string;
  display_name: string | null;
  created_at: string;
  registered_at: string;
  disabled_at: null;
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
    };
    accounts.set(playerId, row);
    return Promise.resolve([row]);
  }

  if (/FROM accounts\.players/.test(query) && !/INSERT INTO accounts\.player_sessions/.test(query)) {
    const row = accounts.get(String(v[0]));
    return Promise.resolve(row ? [row] : []);
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

  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

const SAVED = { database: process.env.DATABASE_URL, corpus: process.env.CORPUS_ENABLED };

beforeEach(() => {
  accounts = new Map();
  sessions = new Map();
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  if (SAVED.database === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED.database;
  if (SAVED.corpus === undefined) delete process.env.CORPUS_ENABLED;
  else process.env.CORPUS_ENABLED = SAVED.corpus;
});

/** An empty jar — proves the account-session bypass never even reads cookies. */
const EMPTY_JAR: CookieReader = { get: () => undefined };

function jarWith(values: Record<string, string>): CookieReader {
  return {
    get: (name) => {
      const value = values[name];
      return value === undefined ? undefined : { value };
    },
  };
}

async function accountHeadersFor(playerId: string): Promise<Headers> {
  const token = await createAccountSession(playerId);
  return new Headers({ cookie: `bk_account_session=${token}` });
}

test("account with a valid display name skips the naming screen", async () => {
  const playerId = "a".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "1".repeat(64), displayName: "Zsolt" });
  const headers = await accountHeadersFor(playerId);

  assert.equal(await shouldAskForName(headers, EMPTY_JAR), false);
});

test("account with a null display name skips the naming screen", async () => {
  const playerId = "b".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "2".repeat(64), displayName: null });
  const headers = await accountHeadersFor(playerId);

  assert.equal(await shouldAskForName(headers, EMPTY_JAR), false);
});

test("account with a blank/whitespace display name skips the naming screen", async () => {
  const playerId = "c".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "3".repeat(64), displayName: "   " });
  const headers = await accountHeadersFor(playerId);

  assert.equal(await shouldAskForName(headers, EMPTY_JAR), false);
});

test("a registered (authenticated) account proceeds without ever being asked for a name", async () => {
  // Regression for the exact production defect: an authenticated account
  // with no usable name, on a device that has never set bk_player_name,
  // must still never see the screen -- proven here by never even inspecting
  // that cookie (EMPTY_JAR contains none, and the assertion still holds).
  const playerId = "d".repeat(32);
  await registerPlayerAccount({ playerId, recoveryKey: "4".repeat(64), displayName: null });
  const headers = await accountHeadersFor(playerId);

  assert.equal(await shouldAskForName(headers, EMPTY_JAR), false);
  const context = await resolveActingPlayer(headers);
  assert.deepEqual(context, { kind: "account", playerId });
});

test("an anonymous guest still receives the optional naming screen", async () => {
  const guestCookie = await issuePlayerCookie();
  const headers = new Headers(); // no account session at all
  const jar = jarWith({ [PLAYER_COOKIE]: guestCookie.value });

  assert.equal(await shouldAskForName(headers, jar), true);
});

test("an anonymous guest who already answered (skip or a chosen name) is not asked again", async () => {
  const guestCookie = await issuePlayerCookie();
  const nameCookie = await issuePlayerNameCookie(guestCookie.playerId, "");
  const headers = new Headers();
  const jar = jarWith({ [PLAYER_COOKIE]: guestCookie.value, [PLAYER_NAME_COOKIE]: nameCookie });

  assert.equal(await shouldAskForName(headers, jar), false);
});

test("a spoofed bk_player_name cookie does not create account authentication and does not bypass the screen", async () => {
  // "Spoofed" here means client-asserted and unsigned/mis-signed -- exactly
  // the shape a tampering client could send. It must be read the same as no
  // name at all (see readPlayerName's own signature check), AND it must be
  // powerless to fake account authority: resolveActingPlayer never reads
  // this cookie name at all, only bk_account_session.
  const guestCookie = await issuePlayerCookie();
  const headers = new Headers({ cookie: "bk_player_name=not-a-real-signed-value" });
  const jar = jarWith({
    [PLAYER_COOKIE]: guestCookie.value,
    [PLAYER_NAME_COOKIE]: "not-a-real-signed-value",
  });

  const context = await resolveActingPlayer(headers);
  assert.notEqual(context.kind, "account", "a spoofed name cookie must never authenticate");
  assert.equal(
    await shouldAskForName(headers, jar),
    true,
    "an unsigned/forged name cookie must not be trusted as an answer"
  );
});

test("SOURCE: both entry points now call the single shared shouldAskForName helper", () => {
  for (const file of ["app/compose/page.tsx", "app/play/ai/page.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /import \{ shouldAskForName \} from "@\/lib\/nameScreen";/, `${file} must reuse the shared helper`);
    assert.match(src, /shouldAskForName\(headers\(\), cookies\(\)\)/, `${file} must pass live headers()/cookies()`);
    assert.doesNotMatch(src, /async function shouldAskForName/, `${file} must not keep its own duplicate implementation`);
  }
});
