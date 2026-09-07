import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// V2.9.1 — the completed Hungarian YouTube Short replaces the long-standing
// WelcomeVideoSlot placeholder ("Bemutató videó hamarosan"), reused unchanged
// at its two existing call sites (app/purchase/PurchaseClient.tsx,
// app/components/ClaimPrompt.tsx — see their own V2.7.x comments).
//
// SOURCE-CONTRACT tests, matching this repo's established idiom for a React
// component with no rendering harness.
// ---------------------------------------------------------------------------

const SLOT = readFileSync("app/components/WelcomeVideoSlot.tsx", "utf8");
const APPROVED_VIDEO_ID = "X29Iyc0vUnk";

/**
 * This file's own header comments legitimately explain what is deliberately
 * ABSENT ("no `autoplay` parameter", "rather than the old `aspect-video`
 * box") — a plain substring/regex scan over the whole file would false-
 * positive on those explanatory mentions. Strip block and line comments
 * before asserting an absence, matching this repo's established fix for the
 * same false-positive shape elsewhere (e.g. test/betaCommunity.test.ts).
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const SLOT_CODE = stripComments(SLOT);

test("the exact approved video id is used, embed and fallback alike", () => {
  assert.match(SLOT, new RegExp(`const WELCOME_VIDEO_ID = "${APPROVED_VIDEO_ID}";`));
  // Both URLs are built FROM that one constant (template interpolation), so
  // there is exactly one place the id could ever drift from the approved
  // value — checked directly rather than duplicated into each URL literal.
  assert.match(SLOT, /WELCOME_VIDEO_EMBED_SRC = `https:\/\/www\.youtube-nocookie\.com\/embed\/\$\{WELCOME_VIDEO_ID\}`/);
  assert.match(SLOT, /WELCOME_VIDEO_WATCH_URL = `https:\/\/www\.youtube\.com\/shorts\/\$\{WELCOME_VIDEO_ID\}`/);
});

test("the privacy-enhanced youtube-nocookie.com host is used for the embed, not plain youtube.com/embed", () => {
  assert.match(SLOT, /src=\{WELCOME_VIDEO_EMBED_SRC\}/);
  assert.match(SLOT, /WELCOME_VIDEO_EMBED_SRC = `https:\/\/www\.youtube-nocookie\.com\/embed\/\$\{WELCOME_VIDEO_ID\}`/);
  assert.doesNotMatch(SLOT, /["'`]https:\/\/(www\.)?youtube\.com\/embed/, "must never embed from the ordinary (cookie-setting) host");
});

test("autoplay is never enabled — absent from the embed URL and from the allow feature-policy", () => {
  assert.doesNotMatch(SLOT_CODE, /autoplay/i);
});

test("the player is responsive, capped, and shaped for the vertical Short (9:16), not the old 16:9 box", () => {
  assert.match(SLOT, /aspect-\[9\/16\]/);
  assert.match(SLOT, /max-w-\[220px\]/, "must be capped so a full-width 9:16 embed cannot dominate a wide desktop layout");
  assert.match(SLOT, /className="h-full w-full"/, "the iframe must fill its aspect-ratio container without distorting it");
  assert.doesNotMatch(SLOT_CODE, /aspect-video/, "the old 16:9 placeholder box must be gone");
});

test("lazy loading and fullscreen playback are both enabled", () => {
  assert.match(SLOT, /loading="lazy"/);
  assert.match(SLOT, /allowFullScreen/);
});

test("an accurate, localized (Hungarian) accessible title is set on the iframe", () => {
  const titleMatch = SLOT.match(/<iframe[\s\S]*?title="([^"]+)"/);
  assert.ok(titleMatch, "iframe must carry a title attribute");
  const title = titleMatch![1]!;
  assert.ok(title.length > 0);
  assert.match(title, /Barkóba/i, "the title must actually describe what the video is, not a generic label");
});

test("a normal external YouTube link is provided as a fallback, targeting the approved video, opening in a new tab safely", () => {
  const linkAt = SLOT.indexOf("<a");
  assert.ok(linkAt > 0, "a fallback <a> link must exist");
  const link = SLOT.slice(linkAt, SLOT.indexOf("</a>", linkAt));
  assert.match(link, /href=\{WELCOME_VIDEO_WATCH_URL\}/);
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
});

test("the old placeholder is no longer displayed", () => {
  assert.doesNotMatch(SLOT, /Bemutató videó hamarosan/);
  assert.doesNotMatch(SLOT, /border-dashed/);
  assert.match(SLOT, /<iframe/, "a real player must now render instead of the placeholder box");
});

test("both existing call sites still reuse the same component unchanged, with no new video mechanism introduced there", () => {
  const purchase = readFileSync("app/purchase/PurchaseClient.tsx", "utf8");
  const claim = readFileSync("app/components/ClaimPrompt.tsx", "utf8");
  assert.match(purchase, /<WelcomeVideoSlot \/>/);
  assert.match(claim, /<WelcomeVideoSlot \/>/);
  assert.doesNotMatch(purchase, /<video|<iframe/);
  assert.doesNotMatch(claim, /<video|<iframe/);
});

/** Every .ts/.tsx file under `dir`, recursively — small, dependency-free walk. */
function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...allSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

test("the video is not wired into any unrelated screen — only its own component and the two pre-existing call sites reference it", () => {
  const referencing = allSourceFiles("app")
    .filter((f) => f !== join("app", "components", "WelcomeVideoSlot.tsx"))
    .filter((f) => readFileSync(f, "utf8").includes("WelcomeVideoSlot"));
  const allowed = new Set([
    join("app", "purchase", "PurchaseClient.tsx"),
    join("app", "components", "ClaimPrompt.tsx"),
  ]);
  for (const f of referencing) {
    assert.ok(allowed.has(f), `unexpected new reference to WelcomeVideoSlot in ${f}`);
  }
  assert.equal(referencing.length, allowed.size, "both pre-existing call sites must still be present");
});

test("gameplay, prompts, credits, engine-selection, authentication, history, and moderation files are untouched by this change", () => {
  for (const file of [
    "lib/prompts/racer.ts",
    "lib/entitlements.ts",
    "lib/racerEngineTier.ts",
    "lib/accountSession.ts",
    "lib/playerAccounts.ts",
    "app/api/player/history/route.ts",
    "app/api/beta/admin/review/route.ts",
  ]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /WelcomeVideoSlot|youtube-nocookie|X29Iyc0vUnk/i, `${file} must not reference the video`);
  }
});
