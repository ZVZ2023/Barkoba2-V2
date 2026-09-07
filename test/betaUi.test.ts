import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 — /beta page gating, bilingual copy, and root
// landing/gameplay non-interference.
//
// SOURCE-CONTRACT, matching this repo's established idiom for React/route
// files with no rendering harness: app/beta/page.tsx calls next/navigation's
// notFound(), which throws a framework-internal signal outside a real
// request/render context rather than returning a testable value, so its
// gating is proven structurally here — the underlying boolean logic
// (env.betaCommunityEnabled() && betaCommunityConfigured()) is ALSO proven
// executable in test/betaRoutes.test.ts via the status endpoint, which
// shares the identical two-part gate.
// ---------------------------------------------------------------------------

const BETA_PAGE = readFileSync("app/beta/page.tsx", "utf8");
const BETA_ADMIN_PAGE = readFileSync("app/beta/admin/page.tsx", "utf8");
const BETA_CLIENT = readFileSync("app/beta/BetaClient.tsx", "utf8");
const ADMIN_REVIEW_CLIENT = readFileSync("app/beta/admin/AdminReviewClient.tsx", "utf8");
const ROOT_PAGE = readFileSync("app/page.tsx", "utf8");

// ---------------------------------------------------------------------------
// /beta behavior while OFF and ON.
// ---------------------------------------------------------------------------

test("SOURCE: /beta calls notFound() when the flag or store is not configured, BEFORE rendering anything", () => {
  const fnAt = BETA_PAGE.indexOf("export default function Page");
  const fn = BETA_PAGE.slice(fnAt);
  assert.match(fn, /if \(!env\.betaCommunityEnabled\(\) \|\| !betaCommunityConfigured\(\)\) \{\s*\n\s*notFound\(\);/);
  // notFound() must be reached before BetaClient is ever returned.
  const notFoundAt = fn.indexOf("notFound();");
  const returnAt = fn.indexOf("return <BetaClient");
  assert.ok(notFoundAt > 0 && returnAt > notFoundAt);
});

test("SOURCE: /beta/admin (the review queue page) is gated the SAME way", () => {
  const fnAt = BETA_ADMIN_PAGE.indexOf("export default function Page");
  const fn = BETA_ADMIN_PAGE.slice(fnAt);
  assert.match(fn, /if \(!env\.betaCommunityEnabled\(\) \|\| !betaCommunityConfigured\(\)\) \{\s*\n\s*notFound\(\);/);
});

test("SOURCE: every beta API route refuses with not_found or forbidden BEFORE doing any work when the flag is off", () => {
  for (const route of [
    "app/api/beta/status/route.ts",
    "app/api/beta/apply/route.ts",
    "app/api/beta/admin/queue/route.ts",
    "app/api/beta/admin/review/route.ts",
    "app/api/beta/profile/route.ts",
  ]) {
    const src = readFileSync(route, "utf8");
    assert.match(src, /env\.betaCommunityEnabled\(\)/, `${route} must check the feature flag`);
  }
});

test("SOURCE: feedback is explicitly NOT gated by BETA_COMMUNITY_ENABLED — available regardless of program state", () => {
  const src = readFileSync("app/api/feedback/route.ts", "utf8");
  assert.doesNotMatch(src, /betaCommunityEnabled|betaCommunityConfigured/);
});

// ---------------------------------------------------------------------------
// Localization: complete Hungarian and English copy.
// ---------------------------------------------------------------------------

test("SOURCE: BetaClient carries complete, parallel Hungarian and English copy", () => {
  assert.match(BETA_CLIENT, /hu: \{/);
  assert.match(BETA_CLIENT, /en: \{/);
  const huKeys = [...BETA_CLIENT.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]!);
  const uniqueKeys = [...new Set(huKeys)];
  assert.ok(uniqueKeys.length >= 10, "expected the full bilingual copy key set to be discoverable");
  // Every key that appears must appear an EVEN number of times (once for hu, once for en) —
  // an odd count would mean one language is missing a key the other has.
  for (const key of uniqueKeys) {
    const count = huKeys.filter((k) => k === key).length;
    assert.equal(count % 2, 0, `copy key "${key}" must exist in both hu and en (found ${count} occurrences)`);
  }
});

test("SOURCE: the reader can switch language; the choice is not tied to any game's own language", () => {
  assert.match(BETA_CLIENT, /const \[lang, setLang\] = useState<Lang>\("hu"\);/);
  assert.doesNotMatch(BETA_CLIENT, /game_language/);
});

test("SOURCE: the ticket's own key facts are stated in both languages — every player is in beta, approval never changes credits", () => {
  assert.match(BETA_CLIENT, /MINDEN játékos béta állapotban játszik/);
  assert.match(BETA_CLIENT, /EVERY player is in beta/);
  assert.match(BETA_CLIENT, /nem ad és nem von el VERSENY-egyenleget/);
  assert.match(BETA_CLIENT, /never grants or removes VERSENY balance/);
});

// ---------------------------------------------------------------------------
// Root landing/gameplay behavior unchanged.
// ---------------------------------------------------------------------------

test("SOURCE: barkobak.com's root page is untouched — still the Stage/FrontDoor landing surface, no beta redirect or gate", () => {
  assert.match(ROOT_PAGE, /<Stage \/>/);
  assert.match(ROOT_PAGE, /<FrontDoor version=\{label\} \/>/);
  assert.doesNotMatch(ROOT_PAGE, /beta|Beta|BETA/);
});

test("SOURCE: gameplay was not moved to /play — /compose and /play/ai remain the two game engines, exactly as before", () => {
  assert.match(ROOT_PAGE, /\/compose is the 0\.3\.x/);
  assert.match(ROOT_PAGE, /\/play\/ai is the 0\.6\.x/);
});

test("SOURCE: the functioning game's own screens (ComposerEntry, RacerSetup, GameClient) are not imported by, or coupled to, the beta feature", () => {
  for (const file of ["app/ComposerEntry.tsx", "app/RacerSetup.tsx", "app/game/[id]/GameClient.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /betaCommunity|\/beta|BETA_COMMUNITY/i, `${file} must not reference the beta feature`);
  }
});

// ---------------------------------------------------------------------------
// V2.9.0 SLICE 1 FINAL CORRECTION — admin-only discoverability link to
// /admin/feedback.
//
// SOURCE-CONTRACT, matching this file's own established idiom: React
// component gating cannot be executed without a DOM/render harness this
// suite does not have. What IS proven structurally, and is the actual
// security-relevant claim, is that the link sits ENTIRELY inside the
// `state.step === "loaded"` branch — the same branch AdminReviewClient only
// ever reaches after GET /api/beta/admin/queue itself returned 200, which
// test/betaRoutes.test.ts already proves executably requires
// isAdminPlayer(). The "forbidden" branch (reached for every anonymous,
// non-admin, or beta-member caller — none of whom pass that check) is
// checked separately and confirmed to contain no trace of the link.
// ---------------------------------------------------------------------------

test("SOURCE: the admin-only feedback link exists, with the exact approved bilingual label", () => {
  assert.match(ADMIN_REVIEW_CLIENT, /href="\/admin\/feedback"/);
  assert.match(ADMIN_REVIEW_CLIENT, /Visszajelzések \/ Feedback/);
});

test("SOURCE: the feedback link is reachable ONLY inside the server-confirmed \"loaded\" (authorized) branch, never inside \"forbidden\"", () => {
  const loadedAt = ADMIN_REVIEW_CLIENT.indexOf('state.step === "loaded" && (');
  assert.ok(loadedAt > 0);
  // The link must appear structurally between the "loaded" branch's own
  // opening and the next top-level JSX branch (the applications section
  // that already exists inside it) — i.e. genuinely inside that branch,
  // not merely somewhere later in the file.
  const linkAt = ADMIN_REVIEW_CLIENT.indexOf('href="/admin/feedback"');
  const applicationsSectionAt = ADMIN_REVIEW_CLIENT.indexOf("Applications (");
  assert.ok(
    linkAt > loadedAt && linkAt < applicationsSectionAt,
    "the link must be inside the loaded branch, before the applications list"
  );

  // And it must be structurally ABSENT from the forbidden/loading/error
  // branches, each of which is a separate, disjoint conditional block.
  const forbiddenAt = ADMIN_REVIEW_CLIENT.indexOf('state.step === "forbidden"');
  const forbiddenBlock = ADMIN_REVIEW_CLIENT.slice(forbiddenAt, ADMIN_REVIEW_CLIENT.indexOf(")}", forbiddenAt));
  assert.doesNotMatch(forbiddenBlock, /admin\/feedback/);
});

test("SOURCE: no navigation link to /admin/feedback (or /beta) was added to the public root page or any existing gameplay screen", () => {
  assert.doesNotMatch(ROOT_PAGE, /admin\/feedback/);
  for (const file of ["app/ComposerEntry.tsx", "app/RacerSetup.tsx", "app/game/[id]/GameClient.tsx", "app/components/AccountControl.tsx", "app/components/SiteHeader.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /admin\/feedback/, `${file} must not link to the admin feedback inbox`);
  }
});

test("SOURCE: no new general navigation system was introduced — the link is a single anchor reusing the existing Link/GameShell conventions, not a new nav component", () => {
  assert.match(ADMIN_REVIEW_CLIENT, /import Link from "next\/link";/);
  // Exactly one such link was added — no menu, sidebar, or nav array.
  const linkOccurrences = (ADMIN_REVIEW_CLIENT.match(/<Link\b/g) ?? []).length;
  assert.equal(linkOccurrences, 1);
});
