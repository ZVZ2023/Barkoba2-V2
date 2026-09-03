import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.8.4.3 — the "PC" incident's pre-game warning: the Target Validator told
// the Composer that "PC" was "too broad" and should be narrowed by type,
// era, or brand, even though Phase One's own referent-scope rule (V2.8.4.1)
// treats a valid kind/category as a complete, resolvable target on its own —
// ANY object genuinely matching it counts as correct. The Validator's prompt
// never knew that; it warned purely because many things could match.
//
// Hermetic, source-contract only: no real provider call proves the MODEL
// will apply this correctly (the same limit test/integrityReviewMateriality
// .test.ts documents for its own prompt) — what IS provable is that the
// required rule is actually stated, in force, and uses the same
// kind/category vs. particular-instance vocabulary Phase One itself uses,
// rather than inventing a second, potentially inconsistent, concept.
// ---------------------------------------------------------------------------

const VALIDATOR_SRC = readFileSync("lib/prompts/validator.ts", "utf8");
const PHASE_ONE_SRC = readFileSync("lib/phaseOne.ts", "utf8");

test("13. the Validator is told category breadth is not a defect and must not be warned about", () => {
  assert.match(VALIDATOR_SRC, /CATEGORY BREADTH IS NOT A DEFECT/);
  assert.match(
    VALIDATOR_SRC,
    /Never set difficulty_warning.*for the sole reason that many different things could match/s
  );
  assert.match(
    VALIDATOR_SRC,
    /never suggest narrowing by type, era, brand, model, or unique individual/
  );
  assert.match(
    VALIDATOR_SRC,
    /a valid category is exactly as complete a target as a single specific instance/
  );
});

test("13b. the difficulty_warning schema field itself carries the same constraint, not just the prose instructions", () => {
  const schemaBlock = VALIDATOR_SRC.slice(
    VALIDATOR_SRC.indexOf("difficulty_warning: {"),
    VALIDATOR_SRC.indexOf("private_knowledge: {")
  );
  assert.match(
    schemaBlock,
    /never merely because multiple real things would match it/
  );
});

test("13c. genuine problems independent of breadth are still explicitly in scope for a warning", () => {
  assert.match(VALIDATOR_SRC, /irresolvable ambiguity between genuinely unrelated referents/);
  assert.match(VALIDATOR_SRC, /an internal contradiction between the target and its own clarification/);
  assert.match(VALIDATOR_SRC, /a distinction so subjective that no outside observer could judge a guess against it/);
  assert.match(VALIDATOR_SRC, /specialist\/obscure knowledge the question budget could not realistically uncover/);
});

test("14. the Validator's category-breadth language uses the SAME kind/category vs. particular-instance vocabulary as Phase One's referent-scope rule", () => {
  // Phase One's own PhaseOneSpecificity type and its referent-scope question
  // are built on exactly these two terms (lib/phaseOne.ts) -- the Validator
  // must speak the same vocabulary rather than a second, driftable one.
  assert.match(PHASE_ONE_SRC, /"particular" \| "kind" \| "mixed"/);
  assert.match(PHASE_ONE_SRC, /kind\/category/);
  assert.match(VALIDATOR_SRC, /a kind or category as the whole target/);
  assert.match(VALIDATOR_SRC, /single specific instance/);
});

test("14b. the pre-existing VALID/CLARIFICATION_REQUIRED/INVALID contract and the difficulty-vs-invalidity distinction are unchanged", () => {
  // The new paragraph is an ADDITION alongside the existing rules, not a
  // replacement of them -- both must still be present and unmodified.
  assert.match(VALIDATOR_SRC, /Validity and difficulty are different questions/);
  assert.match(VALIDATOR_SRC, /Important: difficulty is not invalidity/);
  assert.match(VALIDATOR_SRC, /THE COMPOSER OWNS THE TARGET/);
});
