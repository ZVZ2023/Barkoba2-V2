import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.9.2.3 PRODUCTION FIX — reported symptom: "clicked 'Nincs meg a kódod?
// Kérj linket e-mailben' three times, no visible change, no email received."
//
// Traced (see RecoverPrompt.tsx's own header for the full account): that
// control's onClick has only ever been a local setMode("email") toggle — it
// has never itself called fetch. POST /api/account/recovery-request is only
// reached one step later, from the separate "Link küldése" button. So "no
// email" is fully explained by "no request was ever sent" for a caller who
// only clicked the toggle — not by an email-delivery failure. These are
// SOURCE-CONTRACT tests (no rendering harness exists in this codebase for
// client components, per the established convention already used for
// EvaluationState.tsx and others), proving: (1) the toggle itself still
// never sends a request, by design, so the fix is not a regression risk
// there; (2) the email step now autofocuses on appearance, making the mode
// switch unmistakable; (3) the submit button now shows busy-state progress;
// (4) the enumeration-safe "always the same generic outcome" contract on
// both the client and app/api/account/recovery-request/route.ts is
// completely unchanged.
// ---------------------------------------------------------------------------

const RECOVER_PROMPT_SRC = readFileSync("app/components/RecoverPrompt.tsx", "utf8");
const RECOVERY_REQUEST_ROUTE_SRC = readFileSync(
  "app/api/account/recovery-request/route.ts",
  "utf8"
);

test("SOURCE: the 'Kérj linket e-mailben' toggle is a pure mode switch -- it has never called fetch, confirming no request was ever sent by that click alone", () => {
  const toggleAt = RECOVER_PROMPT_SRC.indexOf('Nincs meg a kódod? Kérj linket e-mailben');
  assert.ok(toggleAt > 0, "the reported control's own label must still exist");
  const onClickAt = RECOVER_PROMPT_SRC.lastIndexOf("onClick={() => {", toggleAt);
  assert.ok(onClickAt > 0 && onClickAt < toggleAt);
  const handlerBlock = RECOVER_PROMPT_SRC.slice(onClickAt, toggleAt);
  assert.match(handlerBlock, /setMode\("email"\)/, "the toggle must still only switch local mode");
  assert.doesNotMatch(handlerBlock, /fetch\(/, "the toggle must never itself send a network request");
});

test("SOURCE: the email-entry step autofocuses its input the moment it appears, so the mode switch is unmistakable", () => {
  const emailModeAt = RECOVER_PROMPT_SRC.indexOf('if (mode === "email")');
  assert.ok(emailModeAt > 0);
  const emailInputAt = RECOVER_PROMPT_SRC.indexOf('type="email"', emailModeAt);
  assert.ok(emailInputAt > emailModeAt, "the email step's own input must exist inside the email-mode branch");
  const inputTagEnd = RECOVER_PROMPT_SRC.indexOf("/>", emailInputAt);
  const inputTag = RECOVER_PROMPT_SRC.slice(emailInputAt, inputTagEnd);
  assert.match(inputTag, /autoFocus/, "the email input must autofocus on mount");
});

test("SOURCE: the code-mode recovery input is unaffected -- autoFocus was added ONLY to the email step, not the pre-existing code path", () => {
  const codeModeReturnAt = RECOVER_PROMPT_SRC.lastIndexOf(
    "Írd be a belépési/helyreállító kódodat."
  );
  assert.ok(codeModeReturnAt > 0);
  const codeInputAt = RECOVER_PROMPT_SRC.indexOf("<input", codeModeReturnAt);
  const codeInputTagEnd = RECOVER_PROMPT_SRC.indexOf("/>", codeInputAt);
  const codeInputTag = RECOVER_PROMPT_SRC.slice(codeInputAt, codeInputTagEnd);
  assert.doesNotMatch(codeInputTag, /autoFocus/, "the pre-existing code-recovery input must be untouched");
});

test("SOURCE: the 'Link küldése' submit button shows busy-state progress text while the request is in flight", () => {
  const buttonAt = RECOVER_PROMPT_SRC.indexOf("onClick={() => void requestEmailLink()}");
  assert.ok(buttonAt > 0);
  const buttonBlockEnd = RECOVER_PROMPT_SRC.indexOf("</button>", buttonAt);
  const buttonBlock = RECOVER_PROMPT_SRC.slice(buttonAt, buttonBlockEnd);
  assert.match(
    buttonBlock,
    /\{emailBusy \? "[^"]+" : "Link küldése"\}/,
    "the button's own label must change while emailBusy is true, not just its disabled state"
  );
});

test("SOURCE: requestEmailLink still resolves to the SAME generic outcome regardless of the server's response -- the enumeration-safe contract is unchanged by this fix", () => {
  const fnAt = RECOVER_PROMPT_SRC.indexOf("async function requestEmailLink()");
  assert.ok(fnAt > 0);
  const fnEnd = RECOVER_PROMPT_SRC.indexOf("\n  }\n", fnAt);
  const fnBody = RECOVER_PROMPT_SRC.slice(fnAt, fnEnd);
  assert.match(fnBody, /fetch\("\/api\/account\/recovery-request"/);
  assert.match(fnBody, /setEmailSent\(true\)/);
  assert.doesNotMatch(
    fnBody,
    /res\.ok|res\.status|await res\.json/,
    "the client must still never branch on the response body/status -- only a genuine network exception may differ from success"
  );
});

test("SOURCE: app/api/account/recovery-request/route.ts's response contract (rate limits, no-enumeration) is completely untouched by this client-only fix", () => {
  assert.match(
    RECOVERY_REQUEST_ROUTE_SRC,
    /NO EMAIL ENUMERATION, BY CONSTRUCTION, AND NO RATE-LIMIT ORACLE EITHER\./
  );
  assert.match(RECOVERY_REQUEST_ROUTE_SRC, /checkRecoveryEmailRateLimit\(ip\)/);
  assert.match(RECOVERY_REQUEST_ROUTE_SRC, /checkRecoveryEmailTargetRateLimit\(email\)/);
});
