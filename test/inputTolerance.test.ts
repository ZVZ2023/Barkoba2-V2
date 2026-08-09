import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMPOSER_ANSWER_SYSTEM_PROMPT as PROMPT } from "../lib/prompts/composerAnswer";

// Hermetic. Fragment tolerance was working purely on model goodwill — nothing
// in the prompt asked for it, so any future prompt edit could have removed it
// silently. These pin it as a stated product rule.

test("PRODUCT RULE: question marks and full grammar are not required", () => {
  assert.match(PROMPT, /FRAGMENTS ARE QUESTIONS/);
  assert.match(PROMPT, /question mark and full question grammar are NOT required/);
});

test("the field-test fragments are named explicitly in the prompt", () => {
  for (const fragment of ["Alive", "Tool", "Man made", "Used outside", "Pedaling it"]) {
    assert.ok(
      PROMPT.includes(fragment),
      `"${fragment}" should be a worked example, not left to inference`
    );
  }
});

test("terseness must not be answered with AMBIGUOUS", () => {
  // The likely failure mode: the Composer treats a bare word as unanswerable
  // and burns the player's question telling them to write a full sentence.
  assert.match(PROMPT, /Never answer AMBIGUOUS merely because the input was terse/);
  assert.match(PROMPT, /it is a keyboard/);
});

test("native mobile input assistance is not suppressed anywhere", () => {
  for (const file of [
    "app/game/[id]/RacerClient.tsx",
    "app/game/[id]/GameClient.tsx",
    "app/ComposerEntry.tsx",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.ok(
      !/spellCheck=\{false\}|autoCorrect="off"|autoComplete="off"/.test(src),
      `${file} must not disable native correction`
    );
    assert.match(src, /spellCheck/, `${file} should opt in explicitly`);
  }
});

test("the version reaches every gameplay screen, not just the site footer", () => {
  // "It is in the footer" was true and useless: game screens have no footer.
  //
  // This asserts the BEHAVIOUR — a version arrives and is rendered — not the
  // mechanism. An earlier version of this test pinned getAppVersion() inside
  // GameShell, which then failed when that call had to move for a real reason
  // (node:fs cannot be in a client bundle). A test that breaks on a correct
  // fix is testing the wrong thing.
  const shell = readFileSync("app/components/GameShell.tsx", "utf8");
  assert.match(shell, /version\?: string/, "GameShell must accept a version");
  assert.match(shell, /\{version\}/, "GameShell must render it");

  for (const file of ["app/RacerSetup.tsx", "app/ComposerEntry.tsx"]) {
    assert.match(
      readFileSync(file, "utf8"),
      /version=\{versionLabel\}/,
      `${file} must pass its version through to the shell`
    );
  }
  for (const file of ["app/game/[id]/GameClient.tsx", "app/game/[id]/RacerClient.tsx"]) {
    assert.match(
      readFileSync(file, "utf8"),
      /\{versionLabel\}/,
      `${file} must actually render its version prop`
    );
  }
});

test("GameShell stays free of node:fs — it is used by client components", () => {
  const shell = readFileSync("app/components/GameShell.tsx", "utf8");
  // Match an IMPORT, not any mention — the file explains this hazard in a
  // comment, and a substring check flagged its own documentation.
  assert.ok(
    !/^import .*(appVersion|node:fs)/m.test(shell),
    "reading the VERSION file here drags node:fs into the browser bundle and fails the build"
  );
});
