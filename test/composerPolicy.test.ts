import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPOSER_ANSWER_SYSTEM_PROMPT as PROMPT } from "../lib/prompts/composerAnswer";
import { revealsTarget, scrubExplanation } from "../lib/disclosureGuard";

// Hermetic, no API. Two things worth pinning deterministically:
//
//   1. The Composer actually receives the clarified policy. Prompt text is the
//      deliverable in this change, so it is what gets asserted.
//   2. The safe explanation style the policy recommends survives the
//      disclosure guard. Recommending wording that the guard then redacts
//      would be a self-inflicted failure, and a silent one.

test("the Composer receives the governing AMBIGUOUS rule verbatim", () => {
  assert.match(
    PROMPT,
    /Answer YES or NO when one is reasonably defensible for the locked target under ordinary human meaning/
  );
  assert.match(PROMPT, /either binary answer would mislead the Racer/);
});

test("both justifications for AMBIGUOUS are present, and only those two", () => {
  assert.match(PROMPT, /TWO READINGS OF THE QUESTION disagree/);
  assert.match(PROMPT, /THE CATEGORY ITSELF SPLITS/);
  // The 0.6.0.1 correction must survive: nuance alone still is not enough.
  assert.match(PROMPT, /Nuance alone is not enough/);
  assert.match(PROMPT, /An explanation that resolves the question proves the question was answerable/);
});

test("the rule that keeps the two corrections from fighting is stated", () => {
  // 0.6.0.1 pushed away from AMBIGUOUS, 0.6.0.3 pushes toward it. Without an
  // explicit separating test the model would just swing back.
  assert.match(PROMPT, /does the split fall INSIDE the locked target/);
});

test("ordinary-language reading must not be stretched toward convenience", () => {
  assert.match(PROMPT, /Do not stretch a question's wording toward the answer that is convenient/);
  assert.match(PROMPT, /over open water/);
});

test("non-disclosure survives this change", () => {
  assert.match(PROMPT, /NEVER REVEAL THE TARGET IN ANYTHING THE PLAYER READS/);
  // And the category-split case gets its own non-disclosing instruction.
  assert.match(PROMPT, /Never name the members, species, regions or subtypes that differ/);
});

test("the recommended safe wording passes the guard for real targets", () => {
  // If the phrasing the policy tells the Composer to use were itself redacted,
  // every category-split explanation would be silently replaced.
  const safe =
    "Some members of the target category fit that description while others do not, so YES or NO alone would be misleading.";
  for (const target of ["penguin", "dog", "bicycle", "Eiffel Tower", "wristwatch"]) {
    assert.equal(
      revealsTarget(safe, target),
      false,
      `recommended wording must survive the guard for target "${target}"`
    );
    assert.equal(scrubExplanation(safe, target).redacted, false);
  }
});

test("the replacement never discloses, even for degenerate targets", () => {
  // The ordinary replacement contains "category" and "characteristic". If the
  // target were one of those, substituting it would hand over the target while
  // claiming to protect it. Found by test, not by play.
  for (const target of ["category", "characteristic", "penguin", "dog"]) {
    const out = scrubExplanation("A blatant mention of the target.", target);
    const finalText = out.value ?? "";
    assert.equal(
      revealsTarget(finalText, target),
      false,
      `replacement must be safe for target "${target}" — got: ${finalText}`
    );
  }
});

test("a category-split explanation naming what splits is still caught", () => {
  // The permitted shape is "some members differ". Naming the members is the
  // same disclosure as naming the target.
  const leaky =
    "Some penguins live in Africa while others do not, so neither answer fits.";
  assert.equal(revealsTarget(leaky, "penguin"), true);
  assert.equal(scrubExplanation(leaky, "penguin").redacted, true);
});
