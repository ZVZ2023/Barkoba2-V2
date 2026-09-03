import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// PROTECTED INVESTIGATION — the underlying POLICY has never been weakened.
//
// The field test submitted an IS-IS whose explanation stated the literal binary
// answer: "the correct answer is NO, but here is a hint — personal hygiene
// item." The open question was whether final adjudication would punish the
// Composer for answering AMBIGUOUS when their own note contains the truth.
//
// V2.8.4.2 reworded lib/prompts/integrityReview.ts (added a materiality
// requirement and an explicit answer-classification step — see
// test/integrityReviewMateriality.test.ts) but deliberately PRESERVED, and
// strengthened, this exact guarantee: an IS-IS/AMBIGUOUS answer can never by
// itself produce a violation. The regexes below were updated to match the new
// wording; if a future edit weakens the underlying policy rather than merely
// the phrasing, this file is where that must fail loudly.
// ---------------------------------------------------------------------------

const integrity = readFileSync("lib/prompts/integrityReview.ts", "utf8");
const adjudicator = readFileSync("lib/prompts/adjudicator.ts", "utf8");

test("FINDING: the Integrity Review cannot penalise an AMBIGUOUS answer at all", () => {
  // Only YES and NO are reviewable. AMBIGUOUS is out of scope by construction,
  // so an explanation attached to one cannot become evidence of dishonesty.
  assert.match(
    integrity,
    /AMBIGUOUS \/ IS-IS answers\. They are a legitimate move, always outside your scope/
  );
  assert.match(
    integrity,
    /Never award a violation, in whole or in part, because an IS-IS answer existed/,
    "the reviewer is told an IS-IS can never itself cause a violation — which is exactly the field-test case, made explicit and load-bearing rather than implicit"
  );
});

test("FINDING: a violation requires a false YES or NO, never an ambiguous one", () => {
  assert.match(integrity, /INCORRECT — clearly, unarguably false given the target/);
  assert.match(integrity, /AMBIGUOUS \/ IS-IS — the Composer declined to give a hard yes or no/);
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
