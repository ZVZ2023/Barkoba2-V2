import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMPOSER_ANSWER_SYSTEM_PROMPT } from "../lib/prompts/composerAnswer";

// racer / adjudicator / integrityReview keep their system prompts as
// module-local constants. They are not exported, so we assert on the shipped
// source text — which is exactly the string handed to the model.
const RACER_SRC = readFileSync("lib/prompts/racer.ts", "utf8");
const ADJUDICATOR_SRC = readFileSync("lib/prompts/adjudicator.ts", "utf8");
const INTEGRITY_SRC = readFileSync("lib/prompts/integrityReview.ts", "utf8");

/**
 * TASK 8 — player-facing language guarantees.
 *
 * These pin what a player can observe: the three answer words are Hungarian,
 * English answer vocabulary never reaches a screen, and internal role names are
 * never taught to a model that writes player-visible text.
 */

const PLAYER_FACING_FILES = [
  "app/game/[id]/GameClient.tsx",
  "app/game/[id]/RacerClient.tsx",
  "app/game/[id]/ResultPanel.tsx",
  "app/components/EvaluationState.tsx",
  "app/components/GameShell.tsx",
  "app/ComposerEntry.tsx",
  "app/RacerSetup.tsx",
  "lib/ui/copy.ts",
] as const;

/** Comments and imports are not player-visible; strip them before auditing. */
function visibleSource(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
      if (t.startsWith("import ") || t.startsWith("} from")) return false;
      return true;
    })
    .join("\n");
}

for (const path of ["app/game/[id]/GameClient.tsx", "app/game/[id]/RacerClient.tsx"]) {
  test(`${path} renders the three answers as IGEN / NEM / IS-IS`, () => {
    const src = readFileSync(path, "utf8");
    assert.match(src, /YES:\s*"IGEN"/);
    assert.match(src, /NO:\s*"NEM"/);
    assert.match(src, /AMBIGUOUS:\s*"IS-IS"/);
  });
}

// The enum values are legal as CODE (map keys, comparisons) and illegal as
// displayed TEXT — inside a JSX text node or a quoted UI string.
const DISPLAY_LEAKS = [/>\s*(YES|NO|AMBIGUOUS)\s*</, /Partially yes/i];

for (const path of PLAYER_FACING_FILES) {
  test(`${path} displays no English answer vocabulary`, () => {
    const src = visibleSource(path);
    for (const leak of DISPLAY_LEAKS) {
      assert.doesNotMatch(src, leak, `${path} leaks ${String(leak)}`);
    }
  });
}

// Identifiers are fine (ComposerAnswer, RacerClient). Bare words in prose are not.
const PROSE_LEAK =
  /(^|[\s>"'(])(Composer|Racer|Validator|Adjudicator|Integrity Review)([\s.,!?<"')]|$)/;

for (const path of PLAYER_FACING_FILES) {
  test(`${path} contains no internal role word in prose`, () => {
    const offenders = visibleSource(path)
      .split("\n")
      .filter((line) => PROSE_LEAK.test(line))
      .filter((line) => !/:\s*(Composer|Racer)\w*[;,)]/.test(line));
    assert.deepEqual(offenders, [], `${path} shows internal vocabulary to players`);
  });
}

// A prompt must not contain the English phrases it is forbidding: quoting them
// verbatim primes the model with exactly the wording we are trying to prevent.
for (const [name, src] of [
  ["racer", RACER_SRC],
  ["composerAnswer", COMPOSER_ANSWER_SYSTEM_PROMPT],
  ["adjudicator", ADJUDICATOR_SRC],
  ["integrityReview", INTEGRITY_SRC],
] as ReadonlyArray<readonly [string, string]>) {
  test(`${name} prompt does not prime English answer wording`, () => {
    assert.doesNotMatch(src, /Partially yes/i);
  });
}

const VISIBLE_OUTPUT_PROMPTS: ReadonlyArray<readonly [string, string]> = [
  ["racer", RACER_SRC],
  ["composerAnswer", COMPOSER_ANSWER_SYSTEM_PROMPT],
  ["adjudicator", ADJUDICATOR_SRC],
  ["integrityReview", INTEGRITY_SRC],
];

for (const [name, prompt] of VISIBLE_OUTPUT_PROMPTS) {
  test(`${name} prompt forbids internal role names in visible output`, () => {
    assert.match(prompt, /Never use the words "Composer", "Racer"/);
  });
}

for (const [name, prompt] of VISIBLE_OUTPUT_PROMPTS) {
  if (name === "racer") continue;
  test(`${name} prompt requires output in the game language`, () => {
    assert.match(prompt.toLowerCase(), /in the game language/);
  });
}

test("racer prompt no longer teaches the model to say 'the Composer'", () => {
  assert.doesNotMatch(RACER_SRC, /A human Composer has locked/);
  assert.doesNotMatch(RACER_SRC, /The Composer answers YES/);
});

for (const path of ["lib/prompts/adjudicator.ts", "lib/prompts/integrityReview.ts"]) {
  test(`${path} passes an explicit write-in-language instruction`, () => {
    assert.match(readFileSync(path, "utf8"), /Write the reasoning field in \$\{/);
  });
}
