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
// runOwnedTurnRequest's own behavioral fix is proven directly (real
// execution, mocked transport) in test/turnRequestGuard.test.ts. This file
// covers the two files that do NOT go through that machinery:
// RacerClient.tsx's /ask and /clue handlers and GameClient.tsx's /correct
// handler already satisfied every Commit 2 requirement before this change
// (never required `game`, never reconciled, never called /view) — asserted
// here as regression coverage, not implied by their being unmodified.
// HumanClient.tsx's /view poll DID need a real fix (it silently discarded
// every non-ok response, including a documented auth failure) and is
// asserted for the actual code change.
// ---------------------------------------------------------------------------

const GAME_CLIENT = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
const RACER_CLIENT = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");
const HUMAN_CLIENT = readFileSync("app/game/[id]/HumanClient.tsx", "utf8");

test("RacerClient's /ask handler never requires `game` and never reconciles/issues /view", () => {
  const sendFn = RACER_CLIENT.slice(
    RACER_CLIENT.indexOf("const send = useCallback("),
    RACER_CLIENT.indexOf("const resolveGame = useCallback(")
  );
  assert.match(sendFn, /if \(data\.game\) setGame\(data\.game as GameRecord\)/, "game must be optional, never destructured unconditionally");
  assert.match(sendFn, /if \(!res\.ok\) setError\(data\.message/, "the server's own message must be shown on failure");
  assert.doesNotMatch(sendFn, /\/view/, "must never issue a reconciliation read");
});

test("RacerClient's /clue handler (askForClue) never requires `game` and never reconciles/issues /view", () => {
  const clueFn = RACER_CLIENT.slice(
    RACER_CLIENT.indexOf("const askForClue = useCallback("),
    RACER_CLIENT.indexOf("const send = useCallback(")
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
