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

test("RacerClient's /clue handler (askForClue) is built on runOwnedTurnRequest and shares send()'s mutex", () => {
  // V2.8.6 R2 Commit 2 — askForClue was rebuilt alongside /clue's own server
  // reliability change, exactly like send() was for /ask in Commit 1 (see
  // that test's own doc above for why the OLD assertion here is now
  // describing a defect, not a safe minimal surface).
  const clueFn = RACER_CLIENT.slice(
    RACER_CLIENT.indexOf("const askForClue = useCallback("),
    RACER_CLIENT.indexOf("const send = useCallback(")
  );
  assert.match(clueFn, /runOwnedTurnRequest\(/, "must go through the shared ownership/reconciliation module");
  assert.match(clueFn, /requestOwnershipRef\.current as RequestOwnership/, "must share send()'s mutex, not a second independent one");
  assert.match(clueFn, /expected_revision: gameRef\.current\.revision/);
  assert.match(clueFn, /requestView: async \(\) =>/);
});

test("GameClient's /clue handler (sendClue) is built on runOwnedTurnRequest with its own independent ownership stream", () => {
  // V2.8.6 R2 Commit 2 — sendClue gets its OWN ownership/in-flight/active-
  // request trio (clueOwnershipRef), distinct from sendTurn's, mirroring
  // resolveGame's own precedent (a third independent request stream) —
  // safe because the clue-request panel and the pending-question panel are
  // mutually exclusive render branches, so no button can race sendTurn's.
  const clueFn = GAME_CLIENT.slice(
    GAME_CLIENT.indexOf("const sendClue = useCallback("),
    GAME_CLIENT.indexOf("const sendTurn = useCallback(")
  );
  assert.match(clueFn, /runOwnedTurnRequest\(/);
  assert.match(clueFn, /clueOwnershipRef\.current as RequestOwnership/, "must use its own ownership tracker, not sendTurn's");
  assert.match(clueFn, /expected_revision: gameRef\.current\.revision/);
  assert.match(clueFn, /requestView: async \(\) =>/);
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
  // V2.8.6 R2 — HumanClient now imports several names from turnRequestGuard.ts
  // (runOwnedHhTurnRequest and friends, for send()'s own reliability rebuild),
  // so this only requires isAuthApplicationError to be AMONG them, not the
  // sole import on its own line.
  assert.match(
    HUMAN_CLIENT,
    /import \{[^}]*\bisAuthApplicationError\b[^}]*\} from "@\/lib\/turnRequestGuard"/s
  );
  assert.match(refreshFn, /isAuthApplicationError\(data\.error\)/, "a documented auth error must be recognized explicitly");
  assert.match(refreshFn, /setError\(data\.message/, "the safe server message must be surfaced for a documented error");
});

test("HumanClient's /hh/turn handler (send) is built on runOwnedHhTurnRequest and submits record_revision, never the derived revision", () => {
  const sendFn = HUMAN_CLIENT.slice(
    HUMAN_CLIENT.indexOf("const send = useCallback("),
    HUMAN_CLIENT.indexOf("// V2.8.6 R2 — foreground reconciliation")
  );
  assert.match(sendFn, /runOwnedHhTurnRequest\(/, "must go through the shared H↔H ownership/reconciliation module");
  assert.match(
    sendFn,
    /expected_revision: viewRef\.current\.record_revision/,
    "must submit the real CAS revision, not lib/gameView.ts's derived revisionOf() poll marker"
  );
  assert.doesNotMatch(
    sendFn,
    /expected_revision: view\.revision\b/,
    "must never submit the derived poll marker as expected_revision"
  );
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
