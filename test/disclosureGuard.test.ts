import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SAFE_AMBIGUOUS_EXPLANATION,
  revealsTarget,
  scrubClue,
  scrubExplanation,
} from "../lib/disclosureGuard";

// Hermetic. The invariant: before declassification, no Composer text visible to
// the Racer may reveal the target. Field Test #2 proved a prompt rule alone
// does not hold this, so it is enforced here and tested here.

test("FIELD TEST #2: the exact explanation that leaked is caught", () => {
  const leak =
    "Hair length varies enormously by breed—some dogs have long hair, others have short coats.";
  assert.equal(revealsTarget(leak, "dog"), true, "plural of the target must be caught");

  const scrubbed = scrubExplanation(leak, "dog");
  assert.equal(scrubbed.redacted, true);
  assert.equal(scrubbed.value, SAFE_AMBIGUOUS_EXPLANATION);
  assert.equal(
    revealsTarget(scrubbed.value, "dog"),
    false,
    "the replacement must not itself disclose"
  );
});

test("the replacement is wholesale, not a cut-out", () => {
  // Removing just the word would leave "...some ___ have long hair", whose
  // shape is nearly as informative as the word.
  const scrubbed = scrubExplanation("Some dogs have long hair.", "dog");
  assert.equal(scrubbed.value, SAFE_AMBIGUOUS_EXPLANATION);
  assert.ok(!scrubbed.value!.includes("hair"), "no fragment of the original survives");
});

test("inflections and accents are caught", () => {
  assert.equal(revealsTarget("There are many dogs.", "dog"), true);
  assert.equal(revealsTarget("A bicycles thing", "bicycle"), true);
  assert.equal(revealsTarget("It is a funyiro.", "fűnyíró"), true, "accent-folded");
  assert.equal(revealsTarget("Ez egy fogantyút.", "fogantyú"), true, "hungarian accusative");
});

test("multi-word targets are caught by phrase AND by content word", () => {
  assert.equal(revealsTarget("Think of the Eiffel Tower.", "Eiffel Tower"), true);
  assert.equal(revealsTarget("Something Eiffel designed.", "Eiffel Tower"), true);
  assert.equal(
    revealsTarget("It belongs to a neighbour.", "my neighbor's red bicycle"),
    false,
    "a near-miss word is not a disclosure"
  );
});

test("short and common words do not trigger redaction", () => {
  // "red" is 3 letters and appears constantly; redacting on it would gut
  // every explanation in a game whose target happens to be red.
  assert.equal(revealsTarget("It is a red thing.", "my red bicycle"), false);
  assert.equal(revealsTarget("The colour matters.", "the red car"), false);
});

test("CRITICAL: no substring false positives", () => {
  // "cat" inside "category" was the failure mode that would have made the
  // safe replacement text itself trip the guard.
  assert.equal(revealsTarget("This varies within the target category.", "cat"), false);
  assert.equal(revealsTarget("It is categorised oddly.", "cat"), false);
  assert.equal(revealsTarget("A dogma of some kind.", "dog"), false);
  assert.equal(
    revealsTarget(SAFE_AMBIGUOUS_EXPLANATION, "cat"),
    false,
    "the replacement must be safe for every target, including awkward ones"
  );
});

test("clean text passes through untouched", () => {
  const fine = "That depends on which sense of the word you mean.";
  const r = scrubExplanation(fine, "dog");
  assert.equal(r.redacted, false);
  assert.equal(r.value, fine);
});

test("a disclosing clue is dropped, not replaced", () => {
  // A generic clue would be noise dressed as help.
  const r = scrubClue("Think about dogs you have owned.", "dog");
  assert.equal(r.redacted, true);
  assert.equal(r.value, null);

  const ok = scrubClue("Think about what lives in a house.", "dog");
  assert.equal(ok.redacted, false);
  assert.equal(ok.value, "Think about what lives in a house.");
});

test("null and empty inputs are inert", () => {
  assert.equal(revealsTarget(null, "dog"), false);
  assert.equal(revealsTarget("", "dog"), false);
  assert.equal(scrubExplanation(null, "dog").value, null);
});
