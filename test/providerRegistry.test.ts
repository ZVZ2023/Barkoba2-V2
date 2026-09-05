import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_RACER_PROVIDER,
  getAdapter,
  isModelProviderId,
} from "../lib/providers";
import { anthropicAdapter } from "../lib/providers/anthropic";

// ---------------------------------------------------------------------------
// V2.5-B2 — the provider boundary.
//
// B2 registers exactly one provider, so there is no behaviour here to compare.
// What these tests pin is the SHAPE the boundary must keep when B3 adds a
// second one — specifically the two rules that stop a multi-provider corpus
// from quietly becoming unreadable:
//
//   1. An unknown provider FAILS. It never falls back. A game believed to have
//      been played by one provider but actually played by another is evidence
//      that looks like data and is not.
//   2. The provider name recorded as evidence is the adapter's own id, so the
//      transport that made a call and the row describing who made it cannot
//      drift apart.
// ---------------------------------------------------------------------------

test("the registry resolves anthropic to the anthropic adapter", () => {
  assert.equal(getAdapter("anthropic"), anthropicAdapter);
  assert.equal(getAdapter("anthropic").id, "anthropic");
});

test("the default racer provider is anthropic — the behaviour of every recorded game", () => {
  assert.equal(DEFAULT_RACER_PROVIDER, "anthropic");
  assert.equal(getAdapter(DEFAULT_RACER_PROVIDER).id, "anthropic");
});

test("an unknown provider throws instead of silently falling back", () => {
  // Cast because the union does not admit it — which is the point. The type
  // system stops this at compile time; this asserts the runtime does too, for
  // the path where the id arrives from a request body or a stored record.
  assert.throws(
    () => getAdapter("mistral" as never),
    /Unknown model provider/,
    "an unregistered provider must fail loudly"
  );
  assert.throws(() => getAdapter("gemini" as never), /Unknown model provider/);
  // Prototype-chain keys must throw too. A truthiness check on REGISTRY[id]
  // would hand back Object.prototype.constructor here — a function, therefore
  // truthy, therefore returned as if it were a provider. In B3 this id comes
  // from a request body.
  assert.throws(() => getAdapter("constructor" as never), /Unknown model provider/);
  assert.throws(() => getAdapter("toString" as never), /Unknown model provider/);
});

test("isModelProviderId accepts only registered providers", () => {
  assert.equal(isModelProviderId("anthropic"), true);
  // Registered in B3, together with lib/providers/xai.ts.
  assert.equal(isModelProviderId("xai"), true);
  // Registered in V2.8.7, together with lib/providers/openai.ts.
  assert.equal(isModelProviderId("openai"), true);
  assert.equal(isModelProviderId("gemini"), false);
  assert.equal(isModelProviderId(""), false);
  assert.equal(isModelProviderId(null), false);
  assert.equal(isModelProviderId(42), false);
  // Prototype keys are not providers. `getAdapter` indexes a plain object, so
  // without hasOwnProperty a body of {"racer_provider":"constructor"} would
  // pass validation and hand back a function.
  assert.equal(isModelProviderId("constructor"), false);
  assert.equal(isModelProviderId("toString"), false);
});

// ---------------------------------------------------------------------------
// The rule the boundary exists to protect.
// ---------------------------------------------------------------------------

test("the Racer seat routes through the registry, not a hard-wired client", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  assert.match(src, /getAdapter\(/, "the Racer must resolve its transport");
  assert.doesNotMatch(
    src,
    /import .*callAnthropicTool/,
    "the Racer must not import a vendor client directly"
  );
  // Provenance takes the provider from the adapter that made the call.
  assert.match(src, /model_provider: adapter\.id/);
});

test("the eight out-of-scope call sites still import the Anthropic client unchanged", () => {
  // B2 must not have touched the referees or the AI Composer. They stay on
  // Anthropic permanently: they are the measuring instrument, and the Composer
  // path is additionally a permitted secret call site, which is what keeps the
  // target from ever reaching a second vendor.
  for (const path of [
    "lib/prompts/validator.ts",
    "lib/prompts/adjudicator.ts",
    "lib/prompts/integrityReview.ts",
    "lib/prompts/composerTarget.ts",
    "lib/prompts/composerAnswer.ts",
    "lib/prompts/questionEdit.ts",
  ]) {
    assert.match(
      readFileSync(path, "utf8"),
      /from "\.\.\/anthropic"/,
      `${path} should still import the compatibility re-export`
    );
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /getAdapter/,
      `${path} is not a player seat and must not select a provider`
    );
  }
});

test("adapters are quarantined from the secret store", () => {
  const iso = readFileSync("scripts/check-isolation.mjs", "utf8");
  const quarantined = iso.slice(iso.indexOf("const QUARANTINED"));
  for (const mod of [
    "lib/providers/index.ts",
    "lib/providers/types.ts",
    "lib/providers/anthropic.ts",
    "lib/anthropic.ts",
  ]) {
    assert.ok(
      quarantined.includes(`"${mod}"`),
      `${mod} must be quarantined — it carries Racer input to an external endpoint`
    );
  }

  // The allowlist did not grow. A transport is never a permitted secret reader.
  const permitted = iso.slice(
    iso.indexOf("const PERMITTED_SECRET_IMPORTERS"),
    iso.indexOf("const QUARANTINED")
  );
  assert.doesNotMatch(permitted, /providers/);
});
