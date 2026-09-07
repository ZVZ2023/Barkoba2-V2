import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.9.1.3 — a consolidated Hungarian UI-copy update: the first feature
// card, the premium-engine price wording, the footer tagline, and a full
// rewrite of the About page. SOURCE-CONTRACT tests, matching this repo's
// established idiom for React components with no rendering harness.
// ---------------------------------------------------------------------------

const COPY = readFileSync("lib/ui/copy.ts", "utf8");
const COMPOSER_ENTRY = readFileSync("app/ComposerEntry.tsx", "utf8");
const FRONT_DOOR = readFileSync("app/components/FrontDoor.tsx", "utf8");
const SITE_FOOTER = readFileSync("app/components/SiteFooter.tsx", "utf8");
const ABOUT = readFileSync("app/about/page.tsx", "utf8");
const PURCHASE_CLIENT = readFileSync("app/purchase/PurchaseClient.tsx", "utf8");

/**
 * About's own header comment legitimately quotes the old "jelenlegi V1"
 * phrase to explain what was removed -- a plain substring scan over the
 * whole file would false-positive on that explanation. Strip comments
 * before asserting an absence, matching this repo's established fix for
 * the same shape elsewhere (e.g. test/betaCommunity.test.ts).
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const ABOUT_CODE = stripComments(ABOUT);

/** Collapses runs of whitespace so a fragment survives the source's own line wraps. */
function normalizeWhitespace(src: string): string {
  return src.replace(/\s+/g, " ");
}
const ABOUT_FLAT = normalizeWhitespace(ABOUT);

// ---------------------------------------------------------------------------
// 1. First feature card replaced.
// ---------------------------------------------------------------------------

test("the old '20 kérdés / Egy tipp. / Semmi találgatás.' card is gone, replaced by the approved sentence", () => {
  assert.doesNotMatch(COPY, /title: "20 kérdés"/);
  assert.doesNotMatch(COPY, /Semmi találgatás/);
  assert.match(COPY, /Míg mások az AI-ról vitáznak, mi az elménket élesítjük vele\./);
});

test("the replacement card carries no forced sub-lines, so nothing pins it to a specific wrap point", () => {
  const at = COPY.indexOf("Míg mások az AI-ról vitáznak");
  assert.ok(at > 0);
  const line = COPY.slice(at, COPY.indexOf("\n", at));
  assert.match(line, /lines: \[\]/);
});

test("the feature card's rendering container still allows natural wrapping (no nowrap/truncate/fixed width)", () => {
  const sectionAt = FRONT_DOOR.indexOf("FEATURE PANEL");
  const section = FRONT_DOOR.slice(sectionAt, FRONT_DOOR.indexOf("</section>", sectionAt));
  assert.doesNotMatch(section, /whitespace-nowrap|truncate\b/);
  assert.match(section, /min-w-0/, "the flex item must keep its wrap-safety class");
});

// ---------------------------------------------------------------------------
// 2. "2 gombóc" -> "2 digitális fagyigombóc" in equivalent pricing copy,
//    consistently, with amounts/pricing/charging logic untouched.
// ---------------------------------------------------------------------------

test("the premium-engine price description uses 'digitális fagyigombóc' consistently in both places it appears", () => {
  assert.match(COMPOSER_ENTRY, /price: "2 digitális fagyigombóc — jelenleg kb\. 4,20 USD \/ játék"/);
  assert.match(FRONT_DOOR, /2 digitális fagyigombóc,\s*\n?\s*jelenleg kb\. 4,20 USD \/ játék/);
  assert.doesNotMatch(COMPOSER_ENTRY, /"2 gombóc/);
  assert.doesNotMatch(FRONT_DOOR, /— 2 gombóc,/);
});

test("the amount and USD figure are byte-identical to before -- only the unit noun changed", () => {
  assert.match(COMPOSER_ENTRY, /jelenleg kb\. 4,20 USD \/ játék/);
  assert.match(COMPOSER_ENTRY, /"2 digitális fagyigombóc/, "still exactly 2, not re-priced");
});

test("the English price copy, DICS purchase-quantity selector, and charging logic are untouched by this wording change", () => {
  assert.match(COMPOSER_ENTRY, /price: "2 scoops — currently about USD 4\.20 per game"/);
  // PurchaseClient's "1 gombóc / 2 gombóc / 3 gombóc" is a DIFFERENT feature
  // (choosing how many scoops of Digital Ice Cream to BUY, a live DICS
  // quantity selector) from "the player-facing price description" of what
  // the premium engine costs -- explicitly out of scope for this pass.
  assert.match(PURCHASE_CLIENT, /Digital Ice Cream — 1 gombóc/);
  assert.match(PURCHASE_CLIENT, /credits_by_scoops\["1"\]/);
});

// ---------------------------------------------------------------------------
// 3. Footer tagline replaced from the single shared source; no duplicate
//    promotional wording found elsewhere.
// ---------------------------------------------------------------------------

test("the footer tagline is replaced at its single shared source", () => {
  assert.doesNotMatch(COPY, /Egy gondolat\. Húsz kérdés\. Egy tipp\./);
  assert.match(COPY, /tagline: "Jó kérdések\. Élesebb gondolkodás\."/);
  assert.match(SITE_FOOTER, /\{copy\.footer\.tagline\}/, "every page still receives it through the one shared render site");
});

test("no duplicate of the old or new tagline wording exists in any other player-facing copy", () => {
  for (const file of [COMPOSER_ENTRY, FRONT_DOOR, ABOUT, PURCHASE_CLIENT]) {
    assert.doesNotMatch(file, /Egy gondolat\. Húsz kérdés\. Egy tipp\./);
    assert.doesNotMatch(file, /Jó kérdések\. Élesebb gondolkodás\./);
  }
});

// ---------------------------------------------------------------------------
// 4. About page fully replaced with William's approved note.
// ---------------------------------------------------------------------------

test("About keeps the 'Rólunk' heading and ContentPage chrome, and drops the obsolete V1/status body", () => {
  assert.match(ABOUT, /title="Rólunk"/);
  assert.match(ABOUT, /import ContentPage from "\.\.\/components\/ContentPage";/);
  assert.doesNotMatch(ABOUT_CODE, /jelenlegi V1/);
  assert.doesNotMatch(ABOUT, /Miről szól|Ami érdekel minket|Hol tart most/);
});

test("About renders William's approved text, verbatim", () => {
  const expectedFragments = [
    "William vagyok, Tajvanon született magyar, önálló tanuló.",
    "Tizenegy éves korom óta tanulok programozni.",
    "kiléptem a számomra elavult",
    "Édesapámmal közösen készítettük el a Barkóba K első, már",
    "Ez nekünk szerelemprojekt.",
    "Magyar nevelőapám ismertette meg velem és a",
    "Legyetek velem egy kicsit türelmesek: még néhány hónapig nem",
    "mechatronikai",
    "Remélem, nektek is örömet és gondolkodnivalót ad majd a Barkóba K.",
  ];
  for (const fragment of expectedFragments) {
    assert.ok(ABOUT_FLAT.includes(fragment), `missing expected fragment: ${fragment}`);
  }
  // The closing signature line, on its own.
  assert.match(ABOUT, /<p>William<\/p>/);
});

test("'visszajelző űrlapon' links to /feedback, not a plain mention", () => {
  const at = ABOUT.indexOf("visszajelző űrlapon");
  assert.ok(at > 0);
  const before = ABOUT.slice(Math.max(0, at - 120), at);
  assert.match(before, /<Link href="\/feedback"/);
});

test("no company/team/funding/history is invented in the new body", () => {
  for (const forbidden of [/\bLtd\b|\bKft\b|\bZrt\b/i, /finanszíroz|befektet/i]) {
    assert.doesNotMatch(ABOUT, forbidden);
  }
});

test("About's paragraphs keep the site's established body typography, matching Section's own classes", () => {
  const at = ABOUT.indexOf("<div");
  const div = ABOUT.slice(at, ABOUT.indexOf(">", at) + 1);
  assert.match(div, /text-\[15px\]/);
  assert.match(div, /leading-relaxed/);
  assert.match(div, /text-neutral-800/);
});
