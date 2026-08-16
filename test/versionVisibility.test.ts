import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * TASK 9 — build identity must be VISIBLE, not merely present.
 *
 * The 0.9.6.0 bug: SiteFooter accepted a `version` prop and never rendered it.
 * The string still appeared in the page source, because Next serializes client
 * component props into the RSC payload inside a <script> tag. Grepping the
 * HTML therefore reported "present" while nothing was ever painted, and a field
 * tester on an iPhone could not find the version at all.
 *
 * These tests guard the bug class: a component that ACCEPTS a version prop must
 * INTERPOLATE it.
 */

const VERSION_PROP_COMPONENTS: ReadonlyArray<readonly [string, string]> = [
  ["app/components/SiteFooter.tsx", "version"],
  ["app/components/GameShell.tsx", "version"],
  ["app/game/[id]/GameClient.tsx", "versionLabel"],
  ["app/game/[id]/RacerClient.tsx", "versionLabel"],
];

for (const [path, prop] of VERSION_PROP_COMPONENTS) {
  test(`${path} accepts ${prop} and actually renders it`, () => {
    const src = readFileSync(path, "utf8");
    assert.match(src, new RegExp(`\\b${prop}\\b`), `${path} should take ${prop}`);
    assert.match(
      src,
      new RegExp(`\\{\\s*${prop}\\s*\\}`),
      `${path} accepts ${prop} but never interpolates it — the 0.9.6.0 bug`,
    );
  });
}

test("the game screens show the version above the transcript, not only at the foot", () => {
  for (const path of ["app/game/[id]/GameClient.tsx", "app/game/[id]/RacerClient.tsx"]) {
    const src = readFileSync(path, "utf8");
    const headerEnd = src.indexOf("</header>");
    assert.ok(headerEnd > 0, `${path} has no <header>`);
    const inHeader = src.slice(0, headerEnd).includes("{versionLabel}");
    assert.ok(
      inHeader,
      `${path} renders the version only below the transcript — a scroll hunt on mobile`,
    );
  }
});

test("no component hardcodes a version string; all read the single source", () => {
  for (const [path] of VERSION_PROP_COMPONENTS) {
    assert.doesNotMatch(
      readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
      /v\d+\.\d+\.\d+\.\d+/,
      `${path} contains a literal version string`,
    );
  }
});

// ---------------------------------------------------------------------------
// V2.5 — the Racer seat's configuration must be observable before a game.
//
// The model is chosen by an environment variable, and environment changes do
// not reach a running deployment. Without this block the only way to find out
// which model a runtime races is to play a game and read the corpus afterwards
// — the wrong order for a field test, and the same blind spot corpusConfigStatus
// was added to fix.
// ---------------------------------------------------------------------------

test("/api/version reports which model fills the Racer seat", () => {
  const src = readFileSync("app/api/version/route.ts", "utf8");
  assert.match(src, /racer: \{/);
  assert.match(src, /xai_model: env\.xaiModelRacer\(\)/);
  assert.match(src, /xai_available: isProviderAvailable\("xai"\)/);
  assert.match(src, /anthropic_model: env\.modelRacer\(\)/);
});

test("/api/version leaks no credential while reporting the Racer seat", () => {
  const src = readFileSync("app/api/version/route.ts", "utf8");
  // Model names are vendor identifiers, not secrets. Keys are.
  assert.doesNotMatch(src, /xaiApiKey|anthropicApiKey|XAI_API_KEY|ANTHROPIC_API_KEY/);
  assert.doesNotMatch(src, /benchmarkIngressSecret|entitlementGrantSecret/);
});

test("the shipped default Racer model is unchanged by the field test", () => {
  // The field test is switched on by SETTING XAI_MODEL_RACER, never by moving
  // the default. A future deploy without the variable must behave as it always
  // has, rather than silently racing whichever model was last experimented with.
  assert.match(readFileSync("lib/env.ts", "utf8"), /XAI_MODEL_RACER \|\| "grok-4\.6"/);
});

test("player-facing counts use Hungarian formatting, never 'X of Y'", () => {
  for (const path of [
    "app/game/[id]/GameClient.tsx",
    "app/game/[id]/RacerClient.tsx",
    "app/game/[id]/ResultPanel.tsx",
  ]) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /\{game\.question_count\}\s*of\s*\{game\.max_questions\}/,
      `${path} still renders the English "X of Y" count`,
    );
  }
});
