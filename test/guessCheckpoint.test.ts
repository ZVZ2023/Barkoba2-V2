import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.6.x — the pre-guess checkpoint.
//
// This supersedes the earlier "stage every YES/NO answer" design (commit
// a309a3e / test/answerConfirmation.test.ts, now removed). That design staged
// EVERY answer, which was reverted: single-tap YES/NO is back for ordinary
// questions. Instead, exactly one moment is gated — the answer that produces
// the Racer's final guess. The turn route computes and stores that guess in
// the same call that records the triggering answer, so by the time the
// client has it, it already exists in `game`. GameClient.tsx withholds it
// from the transcript and never calls /resolve until the Composer has
// confirmed (or corrected) that one answer. See docs/DESIGN-NOTES.md §48 and
// lib/rewind.ts's own tests for the server-side half.
//
// No rendering harness exists in this codebase for React components, so this
// proves the wiring from source, the same convention composerAuthority.test.ts
// and (the now-removed) answerConfirmation.test.ts used.
// ---------------------------------------------------------------------------

const GC = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
const CORRECT_ROUTE = readFileSync("app/api/game/[id]/correct/route.ts", "utf8");

test("the staged-every-answer design is fully gone: no stagedAnswer anywhere", () => {
  assert.doesNotMatch(GC, /stagedAnswer/);
});

test("YES/NO are single-tap again — sendTurn fires directly, exactly as before a309a3e", () => {
  assert.match(GC, /onClick=\{\(\) => void sendTurn\("YES"\)\}/);
  assert.match(GC, /onClick=\{\(\) => void sendTurn\("NO"\)\}/);
});

test("pendingGuessCheckpoint only opens on an unrevealed final guess", () => {
  const fn = GC.slice(
    GC.indexOf("function pendingGuessCheckpoint"),
    GC.indexOf("export default function GameClient")
  );
  assert.match(fn, /if \(game\.phase !== "resolving"\) return null;/);
  assert.match(fn, /guessEntry\.turn_type !== "guess"\) return null;/);
  // It must also require a genuine answered question directly beneath the
  // guess — not any arbitrary prior turn.
  assert.match(fn, /answeredEntry\.turn_type !== "question"/);
  assert.match(fn, /answeredEntry\.composer_response === null/);
});

test("the guess itself is withheld from the transcript while unconfirmed", () => {
  assert.match(
    GC,
    /const turns = answeredTurns\(game\)\.filter\(\s*\(e\) => !\(guessRevealPending && e\.id === guessCheckpoint!\.guessEntry\.id\)\s*\);/
  );
});

test("auto-resolve does not fire while a guess is pending reveal", () => {
  const effectStart = GC.indexOf("if (resolveFired.current) return;");
  const effectEnd = GC.indexOf("[game.phase, guessRevealPending, resolveGame]");
  assert.ok(effectStart >= 0 && effectEnd > effectStart, "the auto-resolve effect must exist and depend on guessRevealPending");
  const effect = GC.slice(effectStart, effectEnd);
  assert.match(effect, /if \(guessRevealPending\) return;/);
});

test("the checkpoint's own confirm button is the only thing that reveals the guess", () => {
  const block = GC.slice(GC.indexOf("{guessRevealPending && ("), GC.indexOf("{pending && pending.question_text"));
  assert.match(block, /onClick=\{\(\) => setGuessConfirmed\(true\)\}/);
  // It shows the player their own last answer, never the AI's guess text —
  // there is no reference to guess_text anywhere in this block.
  assert.doesNotMatch(block, /guess_text/);
});

test("the confirm button is disabled while a correction is open, so a stray click cannot race an edit", () => {
  const block = GC.slice(GC.indexOf("{guessRevealPending && ("), GC.indexOf("{pending && pending.question_text"));
  assert.match(block, /disabled=\{busy \|\| correcting !== null\}/);
});

test("the ordinary correction UI is reused for the checkpoint's one answer, not reinvented", () => {
  assert.match(
    GC,
    /guessRevealPending && guessCheckpoint!\.answeredEntry\.turn_index === entry\.turn_index/
  );
});

test("the evaluation spinner does not appear until the checkpoint has actually been confirmed", () => {
  assert.match(GC, /\{game\.phase === "resolving" && !guessRevealPending && \(/);
});

test("AMBIGUOUS is untouched: still an explicit send, still cancelable, never auto-submitted", () => {
  assert.match(GC, /onClick=\{\(\) => void sendTurn\("AMBIGUOUS", explanation\)\}/);
  assert.match(GC, /IS-IS küldése/);
});

test("nothing outside this component's own state changed: no credits or question-budget files touched", () => {
  for (const file of ["lib/entitlements.ts", "lib/questionBudget.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.equal(
      /guessCheckpoint|guessConfirmed|guessRevealPending/.test(src),
      false,
      `${file} must be unrelated to the pre-guess checkpoint UI change`
    );
  }
});

// ---------------------------------------------------------------------------
// The server-side half: /correct must open for exactly this one case and no
// other. lib/rewind.ts's own tests cover isPreGuessCheckpointCorrection's
// logic in isolation; these confirm the route actually wires it in.
// ---------------------------------------------------------------------------

test("the correct route imports and consults isPreGuessCheckpointCorrection", () => {
  assert.match(CORRECT_ROUTE, /isPreGuessCheckpointCorrection/);
  assert.match(
    CORRECT_ROUTE,
    /game\.phase !== "questioning" &&\s*!\(typeof turnIndex === "number" && isPreGuessCheckpointCorrection\(game, turnIndex\)\)/
  );
});

test("the body is parsed before the phase gate, so the exception can see turn_index", () => {
  const bodyAt = CORRECT_ROUTE.indexOf("let body: CorrectBody;");
  const gateAt = CORRECT_ROUTE.indexOf("isPreGuessCheckpointCorrection(game, turnIndex)");
  assert.ok(bodyAt >= 0 && gateAt > bodyAt, "body must be parsed before the gate reads turn_index from it");
});

test("every other validation the route already did is still present, in order", () => {
  const missingAt = CORRECT_ROUTE.indexOf('"missing_turn_index"');
  const invalidAnswerAt = CORRECT_ROUTE.indexOf('"invalid_answer"');
  const staleAt = CORRECT_ROUTE.indexOf('"stale_state"');
  const noSuchTurnAt = CORRECT_ROUTE.indexOf('"no_such_turn"');
  const notCorrectableAt = CORRECT_ROUTE.indexOf('"not_correctable"');
  assert.ok(missingAt >= 0);
  assert.ok(invalidAnswerAt > missingAt);
  assert.ok(staleAt > invalidAnswerAt);
  assert.ok(noSuchTurnAt > staleAt);
  assert.ok(notCorrectableAt > noSuchTurnAt);
});
