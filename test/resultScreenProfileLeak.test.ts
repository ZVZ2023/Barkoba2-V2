import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.6.x — the account/profile block (email input, photo upload,
// recovery-code rotation — ClaimPrompt's "protected" branch, which renders
// AccountProfile) was leaking onto both finished-game result screens because
// ResultPanel.tsx and RacerClient.tsx embed the same shared <ClaimPrompt />
// used by the header's "Profil" button (AccountControl.tsx). An already
// -authenticated player has nothing to do in that branch — registration and
// recovery are already done — so it was standing profile management with no
// connection to the game that just ended, duplicating the header exactly.
//
// The fix is a single opt-in prop, hideAccountManagement, checked ONLY inside
// ClaimPrompt's "protected" branch. offer/existing/code — the branches a
// player who just finished a game may legitimately need — are unconditional
// in every caller, on every surface, unchanged.
//
// No rendering harness exists in this codebase for React components, so this
// proves the wiring from source, matching the convention already used by
// composerAuthority.test.ts and guessCheckpoint.test.ts.
// ---------------------------------------------------------------------------

const CLAIM_PROMPT = readFileSync("app/components/ClaimPrompt.tsx", "utf8");
const RESULT_PANEL = readFileSync("app/game/[id]/ResultPanel.tsx", "utf8");
const RACER_CLIENT = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");
const ACCOUNT_CONTROL = readFileSync("app/components/AccountControl.tsx", "utf8");
const ENTITLEMENT = readFileSync("app/components/Entitlement.tsx", "utf8");

test("ClaimPrompt accepts an opt-in hideAccountManagement prop, default false", () => {
  assert.match(CLAIM_PROMPT, /hideAccountManagement\?: boolean/);
  assert.match(
    CLAIM_PROMPT,
    /export default function ClaimPrompt\(\{ hideAccountManagement = false \}: Props = \{\}\)/
  );
});

test("only the protected (already-authenticated) branch checks the flag", () => {
  const protectedBranch = CLAIM_PROMPT.slice(
    CLAIM_PROMPT.indexOf('if (state.step === "protected")'),
    CLAIM_PROMPT.indexOf('if (state.step === "existing")')
  );
  assert.match(protectedBranch, /if \(hideAccountManagement\) return null;/);

  // AccountProfile (email + photo) only renders inside the protected branch —
  // confirming the suppression actually reaches the offending content.
  assert.match(protectedBranch, /<AccountProfile \/>/);

  // "existing" and "code" are explicit `if (state.step === ...)` branches;
  // "offer" is the unconditional fallback after them — all three must survive.
  for (const otherBranch of ['"existing"', '"code"']) {
    const at = CLAIM_PROMPT.indexOf(`state.step === ${otherBranch}`);
    assert.ok(at >= 0, `${otherBranch} branch must still exist`);
  }
  assert.match(CLAIM_PROMPT, /Regisztrálsz játékosfiókot\?/, "the offer (fallback) branch must still exist");

  // Only the render body (from the loading-state guard onward) should ever
  // reference the flag, and only inside the protected branch within it.
  const renderBody = CLAIM_PROMPT.slice(CLAIM_PROMPT.indexOf('if (state.step === "loading")'));
  assert.doesNotMatch(
    renderBody.replace(protectedBranch, ""),
    /hideAccountManagement/,
    "the flag must not gate the offer/existing/code branches, or the loading state"
  );
});

test("both finished-game result screens suppress account management", () => {
  assert.match(RESULT_PANEL, /<ClaimPrompt hideAccountManagement \/>/);
  assert.match(RACER_CLIENT, /<ClaimPrompt hideAccountManagement \/>/);
});

test("the header Profil button and the purchase gateway are unaffected — full ClaimPrompt, no suppression", () => {
  assert.match(ACCOUNT_CONTROL, /<ClaimPrompt \/>/);
  assert.doesNotMatch(ACCOUNT_CONTROL, /hideAccountManagement/);
  assert.match(ENTITLEMENT, /<ClaimPrompt \/>/);
  assert.doesNotMatch(ENTITLEMENT, /hideAccountManagement/);
});

test("AccountProfile (email input + photo upload) is reachable from exactly one place outside ClaimPrompt: nowhere — only via the protected branch", () => {
  // Guards against a second copy of the profile block being added directly to
  // either result screen instead of going through ClaimPrompt's own gate.
  assert.doesNotMatch(RESULT_PANEL, /AccountProfile/);
  assert.doesNotMatch(RACER_CLIENT, /AccountProfile/);
});
