import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.6.x — an answer must be explicitly confirmed before the Racer ever sees
// it. Before this, GameClient.tsx's YES/NO buttons called sendTurn() (which
// synchronously triggers the AI Racer's next question or guess) on the very
// first tap — no staging, no chance to change an answer before the Racer
// acted on it. This replaces a since-rejected design where the Racer's
// response would be shown BEFORE the Composer finalized their answer, which
// would let the Composer see the outcome before locking in — an integrity
// risk, not merely a UX one. AMBIGUOUS already had a reveal-then-send shape
// via ambiguousMode; this gives YES/NO the same shape instead of inventing a
// different one.
//
// No rendering harness exists in this codebase for React components (every
// other UI-adjacent test file in this suite is structural), so this proves
// the wiring from source, the same convention composerAuthority.test.ts and
// playCreditVisibility.test.ts already use.
// ---------------------------------------------------------------------------

const SRC = readFileSync("app/game/[id]/GameClient.tsx", "utf8");

test("a staged-answer state exists, separate from ambiguousMode", () => {
  assert.match(SRC, /const \[stagedAnswer, setStagedAnswer\] = useState<"YES" \| "NO" \| null>\(null\)/);
});

test("tapping YES or NO stages the answer — neither calls sendTurn directly", () => {
  // The specific failure this guards against: `onClick={() => void sendTurn("YES")}`
  // sitting directly on the first-tap button, which is exactly what let the
  // Racer act on an answer the player had not yet confirmed.
  assert.doesNotMatch(
    SRC,
    /onClick=\{\(\) => void sendTurn\("YES"\)\}/,
    "YES must stage an answer, not submit one, on first tap"
  );
  assert.doesNotMatch(
    SRC,
    /onClick=\{\(\) => void sendTurn\("NO"\)\}/,
    "NO must stage an answer, not submit one, on first tap"
  );
  assert.match(SRC, /onClick=\{\(\) => setStagedAnswer\("YES"\)\}/);
  assert.match(SRC, /onClick=\{\(\) => setStagedAnswer\("NO"\)\}/);
});

test("a staged answer renders its own confirm view, gated ahead of the selector", () => {
  // stagedAnswer must be checked BEFORE ambiguousMode in the same ternary
  // chain, so a staged YES/NO cannot be silently bypassed by falling through
  // to the three-button selector or the AMBIGUOUS explanation view.
  const pendingBlock = SRC.slice(
    SRC.indexOf("{pending && pending.question_text && ("),
    SRC.indexOf("{busy && pending &&")
  );
  const stagedAt = pendingBlock.indexOf("{stagedAnswer ? (");
  const ambiguousAt = pendingBlock.indexOf(": !ambiguousMode ? (");
  assert.ok(stagedAt >= 0, "the staged-answer branch must exist");
  assert.ok(ambiguousAt > stagedAt, "stagedAnswer must be checked first, ahead of ambiguousMode");
});

test("only the explicit confirm button submits the staged answer to the Racer", () => {
  assert.match(
    SRC,
    /onClick=\{\(\) => void sendTurn\(stagedAnswer\)\}/,
    "confirming must send exactly the staged answer, not a hardcoded one"
  );
  // The confirm button's own label names which answer is about to go out —
  // never a generic "Send", so the player is reading back what they chose.
  assert.match(SRC, /\{ANSWER_HU\[stagedAnswer\]\} küldése/);
});

test("the staged view offers a way back that does NOT submit anything", () => {
  const stagedBlock = SRC.slice(
    SRC.indexOf("{stagedAnswer ? ("),
    SRC.indexOf(") : !ambiguousMode ? (")
  );
  assert.match(stagedBlock, /onClick=\{\(\) => setStagedAnswer\(null\)\}/);
  assert.doesNotMatch(
    stagedBlock.slice(stagedBlock.indexOf("Mégsem") - 200, stagedBlock.indexOf("Mégsem")),
    /sendTurn/,
    "the cancel path must not call sendTurn"
  );
});

test("sendTurn resets the staged answer on every attempt, success or failure", () => {
  const fn = SRC.slice(SRC.indexOf("const sendTurn = useCallback"), SRC.indexOf("const retryTurn"));
  const finallyBlock = fn.slice(fn.lastIndexOf("} finally {"));
  assert.match(finallyBlock, /setStagedAnswer\(null\)/);
});

test("the AMBIGUOUS path is untouched: still an explicit send, still cancelable, never auto-submitted", () => {
  assert.match(SRC, /onClick=\{\(\) => void sendTurn\("AMBIGUOUS", explanation\)\}/);
  assert.match(SRC, /IS-IS küldése/);
});

test("nothing outside this component's own state changed: no credits, budget, or adjudication files touched", () => {
  for (const file of [
    "lib/entitlements.ts",
    "lib/questionBudget.ts",
    "lib/resolveResult.ts",
    "app/api/game/[id]/turn/route.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.equal(
      /stagedAnswer/.test(src),
      false,
      `${file} must be unrelated to the confirm-before-send UI change`
    );
  }
});
