import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * TASK 9 — every API `message` is rendered to the player verbatim by the
 * clients (`data.message`). They were all English through 0.9.6.0. The field
 * test never hit one, which is the only reason localization read as PASS.
 */

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return routeFiles(p);
    return e.name === "route.ts" ? [p] : [];
  });
}

// A few messages are pure protocol vocabulary the player can never trigger
// through the UI; they name a field or an endpoint and are allowed to keep it.
const TECHNICAL_TOKENS = /turn_index|JSON|\/turn|VALID_ANSWERS/;

const ENGLISH_GIVEAWAY =
  /\b(could not|cannot|please|try again|the game|this game|is required|no such|must be|available|questions? left|your game)\b/i;

for (const file of routeFiles("app/api")) {
  test(`${file} has no English player-facing message`, () => {
    const offenders = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => /message:|^\s+\? "|^\s+: "/.test(l))
      .filter((l) => ENGLISH_GIVEAWAY.test(l))
      .filter((l) => !TECHNICAL_TOKENS.test(l));
    assert.deepEqual(offenders, [], `${file} leaks English to the player`);
  });
}

test("no API message names an internal role to the player", () => {
  for (const file of routeFiles("app/api")) {
    const offenders = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => /message:|^\s+\? "|^\s+: "/.test(l))
      .filter((l) => /\b(Composer|Racer|Validator|Adjudicator)\b/.test(l));
    assert.deepEqual(offenders, [], `${file} shows internal vocabulary to the player`);
  }
});

test("the validator is told which language to write its player message in", () => {
  const src = readFileSync("lib/prompts/validator.ts", "utf8");
  assert.match(src, /THE LANGUAGE OF YOUR MESSAGE/);
  assert.match(src, /Never use the words "Composer", "Racer"/);
});
