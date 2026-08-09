import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMPOSER_ANSWER_SYSTEM_PROMPT } from "../lib/prompts/composerAnswer";

// Hermetic guards for the two TASK 5 policies most likely to regress silently,
// because both live in prose rather than in logic.

const validator = readFileSync("lib/prompts/validator.ts", "utf8");
const createRoute = readFileSync("app/api/game/create/route.ts", "utf8");
const composerEntry = readFileSync("app/ComposerEntry.tsx", "utf8");
const gameClient = readFileSync("app/game/[id]/GameClient.tsx", "utf8");

test("POLICY: the Composer owns the target", () => {
  assert.match(validator, /THE COMPOSER OWNS THE TARGET/);
  assert.match(validator, /must NEVER ask for more identifying information/);
  assert.match(
    validator,
    /Validity and difficulty are different questions/,
    "the two concepts must stay separated in the prompt"
  );
});

test("a flagged target can still be played — the override exists", () => {
  // Without `force`, CLARIFICATION_REQUIRED was a dead end with no way past it.
  assert.match(createRoute, /validation\.status === "CLARIFICATION_REQUIRED" && !body\.force/);
  assert.match(composerEntry, /Mégis ezzel játszom/);
  assert.match(composerEntry, /Másik titkot adok meg/);
});

test("the first submission is never silently forced", () => {
  // onClick={submit} would hand React's MouseEvent to `force`, turning every
  // first attempt into an override and bypassing the warning entirely.
  assert.ok(
    !/onClick=\{submit\}/.test(composerEntry),
    "submit must be wrapped so the click event cannot become the force flag"
  );
  assert.match(composerEntry, /onClick=\{\(\) => void submit\(\)\}/);
});

test("private-knowledge is a warning, never a gate", () => {
  assert.match(validator, /private_knowledge/);
  assert.match(validator, /never a reason to reject/);
  assert.match(composerEntry, /Személyes titok/);
  assert.match(
    composerEntry,
    /nem tud önállóan ellenőrizni/,
    "the epistemic limit must be stated before play"
  );
});

test("IS-IS is the Hungarian third answer, and its submit is labelled", () => {
  assert.match(gameClient, /IS-IS/);
  assert.match(gameClient, /IS-IS küldése/, "the submit control must be in Hungarian");
  assert.ok(
    !/Send ambiguous/.test(gameClient),
    "the English label that read as a disabled control must be gone"
  );
  assert.match(gameClient, /IGEN/);
  assert.match(gameClient, /NEM/);
});

test("the Composer answer prompt still forbids disclosure (0.6.0.2 intact)", () => {
  assert.match(COMPOSER_ANSWER_SYSTEM_PROMPT, /NEVER REVEAL THE TARGET/);
});
