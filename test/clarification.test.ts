import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_CLARIFICATION_MARKER,
  hasClarification,
  renderClarification,
} from "../lib/prompts/clarification";

// The clarification is optional as of 0.3.1.1, and three prompts consume it.
// These assertions keep the empty case rendering identically in all three —
// the failure mode is one prompt drifting and adjudicating differently from
// the reviewer that judges the same game.

test("present clarification passes through trimmed", () => {
  assert.equal(renderClarification("  the handle on my mower  "), "the handle on my mower");
});

test("absent clarification renders an explicit marker, never an empty label", () => {
  for (const empty of ["", "   ", "\n\t", null, undefined]) {
    assert.equal(
      renderClarification(empty),
      NO_CLARIFICATION_MARKER,
      `${JSON.stringify(empty)} must render the marker, not a dangling label`
    );
  }
});

test("the marker explains the absence rather than merely noting it", () => {
  // A prompt reading a bare "(none)" can mistake a Composer who was never
  // required to answer for one who refused.
  assert.match(NO_CLARIFICATION_MARKER, /self-explanatory/);
});

test("hasClarification distinguishes blank from present", () => {
  assert.equal(hasClarification("x"), true);
  assert.equal(hasClarification("   "), false);
  assert.equal(hasClarification(null), false);
  assert.equal(hasClarification(undefined), false);
});
