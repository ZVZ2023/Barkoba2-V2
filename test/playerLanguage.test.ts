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
  "app/history/HistoryClient.tsx",
  "lib/ui/copy.ts",
] as const;

/**
 * R0 — remove genuine block comments (`/* … *\/`, including the JSX form
 * `{/* … *\/}` and comments spanning several lines) before the line audit.
 *
 * WHY A SCANNER AND NOT A REGEX. A global `/\/\*[\s\S]*?\*\//` would also
 * erase a string literal that merely CONTAINS comment-like characters — and
 * strings are exactly the player-visible content this file exists to audit.
 * So the scanner tracks string literals and only opens a comment from code
 * or JSX position, never from inside `'…'`, `"…"` or `` `…` ``.
 *
 * FAILS TOWARD FALSE POSITIVES, NEVER TOWARD HIDING TEXT. Every ambiguity
 * is resolved by keeping characters: an apostrophe in JSX text ("Don't")
 * opens a bogus string state, which lasts at most until the end of that line
 * and merely prevents a comment on the same line from being stripped — the
 * audit then over-reports, it never under-reports. An unterminated `/*` is
 * kept verbatim for the same reason. Newlines inside a stripped comment are
 * preserved so the audit still reports offenders line by line.
 *
 * Line comments (`// …`) are deliberately NOT handled here: `//` is common
 * inside visible URLs, and stripping to end-of-line from code position could
 * hide a role word that follows one. Lines that BEGIN with `//` are still
 * dropped by the line filter below, as before.
 */
function stripBlockComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: "'" | '"' | "`" | null = null;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < source.length) {
        out += next;
        i += 2;
        continue;
      }
      // A single- or double-quoted literal cannot span a raw newline; leaving
      // the state here bounds the damage of a stray apostrophe in JSX text.
      if (ch === quote || (ch === "\n" && quote !== "`")) quote = null;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) {
        // Unterminated: not a comment we can prove. Keep it visible.
        out += source.slice(i);
        break;
      }
      // Keep the comment's newlines so line numbers survive the strip.
      out += source.slice(i, end + 2).replace(/[^\n]/g, "");
      i = end + 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** Comments and imports are not player-visible; strip them before auditing. */
function visibleSourceText(source: string): string {
  return stripBlockComments(source)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
      if (t.startsWith("import ") || t.startsWith("} from")) return false;
      return true;
    })
    .join("\n");
}

function visibleSource(path: string): string {
  return visibleSourceText(readFileSync(path, "utf8"));
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

/** The guard itself, on already-audited source text. Pure, so it can be exercised on fixtures. */
function proseOffenders(visible: string): string[] {
  return visible
    .split("\n")
    .filter((line) => PROSE_LEAK.test(line))
    .filter((line) => !/:\s*(Composer|Racer)\w*[;,)]/.test(line));
}

for (const path of PLAYER_FACING_FILES) {
  test(`${path} contains no internal role word in prose`, () => {
    const offenders = proseOffenders(visibleSource(path));
    assert.deepEqual(offenders, [], `${path} shows internal vocabulary to players`);
  });
}

// ---------------------------------------------------------------------------
// R0 regression coverage for the audit helper itself.
//
// The V2.8.5 release added a multi-line `{/* … */}` comment to GameClient.tsx
// whose continuation lines begin with neither `//`, `*` nor `/*`; the old
// line-prefix filter read them as player-visible prose and the guard fired
// on developer commentary. The correction must ignore genuine comments AND
// still catch the same words wherever a player could actually read them.
// ---------------------------------------------------------------------------

test("audit ignores internal role words inside genuine block comments", () => {
  const fixture = [
    "const a = 1; {/* the Racer waits here */}",
    "<div>",
    "  {/*",
    "    V2.8.5 — this corridor costs no Racer question, and",
    "    the Composer is asked privately; see the Validator notes.",
    "  */}",
    "  /* an Adjudicator note that",
    "     continues without a leading star */",
    "  {value}",
    "</div>",
    "// a Racer line comment",
    " * a Racer JSDoc continuation line",
  ].join("\n");

  assert.deepEqual(proseOffenders(visibleSourceText(fixture)), []);
});

test("audit still catches internal role words in player-visible JSX text", () => {
  const fixture = [
    "<p>The Racer is thinking.</p>",
    "<p>Az Integrity Review befejeződött.</p>",
  ].join("\n");

  assert.deepEqual(proseOffenders(visibleSourceText(fixture)), [
    "<p>The Racer is thinking.</p>",
    "<p>Az Integrity Review befejeződött.</p>",
  ]);
});

test("audit still catches internal role words in string literals", () => {
  const fixture = [
    'const label = "Ask the Composer.";',
    "const hint = `The Validator says no.`;",
    "const tip = 'Wait for the Adjudicator';",
  ].join("\n");

  assert.deepEqual(proseOffenders(visibleSourceText(fixture)), [
    'const label = "Ask the Composer.";',
    "const hint = `The Validator says no.`;",
    "const tip = 'Wait for the Adjudicator';",
  ]);
});

test("a string that merely contains comment-like characters is not erased", () => {
  const fixture = [
    'const note = "See /* this */ before the Racer moves";',
    "const url = \"https://example.test/*/ Composer \";",
  ].join("\n");

  const visible = visibleSourceText(fixture);
  // Nothing inside the quotes was stripped …
  assert.equal(visible, fixture);
  // … so the guard still sees the role words.
  assert.deepEqual(proseOffenders(visible), [
    'const note = "See /* this */ before the Racer moves";',
    "const url = \"https://example.test/*/ Composer \";",
  ]);
});

test("visible text on the same line as a stripped comment is still audited", () => {
  const fixture = "<span>{/* private */} The Racer waits</span>";
  assert.deepEqual(proseOffenders(visibleSourceText(fixture)), ["<span>{} The Racer waits</span>"]);
});

test("an unterminated block comment is kept visible rather than swallowing the file", () => {
  const fixture = ["const x = 1; /* never closed", "<p>The Racer is here.</p>"].join("\n");
  assert.deepEqual(proseOffenders(visibleSourceText(fixture)), ["<p>The Racer is here.</p>"]);
});

test("the stripped comment keeps its newlines so offenders keep their own lines", () => {
  const fixture = ["{/*", "  two", "  lines", "*/}", "<p>The Composer waits.</p>"].join("\n");
  const visible = visibleSourceText(fixture);
  assert.equal(visible.split("\n").length, fixture.split("\n").length);
  assert.deepEqual(proseOffenders(visible), ["<p>The Composer waits.</p>"]);
});

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
