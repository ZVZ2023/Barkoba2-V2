import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADJUDICATION_CATEGORIES,
  ADJUDICATION_FIXTURES,
} from "./fixtures/adjudication";

// ---------------------------------------------------------------------------
// HERMETIC. No network, no API key, no cost. These checks protect the fixture
// DATA — the model itself is exercised by `npm run eval:adjudicator`, which is
// deliberately not part of `npm test` or `npm run verify`.
//
// Several assertions below encode the locked adjudication principle directly,
// so that "simplifying" the fixture set into contradicting it fails the build.
// ---------------------------------------------------------------------------

test("fixture ids are unique", () => {
  const ids = ADJUDICATION_FIXTURES.map((f) => f.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate fixture ids: ${dupes.join(", ")}`);
});

test("every category has fixtures", () => {
  for (const category of ADJUDICATION_CATEGORIES) {
    const count = ADJUDICATION_FIXTURES.filter((f) => f.category === category).length;
    assert.ok(count > 0, `category "${category}" has no fixtures — was it dropped?`);
  }
});

test("no fixture uses an unlisted category", () => {
  for (const f of ADJUDICATION_FIXTURES) {
    assert.ok(
      ADJUDICATION_CATEGORIES.includes(f.category),
      `${f.id} uses unlisted category "${f.category}"`
    );
  }
});

test("fixtures are well-formed", () => {
  for (const f of ADJUDICATION_FIXTURES) {
    assert.ok(f.target.trim().length > 0, `${f.id}: empty target`);
    assert.ok(f.clarification.trim().length > 0, `${f.id}: empty clarification`);
    assert.ok(f.language === "en" || f.language === "hu", `${f.id}: bad language`);
    // An empty guess is only meaningful as a degenerate-input case.
    if (f.guess.trim().length === 0) {
      assert.equal(
        f.category,
        "degenerate_guess",
        `${f.id}: empty guess outside degenerate_guess`
      );
    }
  }
});

test("borderline fixtures assert calibration, never a verdict", () => {
  for (const f of ADJUDICATION_FIXTURES) {
    if (f.category === "borderline") {
      assert.equal(
        f.expect,
        null,
        `${f.id}: borderline fixtures must not assert a verdict — there is no ground truth to assert`
      );
      assert.equal(typeof f.maxConfidence, "number", `${f.id}: borderline needs maxConfidence`);
      assert.ok(
        (f.maxConfidence as number) > 0 && (f.maxConfidence as number) <= 1,
        `${f.id}: maxConfidence out of range`
      );
    } else {
      assert.notEqual(f.expect, null, `${f.id}: only borderline fixtures may omit a verdict`);
      assert.equal(
        f.maxConfidence,
        undefined,
        `${f.id}: maxConfidence is meaningful only for borderline fixtures`
      );
    }
  }
});

test("pair references resolve", () => {
  const ids = new Set(ADJUDICATION_FIXTURES.map((f) => f.id));
  for (const f of ADJUDICATION_FIXTURES) {
    if (!f.pair) continue;
    assert.ok(ids.has(f.pair), `${f.id}: pair "${f.pair}" does not exist`);
    const other = ADJUDICATION_FIXTURES.find((x) => x.id === f.pair);
    assert.equal(other?.pair, f.id, `${f.id}: pair with ${f.pair} is not reciprocal`);
  }
});

test("LOCKED RULE: part_vs_whole is always incorrect", () => {
  // Containment is not identity. A guess naming the whole picks out exactly one
  // thing — and still fails, because that thing is not the target. Uniqueness
  // can rescue a broad description; it can never rescue a part/whole mismatch.
  for (const f of ADJUDICATION_FIXTURES.filter((x) => x.category === "part_vs_whole")) {
    assert.equal(
      f.expect,
      "incorrect",
      `${f.id}: part/whole mismatches are never sufficient, regardless of how unambiguous the guess is`
    );
  }
});

test("LOCKED RULE: part_vs_whole is tested in both directions", () => {
  const fixtures = ADJUDICATION_FIXTURES.filter((x) => x.category === "part_vs_whole");
  const notes = fixtures.map((f) => f.note ?? "").join(" ");
  assert.ok(/whole for part/i.test(notes), "no whole-for-part fixture");
  assert.ok(/part for whole/i.test(notes), "no part-for-whole fixture");
});

test("LOCKED RULE: broader_narrower turns on uniqueness, so it must be mixed", () => {
  // If this category ever becomes all-correct or all-incorrect, the uniqueness
  // boundary has stopped being tested and the rule has collapsed into
  // part_vs_whole — which is exactly the simplification the fixture file warns
  // against.
  const fixtures = ADJUDICATION_FIXTURES.filter((x) => x.category === "broader_narrower");
  assert.ok(
    fixtures.some((f) => f.expect === "correct"),
    "broader_narrower has no correct case: uniqueness can rescue a broad description"
  );
  assert.ok(
    fixtures.some((f) => f.expect === "incorrect"),
    "broader_narrower has no incorrect case: non-unique descriptions must fail"
  );
});

test("LOCKED RULE: multi-candidate guesses are always incorrect", () => {
  for (const f of ADJUDICATION_FIXTURES.filter((x) => x.category === "multi_candidate")) {
    assert.equal(f.expect, "incorrect", `${f.id}: one guess means one`);
  }
});

test("category_vs_instance and degenerate_guess are always incorrect", () => {
  for (const f of ADJUDICATION_FIXTURES) {
    if (f.category === "category_vs_instance" || f.category === "degenerate_guess") {
      assert.equal(f.expect, "incorrect", `${f.id} should be incorrect`);
    }
  }
});

test("clarification_decisive fixtures actually isolate the clarification", () => {
  // The whole point of this category: same target, same guess, different
  // clarification, opposite verdicts. If a pair differs in target or guess it
  // proves nothing about the clarification being authoritative.
  const fixtures = ADJUDICATION_FIXTURES.filter(
    (x) => x.category === "clarification_decisive"
  );
  assert.ok(fixtures.length >= 2, "need at least one pair");
  for (const f of fixtures) {
    assert.ok(f.pair, `${f.id}: clarification_decisive fixtures must be paired`);
    const other = ADJUDICATION_FIXTURES.find((x) => x.id === f.pair);
    assert.ok(other, `${f.id}: missing pair`);
    assert.equal(other!.target, f.target, `${f.id}: pair must share the target`);
    assert.equal(other!.guess, f.guess, `${f.id}: pair must share the guess`);
    assert.notEqual(
      other!.clarification,
      f.clarification,
      `${f.id}: pair must differ in clarification`
    );
    assert.notEqual(other!.expect, f.expect, `${f.id}: pair must reach opposite verdicts`);
  }
});

test("LOCKED RULE: inflection guards exist, so orthographic_variant must be mixed", () => {
  // Inflection is identity; derivation from the same root is not. If this
  // category becomes all-correct, the guards have been deleted and "same root"
  // can pass as "same word".
  const fixtures = ADJUDICATION_FIXTURES.filter(
    (x) => x.category === "orthographic_variant"
  );
  assert.ok(
    fixtures.some((f) => f.expect === "correct"),
    "no inflection case: the rule itself is untested"
  );
  assert.ok(
    fixtures.some((f) => f.expect === "incorrect"),
    "no derivation guard: 'same root' could pass as 'same word'"
  );
});

test("Hungarian and cross-language coverage exists", () => {
  assert.ok(
    ADJUDICATION_FIXTURES.some((f) => f.language === "hu"),
    "no Hungarian-language fixtures"
  );
  assert.ok(
    ADJUDICATION_FIXTURES.filter((f) => f.category === "cross_language").length >= 2,
    "cross-language needs both directions"
  );
});

// ---------------------------------------------------------------------------
// Field-order regression guard, added after the same defect appeared twice.
//
// orth-5 was caused by the Adjudicator declaring `verdict` before `reasoning`,
// so the verdict was committed before any analysis existed. The fix was applied
// to the Adjudicator and the identical bug survived untouched in the Integrity
// Review for two more versions, because nothing tested for it.
//
// These assertions read the real exported schemas. A future prompt edit that
// reorders the fields fails the build instead of quietly reintroducing snap
// judgments.
// ---------------------------------------------------------------------------

import { ADJUDICATOR_INPUT_SCHEMA } from "../lib/prompts/adjudicator";
import { INTEGRITY_REVIEW_INPUT_SCHEMA } from "../lib/prompts/integrityReview";

function firstProperty(schema: Record<string, unknown>): string {
  return Object.keys(schema.properties as Record<string, unknown>)[0] ?? "";
}

test("LOCKED: judgment schemas declare reasoning before any verdict field", () => {
  assert.equal(
    firstProperty(ADJUDICATOR_INPUT_SCHEMA),
    "reasoning",
    "Adjudicator must reason before it decides"
  );
  assert.equal(
    firstProperty(INTEGRITY_REVIEW_INPUT_SCHEMA),
    "reasoning",
    "Integrity Review must reason before it accuses"
  );
});

test("LOCKED: required arrays list reasoning first too", () => {
  for (const [name, schema] of [
    ["adjudicator", ADJUDICATOR_INPUT_SCHEMA],
    ["integrityReview", INTEGRITY_REVIEW_INPUT_SCHEMA],
  ] as const) {
    const required = schema.required as string[];
    assert.equal(required[0], "reasoning", `${name}: required order must match property order`);
  }
});
