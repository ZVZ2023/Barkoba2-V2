import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveResult } from "../lib/resolveResult";

// ---------------------------------------------------------------------------
// V2.8.4.2 — ADJUDICATOR INTEGRITY CORRECTION.
//
// "The adjudicator" in this ticket's language is lib/prompts/integrityReview.ts
// (the Integrity Reviewer), not lib/prompts/adjudicator.ts (which judges the
// final guess against the target and never sees the transcript — see
// test/isIsAdjudication.test.ts's own FINDING on that). The Integrity Review is
// the ONLY component that reads the complete question/answer ledger and can
// flip a result to racer_win_integrity_violation — see lib/resolveResult.ts's
// table.
//
// Hermetic throughout: no real provider call. Per this project's established
// convention (no jsdom, no rendering harness), the model's own judgment
// quality cannot be tested without a real call — what CAN be tested, and what
// this file tests, is (1) the PROMPT CONTRACT itself (the required rules are
// actually stated, in force, and did not silently regress), and (2) the
// EXISTING, unmodified resolution plumbing (lib/resolveResult.ts) correctly
// converts a given verdict into the required outcome, whatever produced that
// verdict. See scripts/evalAdjudicator.ts for the (deliberately separate,
// costed, not part of `npm test`) real-model evaluation harness.
// ---------------------------------------------------------------------------

const INTEGRITY_SRC = readFileSync("lib/prompts/integrityReview.ts", "utf8");

// --- Prompt-contract: the required rules are actually present -------------

test("requires classifying relevant answers into the four required categories, and the verdict must rest on that classification", () => {
  // V2.8.7 — the step is still mandatory; the wording no longer narrates the
  // reviewer's internal ordering (Claude Fable 5.1's classifier refused that
  // as reasoning extraction). The rule itself is unchanged.
  assert.match(INTEGRITY_SRC, /STEP 1 — CLASSIFY EVERY RELEVANT ANSWER\./);
  assert.match(INTEGRITY_SRC, /the verdict must rest on this classification of the visible answers/);
  assert.match(INTEGRITY_SRC, /CORRECT — plainly true given the target/);
  assert.match(INTEGRITY_SRC, /DEFENSIBLE — a reasonable person could truthfully have answered this way/);
  assert.match(INTEGRITY_SRC, /AMBIGUOUS \/ IS-IS — the Composer declined to give a hard yes or no/);
  assert.match(INTEGRITY_SRC, /INCORRECT — clearly, unarguably false given the target/);
});

test("requires materiality: an incorrect answer alone is not enough, it must have redirected the visible questioning or made the solution unreasonably difficult", () => {
  assert.match(INTEGRITY_SRC, /MATERIALITY/);
  // V2.8.7 — judged against the visible line of questioning, never against
  // the Racer's private reasoning (which the review is never given).
  assert.match(
    INTEGRITY_SRC,
    /did this specific incorrect answer materially redirect the visible line of questioning, or make reaching the correct solution unreasonably difficult/
  );
  assert.doesNotMatch(INTEGRITY_SRC, /Racer's reasoning/);
  assert.match(
    INTEGRITY_SRC,
    /Only return "violated" when at least one INCORRECT answer both exists AND was materially causal/
  );
});

test("IS-IS/AMBIGUOUS answers are excluded from materiality analysis entirely, not merely discouraged", () => {
  assert.match(
    INTEGRITY_SRC,
    /Never award a violation, in whole or in part, because an IS-IS answer existed/
  );
  assert.match(
    INTEGRITY_SRC,
    /materiality analysis under STEP 2 applies only to answers you classified INCORRECT, never to AMBIGUOUS ones/
  );
});

test("preserves the installed-level vs. geometric-orientation vs. structural-role distinction (the Window/beam regression), without overgeneralizing", () => {
  // The distinction itself, and the concrete Window example, are preserved.
  assert.match(INTEGRITY_SRC, /installed level or plumb is different from the object's geometric orientation/);
  assert.match(INTEGRITY_SRC, /is not thereby a "horizontal structural element\."/);

  // V2.8.4.2 wording correction: must NOT claim every window is nonstructural
  // in every context -- only that ordinary construction, ABSENT target-
  // specific evidence otherwise, treats one that way.
  assert.match(INTEGRITY_SRC, /absent target-specific evidence of a specialized structural system/);
  assert.doesNotMatch(
    INTEGRITY_SRC,
    /neither structural nor load-bearing/,
    "must not assert this as an unconditional fact about windows in general"
  );

  // Must NOT claim a window is inherently vertical or necessarily taller
  // than wide -- replaced with a neutral "contains both" framing.
  assert.doesNotMatch(INTEGRITY_SRC, /conventionally described as vertical/);
  assert.doesNotMatch(INTEGRITY_SRC, /taller in its plane than deep/);
  assert.match(INTEGRITY_SRC, /containing both horizontal and vertical parts/);
  assert.match(
    INTEGRITY_SRC,
    /its overall orientation cannot be inferred merely from the fact that it was installed level/
  );

  // Must NOT auto-classify as incorrect -- only "a candidate for", requiring
  // target-specific context and the complete ledger before any verdict.
  assert.match(INTEGRITY_SRC, /Treat a YES that conflates these properties as a candidate for INCORRECT/);
  assert.match(
    INTEGRITY_SRC,
    /determine materiality from the target's private clarification and the complete ledger/
  );
  assert.match(INTEGRITY_SRC, /exactly as STEP 2 requires — never automatically/);
});

test("treats optional notes as context, never as a replacement for the selected structured answer", () => {
  assert.match(
    INTEGRITY_SRC,
    /OPTIONAL NOTES ARE CONTEXT, NEVER A REPLACEMENT FOR THE SELECTED ANSWER/
  );
  assert.match(
    INTEGRITY_SRC,
    /The Composer's structured YES\/NO\/IS-IS choice is the authoritative record of what they answered/
  );
});

test("tolerates ordinary typos, missing accents, and autocorrect substitutions in notes contextually (Igen, de Bem jellemző)", () => {
  assert.match(INTEGRITY_SRC, /ordinary spelling mistakes, missing accent marks, and obvious phone-autocorrect substitutions/);
  assert.match(INTEGRITY_SRC, /Hungarian "Bem" for "nem" is a keyboard\/autocorrect slip, not a different word/);
});

test("explains disputed terminology educationally, without blaming the player", () => {
  assert.match(
    INTEGRITY_SRC,
    /Explain any disputed terminology plainly and educationally.*without framing it as blaming the player/
  );
  assert.match(INTEGRITY_SRC, /a mistake to explain, not a character judgment/);
});

test("still defaults to upheld and still requires a real, unarguable incorrect answer (the pre-existing conservative bias is not weakened)", () => {
  assert.match(INTEGRITY_SRC, /DEFAULT TO UPHELD/);
  assert.match(INTEGRITY_SRC, /A wrong accusation is worse than a missed one/);
});

// --- Plumbing: the EXISTING, unmodified resolveResult table produces the ---
// --- required outcome for a materially-causal violation, and does not for --
// --- an ambiguous-only dispute. This proves the mechanism the prompt's ------
// --- verdict feeds into is already correct -- see lib/resolveResult.ts. ----

test("REGRESSION (Window/beam): a mocked verdict of a materially causal confirmed-incorrect answer produces racer_win_integrity_violation", () => {
  // Simulates what a compliant Integrity Review is required (by the prompt
  // contract above) to return for the observed regression: the Composer
  // answered YES to "is it a horizontal structural element" and YES to "is it
  // a linear structural element" for a target of Window/Ablak (kind/category)
  // -- confirmed incorrect, and materially causal, since the Racer's own next
  // guess ("beam") was a direct consequence of exactly that misdirection.
  const mockedVerdict = "violated" as const;
  const result = deriveResult({
    finalAction: "guess",
    adjudicator: "incorrect", // the Racer's "beam" guess was not the target
    integrity: mockedVerdict,
  });
  assert.equal(result, "racer_win_integrity_violation");
});

test("REGRESSION control: a mocked verdict where the only dispute is an IS-IS answer produces NO integrity violation, even on an incorrect guess", () => {
  // The prompt contract above makes it structurally impossible for an
  // IS-IS-only dispute to justify "violated" -- this proves that if the
  // reviewer correctly follows that contract and returns "upheld", the
  // existing resolution table does not manufacture a violation on its own.
  const mockedVerdict = "upheld" as const;
  const result = deriveResult({
    finalAction: "guess",
    adjudicator: "incorrect",
    integrity: mockedVerdict,
  });
  assert.equal(result, "racer_incorrect", "IS-IS alone must never produce racer_win_integrity_violation");
});

test("REGRESSION (concede path): the same materiality-driven verdict also governs a concede, unchanged plumbing", () => {
  assert.equal(
    deriveResult({ finalAction: "concede", adjudicator: null, integrity: "violated" }),
    "racer_win_integrity_violation"
  );
  assert.equal(
    deriveResult({ finalAction: "concede", adjudicator: null, integrity: "upheld" }),
    "composer_win_integrity_upheld"
  );
});
