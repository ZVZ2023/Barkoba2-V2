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
//
// V2.7.0 human-test fix — ResultPanel.tsx and RacerClient.tsx no longer
// embed <ClaimPrompt /> at all (replaced by the much smaller
// PostGameRegisterCTA, which links to the dedicated /register page). That
// makes hideAccountManagement moot for those two files specifically — there
// is no account management there to suppress any more — but the prop itself
// is unchanged and still gates ClaimPrompt's "protected" branch everywhere
// ClaimPrompt IS still embedded (the /register page, via postGameOffer).
// The tests below were updated to check the stronger, current invariant
// rather than deleted, since "no registration/account mechanics on the
// result page" is exactly what this file exists to pin.
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
    /export default function ClaimPrompt\(\{ hideAccountManagement = false, postGameOffer = false \}: Props = \{\}\)/
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

  // "existing" and "pending_verification" are explicit `if (state.step ===
  // ...)` branches; "offer" is the unconditional fallback after them — all
  // three must survive.
  for (const otherBranch of ['"existing"', '"pending_verification"']) {
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
    "the flag must not gate the offer/existing/pending_verification branches, or the loading state"
  );
});

test("both finished-game result screens embed no registration/account mechanics at all", () => {
  // V2.7.0 human-test fix — stronger than the old hideAccountManagement
  // suppression: the result screens no longer render ClaimPrompt (or any of
  // its offer/existing/pending_verification/protected branches) in any form.
  // They render only the small teaser CTA, which links to /register instead.
  assert.doesNotMatch(RESULT_PANEL, /ClaimPrompt/);
  assert.doesNotMatch(RACER_CLIENT, /ClaimPrompt/);
  assert.match(RESULT_PANEL, /<PostGameRegisterCTA \/>/);
  assert.match(RACER_CLIENT, /<PostGameRegisterCTA \/>/);

  // The dedicated page is where the real (still shared, still reused)
  // registration experience actually lives.
  const registerClient = readFileSync("app/register/RegisterClient.tsx", "utf8");
  assert.match(registerClient, /<ClaimPrompt postGameOffer \/>/);
});

test("the pending-verification screen exposes no recovery/profile/account mechanics", () => {
  // V2.7.0 human-test fix — the newcomer journey requirement that motivated
  // this whole file's original fix now applies to a second moment too: right
  // after submitting name+email, not just on the result screen. Isolate the
  // pending_verification branch and prove it carries none of the things a
  // newcomer must not see yet.
  const start = CLAIM_PROMPT.indexOf('if (state.step === "pending_verification")');
  const end = CLAIM_PROMPT.indexOf('if (state.step === "protected")');
  const pendingBranch = CLAIM_PROMPT.slice(start, end);
  assert.ok(start >= 0 && end > start, "pending_verification branch must exist");

  for (const forbidden of [
    /kód/i, // recovery code, in any Hungarian phrasing (kódot, kódod, ...)
    /ProfilePhotoPrompt/,
    /AccountProfile/,
    /jelszó/i, // password
    /cookie/i,
    /player_id|playerId/,
  ]) {
    assert.doesNotMatch(pendingBranch, forbidden, `pending_verification leaks ${forbidden}`);
  }

  // What it SHOULD say: email sent, check inbox, watch the video slot.
  assert.match(pendingBranch, /Elküldtük a megerősítő e-mailt/);
  assert.match(pendingBranch, /WelcomeVideoSlot/);
});

test("the 'wrong email address' correction affordance exists ONLY in pending_verification, never in protected", () => {
  // V2.7.x — the correction UI must be reachable exactly where the trapped
  // newcomer actually is, and nowhere the already-verified/logged-in Profil
  // surface would make it a confusing second, redundant email field.
  const pendingStart = CLAIM_PROMPT.indexOf('if (state.step === "pending_verification")');
  const pendingEnd = CLAIM_PROMPT.indexOf('if (state.step === "protected")');
  const pendingBranch = CLAIM_PROMPT.slice(pendingStart, pendingEnd);
  assert.match(pendingBranch, /Rossz e-mail-cím\?/);
  // The fetch call itself lives in the correctEmail() callback, defined
  // earlier in the component body (outside this render-only slice) — same
  // convention as register()/rotateRecoveryCode() — so checked against the
  // whole file instead of this slice.
  assert.match(CLAIM_PROMPT, /fetch\("\/api\/account\/email"/);

  const protectedStart = pendingEnd;
  const protectedEnd = CLAIM_PROMPT.indexOf('if (state.step === "existing")');
  const protectedBranch = CLAIM_PROMPT.slice(protectedStart, protectedEnd);
  assert.doesNotMatch(protectedBranch, /Rossz e-mail-cím\?/);

  // The offer/existing branches, and anything before the loading guard,
  // must not carry it either — it is not a general-purpose affordance.
  const renderBody = CLAIM_PROMPT.slice(CLAIM_PROMPT.indexOf('if (state.step === "loading")'));
  const outsidePending = renderBody.replace(pendingBranch, "");
  assert.doesNotMatch(outsidePending, /Rossz e-mail-cím\?/);
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

// ---------------------------------------------------------------------------
// V2.7.0.16 — a verified account that spends its final Play Credit used to
// see NOTHING on the result screen: PostGameRegisterCTA only ever had
// "offer" (register) or "hidden". The result screen has no other purchase
// entry point, so the newcomer's actual next step — buy more — had no CTA
// anywhere at the exact moment they discovered they were out.
// ---------------------------------------------------------------------------

const POST_GAME_CTA = readFileSync("app/components/PostGameRegisterCTA.tsx", "utf8");

test("the result-screen CTA offers PURCHASE, not registration, to a verified account at exhausted play_state", () => {
  assert.match(POST_GAME_CTA, /fetch\("\/api\/account\/profile"/);
  assert.match(POST_GAME_CTA, /profile\.email_verified/);
  assert.match(POST_GAME_CTA, /fetch\("\/api\/player\/entitlement"/);
  assert.match(POST_GAME_CTA, /entitlement\.play_state === "exhausted" \? "purchase" : "hidden"/);
  assert.match(POST_GAME_CTA, /state === "purchase"/);
  assert.match(POST_GAME_CTA, /href="\/purchase"/);
});

test("the decision is NOT balance-alone — verification is checked before play_state is ever consulted", () => {
  // resolvePlayState() collapses to "exhausted" for BOTH a verified account
  // that used all 5 AND an unverified/never-registered guest that used
  // their one anonymous game (see lib/entitlements.ts — it has no
  // verification concept). Distinguishing "offer purchase" from "offer
  // registration" REQUIRES the account's current verification state, read
  // fresh, ahead of any balance/play_state check.
  const profileCheck = POST_GAME_CTA.indexOf("profile.email_verified");
  const entitlementFetch = POST_GAME_CTA.indexOf('fetch("/api/player/entitlement"');
  assert.ok(profileCheck > 0 && entitlementFetch > profileCheck);
});

test("an unverified (but already registered) account sees neither CTA", () => {
  // Cannot purchase (see /api/entitlement/intent's own verified-email gate),
  // and already has an account, so re-offering registration is also wrong.
  const unverifiedBranch = POST_GAME_CTA.slice(
    POST_GAME_CTA.indexOf("if (!profile.email_verified)"),
    POST_GAME_CTA.indexOf("const entitlementRes")
  );
  assert.match(unverifiedBranch, /setState\("hidden"\)/);
  assert.doesNotMatch(unverifiedBranch, /setState\("offer"\)|setState\("purchase"\)/);
});

test("a true guest or session-less device is unaffected — still goes through the original register/hidden check", () => {
  // The 401 branch (not an authenticated account session) is byte-identical
  // in intent to the pre-2.7.0.16 behavior: reuses GET /api/account/register
  // and its own registered boolean, never touches /api/player/entitlement.
  const guestBranch = POST_GAME_CTA.slice(
    POST_GAME_CTA.indexOf("profileRes.status === 401"),
    POST_GAME_CTA.indexOf("if (!profileRes.ok)")
  );
  assert.match(guestBranch, /fetch\("\/api\/account\/register"\)/);
  assert.match(guestBranch, /registerData\.registered \? "hidden" : "offer"/);
  assert.doesNotMatch(guestBranch, /entitlement/);
});
