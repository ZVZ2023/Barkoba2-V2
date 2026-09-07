import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.9.1 HU MVP ONBOARDING — six bounded corrections found during a review
// of the Hungarian-market MVP's onboarding surfaces:
//   1. Contact exposes the existing /feedback form.
//   2. The header's "Regisztráció / Belépés" control clearly labels login.
//   3. Privacy corrects stale email/research-status/future-features claims.
//   4. Rules removes obsolete V1/H2H-unavailable claims, adds experience
//      modes, question refinement, and the no-spelling fairness rule.
//   5. The homepage explains both roles, beta status, the free trial game,
//      the 5-credit bonus, and paid engine tiers, with the welcome video
//      discoverable before registration.
//   6. The header's language selector and the footer's social icons — both
//      non-functional "Coming Soon" placeholders — are removed for this
//      Hungarian-only launch.
//
// SOURCE-CONTRACT tests, matching this repo's established idiom for React
// components with no rendering harness.
// ---------------------------------------------------------------------------

const CONTACT = readFileSync("app/contact/page.tsx", "utf8");
const ACCOUNT_CONTROL = readFileSync("app/components/AccountControl.tsx", "utf8");
const PRIVACY = readFileSync("app/privacy/page.tsx", "utf8");
const RULES = readFileSync("app/rules/page.tsx", "utf8");
const FRONT_DOOR = readFileSync("app/components/FrontDoor.tsx", "utf8");
const SITE_HEADER = readFileSync("app/components/SiteHeader.tsx", "utf8");
const SITE_FOOTER = readFileSync("app/components/SiteFooter.tsx", "utf8");
const COPY = readFileSync("lib/ui/copy.ts", "utf8");
const REGISTER_ROUTE = readFileSync("app/api/account/register/route.ts", "utf8");
const CLAIM_PROMPT = readFileSync("app/components/ClaimPrompt.tsx", "utf8");

/**
 * Several files in this pass carry a dev comment that explains what was
 * REMOVED or CORRECTED by quoting the old, now-absent text verbatim (e.g.
 * "the language selector used to sit here... ('🌐 HU ▾')"). A plain
 * substring/regex scan for that old text would false-positive on the
 * comment itself. Strip block and line comments before asserting an
 * absence, matching this repo's established fix for the same shape
 * elsewhere (e.g. test/betaCommunity.test.ts, test/welcomeVideoSlot.test.ts).
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const PRIVACY_CODE = stripComments(PRIVACY);
const RULES_CODE = stripComments(RULES);
const SITE_HEADER_CODE = stripComments(SITE_HEADER);
const SITE_FOOTER_CODE = stripComments(SITE_FOOTER);

// ---------------------------------------------------------------------------
// 1. Contact exposes the existing feedback form.
// ---------------------------------------------------------------------------

test("Contact links to the real, ungated /feedback surface", () => {
  assert.match(CONTACT, /href="\/feedback"/);
  assert.match(CONTACT, /Visszajelzés küldése/);
});

test("Contact still invents no email/phone/social channel, and claims no monitoring", () => {
  assert.doesNotMatch(CONTACT, /@[a-z0-9.-]+\.[a-z]{2,}/i, "no email address must appear");
  assert.doesNotMatch(CONTACT, /figyeljük|monitorozzuk|napi szinten|azonnal válaszolunk/i);
  assert.match(CONTACT, /nincs olyan nyilvános e-mail-cím/, "the honest no-channel disclosure must remain");
});

// ---------------------------------------------------------------------------
// 2. Registration vs. existing-account login are clearly labelled.
// ---------------------------------------------------------------------------

test("AccountControl clearly labels the login path, without touching ClaimPrompt/RecoverPrompt's own tags", () => {
  assert.match(ACCOUNT_CONTROL, /Már van fiókod\? Belépés/);
  // The tags this repo's other tests pin verbatim must survive unchanged.
  assert.match(ACCOUNT_CONTROL, /<ClaimPrompt \/>/);
  assert.match(ACCOUNT_CONTROL, /<RecoverPrompt initiallyOpen \/>/);
  // Order matters: the login label must precede the login component.
  const labelAt = ACCOUNT_CONTROL.indexOf("Már van fiókod? Belépés");
  const recoverAt = ACCOUNT_CONTROL.indexOf("<RecoverPrompt initiallyOpen />");
  assert.ok(labelAt > 0 && recoverAt > labelAt);
});

test("registration already self-labels via ClaimPrompt's own copy — confirms no duplicate/contradictory label was needed there", () => {
  assert.match(CLAIM_PROMPT, /Regisztrálsz játékosfiókot\?/);
});

// ---------------------------------------------------------------------------
// 3. Privacy: email is required, research-phase framing corrected, stale
//    "future features" note removed. The three-provider AI disclosure
//    (V2.9.1.1) is untouched.
// ---------------------------------------------------------------------------

test("Privacy no longer claims registration needs no email — it states the email requirement plainly", () => {
  assert.doesNotMatch(PRIVACY, /sem e-mail-címet, sem jelszót/);
  assert.match(PRIVACY, /egy név és egy megerősített\s*\n?\s*e-mail-cím szükséges/);
});

test("Privacy's stored-fields list for a registered account now includes the email address", () => {
  const sectionAt = PRIVACY.indexOf('heading="Ha regisztrálod a játékosodat"');
  const section = PRIVACY.slice(sectionAt, PRIVACY.indexOf("</Section>", sectionAt));
  assert.match(section, /négy\s*\n?\s*dolgot/, "the list grew from three items to four");
  assert.match(section, /e-mail-címedet és annak megerősítési állapotát/);
  assert.doesNotMatch(section, /nincs e-mail cím/, "the old 'no email' claim must be gone");
});

test("Privacy no longer frames the game as a closed pre-public phase", () => {
  assert.doesNotMatch(PRIVACY_CODE, /nyilvánosság előtti, zárt teszt/);
  assert.match(PRIVACY, /nyilvánosan játszható, regisztráció nélkül/);
});

test("Privacy's closing note no longer treats accounts/retained games/multiplayer as hypothetical future work", () => {
  assert.doesNotMatch(PRIVACY, /Ha később fiókok, mentett játékok/);
});

test("Privacy's account-deletion claim and the three-provider AI disclosure remain untouched by this pass", () => {
  assert.match(PRIVACY, /Regisztrált fiók törlését[^<]*nem kínálja fel/);
  assert.match(PRIVACY, /Amit az AI-szolgáltatóknak elküldünk/);
  assert.match(PRIVACY, /Az Anthropic minden játékban ellenőrzi/);
});

test("the email-requirement claim matches the actual server-side validation", () => {
  assert.match(REGISTER_ROUTE, /looksLikeEmail\(email\)/);
  assert.match(REGISTER_ROUTE, /invalid_email/);
});

// ---------------------------------------------------------------------------
// 4. Rules: version-neutral framing, H2H is a real third mode, experience
//    modes / question refinement / no-spelling rule are now described.
// ---------------------------------------------------------------------------

test("Rules no longer hardcodes a stale version label", () => {
  assert.doesNotMatch(RULES_CODE, /jelenlegi V1 változat/);
  assert.match(RULES, /jelenleg telepített változat/);
});

test("Rules no longer denies Human-vs-Human — it's a live third mode", () => {
  assert.doesNotMatch(RULES_CODE, /Ember a ember elleni játék jelenleg nem érhető el/);
  assert.match(RULES, /Három játékmód/);
  assert.match(RULES, /Ember a ember ellen/);
});

test("Rules now describes the four experience modes by name", () => {
  const sectionAt = RULES.indexOf('heading="Élmény"');
  assert.ok(sectionAt > 0);
  const section = RULES.slice(sectionAt, RULES.indexOf("</Section>", sectionAt));
  for (const mode of ["Verseny", "Baráti", "Tanító", "Humoros"]) {
    assert.match(section, new RegExp(mode), `${mode} must be named`);
  }
  assert.match(section, /csak a\s*\n?\s*megfogalmazást változtatja/, "must state this is presentation-only, not a strategy/content change");
});

test("Rules now discloses automatic question refinement", () => {
  assert.match(RULES, /Kérdésfinomítás/);
  assert.match(RULES, /finomíthatja a megfogalmazást/);
});

test("Rules now states the no-spelling fairness rule", () => {
  const sectionAt = RULES.indexOf('heading="Tisztességes játék"');
  const section = RULES.slice(sectionAt, RULES.indexOf("</Section>", sectionAt));
  assert.match(section, /betűzésre, helyesírásra vagy kiejtésre/);
});

test("Rules' existing budget/adjudication/difficulty sections are untouched", () => {
  assert.match(RULES, /20, 35, 50 vagy 100 kérdés/);
  assert.match(RULES, /Ha a tipp nem talált, vagy a Kérdező feladta/);
  assert.match(RULES, /nincs segítség, minimális, vagy fokozatosan erősödő/);
});

// ---------------------------------------------------------------------------
// 5. Homepage: both roles, beta status, free demo, 5-credit bonus, paid
//    engine tiers, and the video reachable before registration — all reused
//    from existing approved copy, not invented.
// ---------------------------------------------------------------------------

test("FrontDoor explains both roles using the SAME copy already used elsewhere (copy.modes), not new strings", () => {
  assert.match(FRONT_DOOR, /copy\.modes\.humanComposer\.title/);
  assert.match(FRONT_DOOR, /copy\.modes\.humanComposer\.detail/);
  assert.match(FRONT_DOOR, /copy\.modes\.aiComposer\.title/);
  assert.match(FRONT_DOOR, /copy\.modes\.aiComposer\.detail/);
});

test("FrontDoor states beta status, the free trial game, and the 5-credit registration bonus", () => {
  assert.match(FRONT_DOOR, /béta állapotban elérhető/);
  assert.match(FRONT_DOOR, /ingyenes próbajáték/);
  assert.match(FRONT_DOOR, /5 további VERSENYT/);
});

test("FrontDoor's premium-engine price is the SAME string ComposerEntry already shows, not a second invented figure", () => {
  const composerEntry = readFileSync("app/ComposerEntry.tsx", "utf8");
  const priceMatch = composerEntry.match(/price: "([^"]+)"/);
  assert.ok(priceMatch, "could not find PREMIUM_PRICE_COPY.hu.price in ComposerEntry.tsx");
  const [scoops, approxUsd] = priceMatch![1]!.split(" — ");
  assert.match(FRONT_DOOR, new RegExp(scoops!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(FRONT_DOOR, /kb\. 4,20\s*\n?\s*USD/);
  void approxUsd;
});

test("FrontDoor renders the welcome video, reachable with zero registration (the homepage has no account gate)", () => {
  assert.match(FRONT_DOOR, /<WelcomeVideoSlot \/>/);
  assert.doesNotMatch(FRONT_DOOR, /resolveActingPlayer|account_required|notFound\(\)/);
});

test("FrontDoor's pre-existing pinned structure (Stage/FrontDoor wiring, PlayerAwareSiteHeader, hero, feature panel, how-it-works) is untouched", () => {
  assert.match(FRONT_DOOR, /<PlayerAwareSiteHeader \/>/);
  assert.match(FRONT_DOOR, /id="hogyan-mukodik"/);
  assert.match(FRONT_DOOR, /copy\.features\.map/);
  assert.match(FRONT_DOOR, /<SiteFooter version=\{version\} \/>/);
});

test("app/page.tsx itself is still untouched — the new content lives in FrontDoor.tsx, not the root page", () => {
  const rootPage = readFileSync("app/page.tsx", "utf8");
  assert.match(rootPage, /<Stage \/>/);
  assert.match(rootPage, /<FrontDoor version=\{label\} \/>/);
  assert.doesNotMatch(rootPage, /feedback|Feedback/);
});

// ---------------------------------------------------------------------------
// 6. Misleading "Coming Soon" language/social controls removed.
// ---------------------------------------------------------------------------

test("the header's non-functional language selector is gone", () => {
  assert.doesNotMatch(SITE_HEADER_CODE, /🌐/);
  assert.doesNotMatch(SITE_HEADER, /useComingSoon/);
  assert.doesNotMatch(SITE_HEADER, /comingSoon\(/);
});

test("the footer's non-functional social-icon row is gone", () => {
  assert.doesNotMatch(SITE_FOOTER_CODE, /Facebook|Instagram/);
  assert.doesNotMatch(SITE_FOOTER, /useComingSoon/);
  assert.doesNotMatch(SITE_FOOTER, /comingSoon\(/);
});

test("no other UI still references the removed language/social copy keys", () => {
  assert.doesNotMatch(COPY, /language: "HU"/);
  assert.doesNotMatch(COPY, /languageAria/);
  assert.doesNotMatch(COPY, /social: "Közösség"/);
  // Nothing outside copy.ts should reference the removed keys either.
  for (const file of ["app/components/SiteHeader.tsx", "app/components/SiteFooter.tsx", "app/components/FrontDoor.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /copy\.header\.language|copy\.footer\.social/);
  }
});

test("this is a removal, not an English localization build or new social infrastructure", () => {
  assert.doesNotMatch(SITE_HEADER, /\bEN\b|English/);
  for (const file of ["app/components/SiteFooter.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /twitter\.com|facebook\.com|instagram\.com|discord/i);
  }
});

test("the footer's real content links (rules/privacy/about/contact) and version display are unaffected", () => {
  assert.match(SITE_FOOTER, /link\("\/rules", copy\.footer\.rules\)/);
  assert.match(SITE_FOOTER, /link\("\/privacy", copy\.footer\.privacy\)/);
  assert.match(SITE_FOOTER, /link\("\/about", copy\.footer\.about\)/);
  assert.match(SITE_FOOTER, /link\("\/contact", copy\.footer\.contact\)/);
  assert.match(SITE_FOOTER, /\{version &&/);
});
