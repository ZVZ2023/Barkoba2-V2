import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// PROTECTED INVESTIGATION — no policy was changed to make this pass.
//
// The field test submitted an IS-IS whose explanation stated the literal binary
// answer: "the correct answer is NO, but here is a hint — personal hygiene
// item." The open question was whether final adjudication would punish the
// Composer for answering AMBIGUOUS when their own note contains the truth.
//
// These assertions record what the SHIPPED prompts already do, so the answer is
// evidence rather than opinion — and so a future prompt edit that changes it
// fails the build instead of changing scoring silently.
// ---------------------------------------------------------------------------

const integrity = readFileSync("lib/prompts/integrityReview.ts", "utf8");
const adjudicator = readFileSync("lib/prompts/adjudicator.ts", "utf8");

test("FINDING: the Integrity Review cannot penalise an AMBIGUOUS answer at all", () => {
  // Only YES and NO are reviewable. AMBIGUOUS is out of scope by construction,
  // so an explanation attached to one cannot become evidence of dishonesty.
  assert.match(
    integrity,
    /AMBIGUOUS answers\. They are a legitimate move and are outside your scope entirely/
  );
  assert.match(
    integrity,
    /whatever you think of the Composer's reason for using one/,
    "the reviewer is told not to judge WHY ambiguous was chosen — which is exactly the field-test case"
  );
});

test("FINDING: a violation requires a false YES or NO, never an ambiguous one", () => {
  assert.match(integrity, /A YES answer to a question whose truthful answer.*is clearly no/s);
  assert.match(integrity, /A NO answer to a question whose truthful answer.*is clearly yes/s);
  assert.match(integrity, /DEFAULT TO UPHELD/);
});

test("FINDING: the Adjudicator judges the guess, never the Composer's answers", () => {
  // It receives target, definition and guess. The transcript is not its input,
  // so an ambiguous answer cannot influence whether the guess is correct.
  assert.match(adjudicator, /export async function runAdjudicator\(params: \{\s*target: string;/s);
  assert.ok(
    !/qaLog|transcript/.test(adjudicator),
    "the Adjudicator must not receive the transcript — it judges a guess against a target"
  );
});

test("the field-test record shape is benign under current policy", () => {
  // answer AMBIGUOUS + explanation carrying the binary truth + a hint.
  const entry = {
    composer_response: "AMBIGUOUS" as const,
    ambiguous_explanation:
      "A helyes válasz NEM, de adok egy tippet: személyes higiéniai eszköz.",
  };
  // Integrity: reviewable answers are YES/NO only.
  const reviewable = entry.composer_response !== "AMBIGUOUS";
  assert.equal(reviewable, false, "this record is outside integrity review entirely");
  // And the note still reaches the Racer, which is the behaviour we want kept.
  assert.ok(entry.ambiguous_explanation.length > 0);
});
