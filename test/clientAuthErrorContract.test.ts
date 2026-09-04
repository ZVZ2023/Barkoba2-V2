import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.8.6 R1 COMMIT 2 — the client application-error contract, applied to
// GameClient.tsx, RacerClient.tsx and HumanClient.tsx.
//
// No jsdom/testing-library dependency exists in this project (see
// test/turnRequestGuard.test.ts's own module doc), so these are SOURCE
// assertions, the same idiom test/avatarHeader.test.ts and
// test/composerAuthority.test.ts already use for these exact files — a
// weaker claim than an executed test, said plainly rather than implied.
//
// V2.8.6 R2 — RacerClient.tsx's /ask handler (send) was rebuilt on
// runOwnedTurnRequest (see lib/turnRequestGuard.ts and
// test/turnRequestGuard.test.ts, which prove that module's own behavior
// directly). It now DOES require `game` on the primary response and DOES
// reconcile through /view on an uncertain transport failure — the opposite
// of this file's original R1-era assertion, which recorded what was true
// only because /ask itself had no reliability contract yet. Updated here,
// not merely left broken, because the OLD assertion is now describing a
// defect (an unbounded, unrecoverable request) rather than a safe minimal
// surface.
// ---------------------------------------------------------------------------

const GAME_CLIENT = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
const RACER_CLIENT = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");
const HUMAN_CLIENT = readFileSync("app/game/[id]/HumanClient.tsx", "utf8");

test("RacerClient's /ask handler (send) is built on runOwnedTurnRequest and reconciles through /view", () => {
  const sendFn = RACER_CLIENT.slice(
    RACER_CLIENT.indexOf("const send = useCallback("),
    RACER_CLIENT.indexOf("// V2.8.6 R2 — foreground reconciliation")
  );
  assert.match(sendFn, /runOwnedTurnRequest\(/, "must go through the shared ownership/reconciliation module");
  assert.match(sendFn, /expected_revision: gameRef\.current\.revision/, "the My Car Key revision must ride along on every /ask call");
  assert.match(sendFn, /requestView: async \(\) =>/, "must supply a canonical /view read for reconciliation");
});

test("RacerClient's /clue handler (askForClue) never requires `game` and never reconciles/issues /view", () => {
  // V2.8.6 R2 Commit 1 scope — askForClue itself is untouched here (its own
  // reliability wrapping is Commit 2's job, alongside /clue's own server
  // change); this still records its CURRENT, unchanged shape. Bounded-length
  // slice (matching the /correct assertion below) rather than "up to the
  // next declaration", since the new doc comment directly above `send`
  // mentions /view and would otherwise leak into a between-declarations slice.
  const clueFn = RACER_CLIENT.slice(
    RACER_CLIENT.indexOf("const askForClue = useCallback("),
    RACER_CLIENT.indexOf("const askForClue = useCallback(") + 500
  );
  assert.match(clueFn, /if \(data\.game\) setGame\(data\.game as GameRecord\)/);
  assert.match(clueFn, /if \(!res\.ok\) setError\(data\.message/);
  assert.doesNotMatch(clueFn, /\/view/);
});

test("GameClient's /correct handler never requires `game` and never reconciles/issues /view", () => {
  const correctFn = GAME_CLIENT.slice(
    GAME_CLIENT.indexOf("const correctAnswer = useCallback("),
    GAME_CLIENT.indexOf("const correctAnswer = useCallback(") + 1500
  );
  assert.match(correctFn, /if \(data\.game\) setGame\(data\.game as GameRecord\)/);
  assert.match(correctFn, /if \(!res\.ok\) setError\(data\.message/);
  assert.doesNotMatch(correctFn, /await fetch\(`\/api\/game\/\$\{game\.game_id\}\/view/, "must never issue a reconciliation read");
});

test("HumanClient's /view poll (refresh) recognizes documented auth errors and surfaces the safe message", () => {
  const refreshFn = HUMAN_CLIENT.slice(
    HUMAN_CLIENT.indexOf("const refresh = useCallback("),
    HUMAN_CLIENT.indexOf("// One fetch on mount")
  );
  assert.match(HUMAN_CLIENT, /import \{ isAuthApplicationError \} from "@\/lib\/turnRequestGuard"/);
  assert.match(refreshFn, /isAuthApplicationError\(data\.error\)/, "a documented auth error must be recognized explicitly");
  assert.match(refreshFn, /setError\(data\.message/, "the safe server message must be surfaced for a documented error");
});

test("HumanClient's /view poll still silently discards a genuine transient/malformed failure (unchanged for the unknown case)", () => {
  const refreshFn = HUMAN_CLIENT.slice(
    HUMAN_CLIENT.indexOf("const refresh = useCallback("),
    HUMAN_CLIENT.indexOf("// One fetch on mount")
  );
  // The catch block (genuine fetch/parse failure) stays a no-op comment,
  // and an unrecognized non-ok response falls through the isAuthApplicationError
  // branch to a plain `return` with no setError call for that path.
  assert.match(refreshFn, /catch \{[\s\S]*A dropped poll is not an error/);
});
