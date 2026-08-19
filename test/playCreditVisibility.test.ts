import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePlayState } from "../lib/entitlements";

const ENTITLEMENTS = readFileSync("lib/entitlements.ts", "utf8");
const ROUTE = readFileSync("app/api/player/entitlement/route.ts", "utf8");
const UI = readFileSync("app/components/Entitlement.tsx", "utf8");
const HEADER = readFileSync("app/components/SiteHeader.tsx", "utf8");
const WRAPPER = readFileSync("app/components/PlayerAwareSiteHeader.tsx", "utf8");

test("§39 resolves all four Play Credit states in the ratified order", () => {
  assert.equal(
    resolvePlayState({
      unlimited: true,
      balance: 0,
      complimentaryGrant: 10,
      initialComplimentaryGranted: false,
    }),
    "unlimited"
  );
  assert.equal(
    resolvePlayState({
      unlimited: false,
      balance: 2,
      complimentaryGrant: 10,
      initialComplimentaryGranted: false,
    }),
    "has_balance"
  );
  assert.equal(
    resolvePlayState({
      unlimited: false,
      balance: 0,
      complimentaryGrant: 10,
      initialComplimentaryGranted: false,
    }),
    "introductory_available"
  );
  assert.equal(
    resolvePlayState({
      unlimited: false,
      balance: 0,
      complimentaryGrant: 0,
      initialComplimentaryGranted: false,
    }),
    "exhausted"
  );
  assert.equal(
    resolvePlayState({
      unlimited: false,
      balance: 0,
      complimentaryGrant: 10,
      initialComplimentaryGranted: true,
    }),
    "exhausted",
    "a consumed introductory grant must never look available again"
  );
});

test("§39 reads the durable initial_complimentary marker in the existing aggregate", () => {
  assert.match(ENTITLEMENTS, /BOOL_OR\(grant_key = 'initial_complimentary'\)/);
  assert.match(ENTITLEMENTS, /FILTER \(WHERE kind = 'complimentary_grant'\)/);
  assert.match(ENTITLEMENTS, /AS initial_complimentary_granted/);
  assert.match(ROUTE, /play_state: resolvePlayState\(/);
  assert.match(ROUTE, /initialComplimentaryGranted: status\.initial_complimentary_granted/);
});

test("§39 keeps play_state server-resolved", () => {
  assert.match(ROUTE, /resolvePlayState/);
  assert.doesNotMatch(UI, /balance\s*[><=]+\s*0/);
  assert.doesNotMatch(UI, /initial_complimentary|complimentary_granted/);
});

test("§39 guards the global entitlement query behind a verified existing identity", () => {
  assert.match(WRAPPER, /resolveActingPlayer\(headers\(\)\)/);
  assert.match(
    WRAPPER,
    /hasEstablishedPlayerIdentity=\{context\.kind === "account" \|\| context\.kind === "guest"\}/
  );

  const guard = UI.indexOf("if (!enabled)");
  const request = UI.indexOf('fetch("/api/player/entitlement"');
  assert.ok(guard > 0 && request > guard, "identity guard must precede the entitlement fetch");
  assert.match(
    HEADER,
    /useEntitlement\([\s\S]*hasEstablishedPlayerIdentity,[\s\S]*accountAuthenticated \? "account" : "guest"[\s\S]*\)/
  );
  assert.match(UI, /\[enabled, identityScope, nonce\]/);
  assert.match(UI, /setView\(null\)/);
});

test("§39 places the player-aware status in every existing global header shell", () => {
  for (const file of [
    "app/components/FrontDoor.tsx",
    "app/components/ContentPage.tsx",
    "app/play/page.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /PlayerAwareSiteHeader/, file);
    assert.doesNotMatch(source, /<SiteHeader\s*\/>/, file);
  }
  assert.match(HEADER, /<BalanceBadge view=\{entitlement\.view\} \/>/);
});

test("§39 exposes acquisition only for server-resolved exhausted state", () => {
  assert.match(
    HEADER,
    /entitlement\.view\?\.play_state === "exhausted"[\s\S]*?<CreditGateway/
  );

  for (const file of [
    "app/ComposerEntry.tsx",
    "app/RacerSetup.tsx",
    "app/play/human/HumanSetup.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /noCredit && entitlement\.view\?\.play_state === "exhausted"/, file);
  }
});

test("§39 introductory copy stays welcoming while the account control becomes real", () => {
  const introductory = UI.slice(
    UI.indexOf('view.play_state === "introductory_available"'),
    UI.indexOf('view.play_state === "has_balance"')
  );
  assert.match(introductory, /Az első VERSENYED vár rád/);
  assert.doesNotMatch(introductory, /\b0\b|elfogyott|CreditGateway|vásárl/i);

  assert.match(HEADER, /<AccountControl authenticated=\{accountAuthenticated\} \/>/);
  assert.doesNotMatch(HEADER, /comingSoon\(copy\.header\.login\)/);
  const account = readFileSync("app/components/AccountControl.tsx", "utf8");
  assert.match(account, /\/api\/account\/logout/);
  assert.match(account, /<ClaimPrompt \/>/);
  assert.match(account, /<RecoverPrompt initiallyOpen \/>/);
});

test("Hungarian player-facing entitlement copy uses VERSENY, never RACE", () => {
  for (const file of [
    "app/RacerSetup.tsx",
    "app/components/BudgetPicker.tsx",
    "app/components/ClaimPrompt.tsx",
    "app/components/Entitlement.tsx",
    "app/components/PurchaseReturn.tsx",
    "app/api/entitlement/intent/route.ts",
    "app/api/game/create/route.ts",
    "app/api/player/entitlement/route.ts",
    "app/privacy/page.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\bRACES?\b|RACE-ed/, file);
  }
});

test("§39 does not paint introductory or unlimited players as unable to afford play", () => {
  const picker = readFileSync("app/components/BudgetPicker.tsx", "utf8");
  assert.match(picker, /playState !== "unlimited"/);
  assert.match(picker, /playState !== "introductory_available"/);

  for (const file of ["app/ComposerEntry.tsx", "app/play/human/HumanSetup.tsx"]) {
    assert.match(
      readFileSync(file, "utf8"),
      /playState=\{entitlement\.view\?\.play_state \?\? null\}/,
      file
    );
  }
});
