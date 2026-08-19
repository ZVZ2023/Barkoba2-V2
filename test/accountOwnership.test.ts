import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setSqlClientForTests, type SqlValue } from "../lib/corpus/db";
import {
  createAccountSession,
  resolveAccountSession,
  revokeAccountSession,
} from "../lib/accountSession";
import { resolveActingPlayer, resolveActingPlayerId } from "../lib/actingPlayer";
import { getBalance } from "../lib/entitlements";
import { issuePlayerCookie, PLAYER_HEADER } from "../lib/playerIdentity";
import { migrateLegacyPlayer, registerPlayerAccount } from "../lib/playerAccounts";
import { claimPlayer, type DurablePlayer } from "../lib/playerStore";
import { POST as createPurchaseIntent } from "../app/api/entitlement/intent/route";

process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";

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

interface LedgerRow {
  player_id: string;
  amount: number;
  grant_key: string;
}

let accounts: Map<string, AccountRow>;
let sessions: Map<string, SessionRow>;
let ledger: LedgerRow[];

function fakeSql(strings: TemplateStringsArray, ...values: SqlValue[]) {
  const query = strings.join(" ");
  const v = values as unknown[];

  if (/INSERT INTO accounts\.players/.test(query)) {
    const playerId = String(v[0]);
    const recovery = String(v[1]);
    if (accounts.has(playerId) || [...accounts.values()].some((a) => a.recovery_key === recovery)) {
      return Promise.resolve([]);
    }
    const row: AccountRow = {
      player_id: playerId,
      recovery_key: recovery,
      display_name: typeof v[2] === "string" ? v[2] : null,
      created_at: String(v[3]),
      registered_at: new Date().toISOString(),
      disabled_at: null,
    };
    accounts.set(playerId, row);
    return Promise.resolve([row]);
  }

  if (/FROM accounts\.players/.test(query) && /recovery_key =/.test(query)) {
    const recovery = String(v[0]);
    const row = [...accounts.values()].find((a) => a.recovery_key === recovery);
    return Promise.resolve(row ? [row] : []);
  }

  if (/FROM accounts\.players/.test(query) && !/INSERT INTO accounts\.player_sessions/.test(query)) {
    const row = accounts.get(String(v[0]));
    return Promise.resolve(row ? [row] : []);
  }

  if (/INSERT INTO accounts\.player_sessions/.test(query)) {
    const hash = String(v[0]);
    const playerId = String(v[2]);
    if (!accounts.has(playerId)) return Promise.resolve([]);
    sessions.set(hash, {
      player_id: playerId,
      expires_at: String(v[1]),
      revoked_at: null,
    });
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

  if (/UPDATE accounts\.player_sessions/.test(query)) {
    const row = sessions.get(String(v[0]));
    if (row && !row.revoked_at) row.revoked_at = new Date().toISOString();
    return Promise.resolve([]);
  }

  if (/SELECT COALESCE\(SUM\(amount\), 0\) AS balance/.test(query)) {
    const playerId = String(v[0]);
    return Promise.resolve([{
      balance: ledger.filter((r) => r.player_id === playerId).reduce((n, r) => n + r.amount, 0),
    }]);
  }

  return Promise.resolve([]);
}
fakeSql.transaction = (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries);

const SAVED = {
  database: process.env.DATABASE_URL,
  corpus: process.env.CORPUS_ENABLED,
  storefront: process.env.DICS_STOREFRONT_URL,
};

beforeEach(() => {
  accounts = new Map();
  sessions = new Map();
  ledger = [];
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  process.env.DICS_STOREFRONT_URL = "https://dics.example/store";
  __setSqlClientForTests(fakeSql);
});

afterEach(() => {
  __setSqlClientForTests(null);
  if (SAVED.database === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED.database;
  if (SAVED.corpus === undefined) delete process.env.CORPUS_ENABLED;
  else process.env.CORPUS_ENABLED = SAVED.corpus;
  if (SAVED.storefront === undefined) delete process.env.DICS_STOREFRONT_URL;
  else process.env.DICS_STOREFRONT_URL = SAVED.storefront;
});

test("registration preserves player_id, ledger rows, balance and ownership markers", async () => {
  const playerId = "a".repeat(32);
  ledger.push(
    { player_id: playerId, amount: 5, grant_key: "purchase:one" },
    { player_id: playerId, amount: 10, grant_key: "initial_complimentary" },
    { player_id: playerId, amount: -1, grant_key: "game:one" }
  );
  const beforeRows = structuredClone(ledger);
  const beforeBalance = await getBalance(playerId);

  const { account, created } = await registerPlayerAccount({
    playerId,
    recoveryKey: "b".repeat(64),
    displayName: "Zsolt",
  });

  assert.equal(created, true);
  assert.equal(account.player_id, playerId);
  assert.deepEqual(ledger, beforeRows, "registration must not copy or alter ledger rows");
  assert.equal(await getBalance(playerId), beforeBalance);
  assert.ok(ledger.some((row) => row.grant_key === "initial_complimentary"));
});

test("two devices resolve one account and logout revokes only the presented session", async () => {
  const playerId = "c".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "d".repeat(64),
    displayName: null,
  });
  ledger.push({ player_id: playerId, amount: 30, grant_key: "purchase:two" });

  const deviceOne = await createAccountSession(playerId);
  const deviceTwo = await createAccountSession(playerId);
  assert.notEqual(deviceOne, deviceTwo, "login must mint a fresh session token");
  assert.equal(await resolveAccountSession(deviceOne), playerId);
  assert.equal(await resolveAccountSession(deviceTwo), playerId);
  assert.equal(await getBalance(playerId), 30);

  await revokeAccountSession(deviceOne);
  assert.equal(await resolveAccountSession(deviceOne), null);
  assert.equal(await resolveAccountSession(deviceTwo), playerId);
  assert.equal(await getBalance(playerId), 30, "logout cannot alter account RACES");
});

test("registered ownership survives lost browser state and old bk_player has no authority", async () => {
  const playerId = "e".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "f".repeat(64),
    displayName: null,
  });
  ledger.push({ player_id: playerId, amount: 15, grant_key: "purchase:three" });

  assert.deepEqual(await resolveActingPlayer(new Headers()), { kind: "none", playerId: null });
  assert.equal(await getBalance(playerId), 15, "lost cookies do not delete account value");

  const oldCookie = await issuePlayerCookie(playerId);
  const oldHeaders = new Headers({ [PLAYER_HEADER]: oldCookie.playerId });
  assert.deepEqual(await resolveActingPlayer(oldHeaders), { kind: "registered", playerId });
  assert.equal(await resolveActingPlayerId(oldHeaders), null, "old cookie is information, not authority");

  const freshSession = await createAccountSession(playerId);
  const accountHeaders = new Headers({ cookie: `bk_account_session=${freshSession}` });
  assert.deepEqual(await resolveActingPlayer(accountHeaders), { kind: "account", playerId });
});

test("legacy protected players migrate idempotently without changing player_id", async () => {
  const record: DurablePlayer = {
    player_id: "1".repeat(32),
    recovery_key: "2".repeat(64),
    display_name: "Régi játékos",
    created_at: "2026-01-01T00:00:00.000Z",
    claimed_at: "2026-01-01T00:00:00.000Z",
  };
  const first = await migrateLegacyPlayer(record);
  const second = await migrateLegacyPlayer(record);
  assert.equal(first.player_id, record.player_id);
  assert.deepEqual(second, first);
  assert.equal(accounts.size, 1);
});

test("encountering a legacy protected cookie migrates it but does not authenticate it", async () => {
  const playerId = "6".repeat(32);
  const legacy = await claimPlayer(playerId, "Korábbi", "LEGACY-ACCOUNT-CODE");
  assert.ok(legacy);
  const headers = new Headers({ [PLAYER_HEADER]: playerId });

  assert.deepEqual(await resolveActingPlayer(headers), { kind: "registered", playerId });
  assert.equal(accounts.get(playerId)?.recovery_key, legacy.recovery_key);
  assert.equal(await resolveActingPlayerId(headers), null);
  assert.deepEqual(await resolveActingPlayer(headers), { kind: "registered", playerId });
  assert.equal(accounts.size, 1);
});

test("guest purchase intent is refused and an authenticated account can mint one", async () => {
  const guestId = "3".repeat(32);
  const guestResponse = await createPurchaseIntent(
    new Request("https://barkoba.test/api/entitlement/intent", {
      method: "POST",
      headers: { [PLAYER_HEADER]: guestId },
    }) as Parameters<typeof createPurchaseIntent>[0]
  );
  assert.equal(guestResponse.status, 409);
  assert.equal((await guestResponse.json()).error, "account_required");

  const playerId = "4".repeat(32);
  await registerPlayerAccount({
    playerId,
    recoveryKey: "5".repeat(64),
    displayName: null,
  });
  const token = await createAccountSession(playerId);
  const accountResponse = await createPurchaseIntent(
    new Request("https://barkoba.test/api/entitlement/intent", {
      method: "POST",
      headers: { cookie: `bk_account_session=${token}` },
    }) as Parameters<typeof createPurchaseIntent>[0]
  );
  assert.equal(accountResponse.status, 200);
  const body = await accountResponse.json();
  assert.match(body.purchase_ref, /^[0-9A-HJKMNP-TV-Z]{16}$/);
  assert.match(body.purchase_url, /^https:\/\/dics\.example\/store\?purchase_ref=/);
});

test("purchase ownership and non-merging are structural at both API and database layers", () => {
  const intent = readFileSync("app/api/entitlement/intent/route.ts", "utf8");
  const login = readFileSync("app/api/account/login/route.ts", "utf8");
  const grant = readFileSync("app/api/entitlement/grant/route.ts", "utf8");
  const ref = readFileSync("lib/purchaseRef.ts", "utf8");
  const migration = readFileSync("migrations/0009_player_accounts.sql", "utf8");
  const claimCompatibility = readFileSync("app/api/player/claim/route.ts", "utf8");

  assert.match(intent, /context\.kind !== "account"/);
  assert.match(intent, /account_required/);
  assert.match(ref, /account_required: true/);
  assert.match(grant, /allowLegacyUnregistered: !ref\.accountRequired/);
  assert.match(migration, /BEFORE INSERT ON accounts\.entitlement_ledger/);
  assert.match(migration, /purchase entitlement requires a registered player account/);
  assert.match(migration, /barkoba\.allow_legacy_purchase/);
  assert.doesNotMatch(login, /entitlement_ledger|UPDATE corpus\.games|composer_player_id|racer_player_id/);
  assert.match(login, /Preserve an unrelated local guest without merging it/);
  assert.match(claimCompatibility, /status: 405/);
});

test("all ownership routes use the central account-aware resolver", () => {
  for (const path of [
    "app/api/player/entitlement/route.ts",
    "app/api/game/join/route.ts",
    "app/api/game/[id]/view/route.ts",
    "app/api/game/[id]/resolve/route.ts",
    "app/api/game/[id]/hh/turn/route.ts",
    "app/api/game/[id]/contest/route.ts",
    "app/api/contest/[id]/route.ts",
    "app/game/[id]/page.tsx",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /resolveActingPlayerId/, path);
    assert.doesNotMatch(source, /playerIdFromHeaders/, path);
  }

  const creation = readFileSync("app/api/game/create/route.ts", "utf8");
  assert.match(creation, /resolveActingPlayer\(req\.headers\)/);
  assert.doesNotMatch(creation, /playerIdFromHeaders|resolveActingPlayerId/);
});

test("guest play fallback cannot authorize a registered account or purchase", () => {
  const creation = readFileSync("app/api/game/create/route.ts", "utf8");
  const intent = readFileSync("app/api/entitlement/intent/route.ts", "utf8");
  const composerEntry = readFileSync("app/ComposerEntry.tsx", "utf8");

  assert.match(
    creation,
    /allowGuestFallback:\s*playerContext\.kind === "guest" \|\| playerContext\.kind === "none"/
  );
  assert.doesNotMatch(creation, /allowGuestFallback:[^\n]*(?:"account"|"registered")/);
  assert.match(intent, /context\.kind !== "account"/);
  assert.match(intent, /account_required/);

  const rateLimit = creation.indexOf("checkGameCreationRateLimit(ip)");
  const validator = creation.indexOf("runValidator(target");
  const aiTarget = creation.indexOf("chooseComposerTarget({");
  assert.ok(rateLimit > 0 && validator > rateLimit && aiTarget > rateLimit);
  assert.doesNotMatch(creation, /recovery_code|recoveryCode|RecoverPrompt/);
  assert.doesNotMatch(
    composerEntry,
    /ClaimPrompt|RecoverPrompt|\/api\/account\/|account_required/,
    "ordinary Human Composer play must have no account or recovery prerequisite"
  );
});
