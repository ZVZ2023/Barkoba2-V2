import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.7 — the game-history UI. The backend (GET /api/player/history ->
// listPlayerHistory) already existed, correctly scoped to the caller's own
// player_id, and was never wired to any page — confirmed by grep before this
// file was written. This is a pure frontend addition; no route, corpus query,
// or migration changed.
//
// Structural, matching this suite's convention for pages with no rendering
// harness.
// ---------------------------------------------------------------------------

const PAGE = readFileSync("app/history/page.tsx", "utf8");
const CLIENT = readFileSync("app/history/HistoryClient.tsx", "utf8");
const ACCOUNT_CONTROL = readFileSync("app/components/AccountControl.tsx", "utf8");
const HISTORY_ROUTE = readFileSync("app/api/player/history/route.ts", "utf8");

test("the page renders the client component with a version label, matching every other page-level component", () => {
  assert.match(PAGE, /import HistoryClient from "\.\/HistoryClient"/);
  assert.match(PAGE, /<HistoryClient versionLabel=\{formatVersionLabel\(getAppVersion\(\)\)\} \/>/);
});

test("the client component calls the existing history endpoint, not a new one", () => {
  assert.match(CLIENT, /fetch\("\/api\/player\/history"/);
});

test("the client component never imports server-only corpus code into a client bundle", () => {
  assert.doesNotMatch(CLIENT, /from ["']@\/lib\/corpus/);
  // The shape is duplicated locally instead — proof the duplication exists,
  // not just that the import is absent.
  assert.match(CLIENT, /interface HistoryEntry/);
  assert.match(CLIENT, /lifecycle_state: string/);
});

test("both endpoint failure modes the route can return are handled distinctly", () => {
  // 409 identity_unavailable and non-409 non-ok (e.g. 503 history_unavailable)
  // must not collapse into one generic error — a player with no resolvable
  // identity needs a different message than a real service outage.
  assert.match(HISTORY_ROUTE, /status: 409/);
  assert.match(CLIENT, /res\.status === 409/);
  assert.match(CLIENT, /step: "no_identity"/);
  assert.match(CLIENT, /step: "unavailable"/);
  assert.match(CLIENT, /step: "network_error"/);
});

test("role is rendered in Hungarian, matching HumanClient.tsx's existing vocabulary — not the internal role words", () => {
  assert.match(CLIENT, /gondolkodó voltál/);
  assert.match(CLIENT, /kérdező voltál/);
});

test("outcome is read from the player's own seat, not shown as a bare provenance code", () => {
  assert.match(CLIENT, /entry\.role === "composer"/);
  assert.match(CLIENT, /entry\.role === "racer"/);
  assert.match(CLIENT, /Nyertél/);
  assert.match(CLIENT, /Vesztettél/);
});

test("an empty history is a distinct, non-error state", () => {
  assert.match(CLIENT, /state\.games\.length === 0/);
  assert.match(CLIENT, /Még nincs mentett játékod\./);
});

// ---------------------------------------------------------------------------
// V2.8.8.2 — GAME-HISTORY FAILURE AND LAST-TWO-GAMES VERDICT AUDIT.
//
// Confirmed defect #1: listPlayerHistory (lib/corpus/gameCorpus.ts)
// collapsed "corpus not configured" (a non-issue) and "corpus configured
// but the query failed" (a real outage) into the same bare `null`, which
// the route always turned into the same generic 503 history_unavailable.
// Executed proof of the fix lives in test/playerHistory.test.ts (the two
// new ok:true/ok:false tests); this file adds the source-contract
// confirmation that the route was updated to match.
//
// Confirmed defect #2: a COMPLETED game had NO link at all from Játékaim
// — only "in_progress" ever rendered a link to /game/[id] — so even once
// the list itself loads, a player could never re-open a finished game's
// full detail (target, guess, transcript, hints, adjudication/integrity
// notes) that /game/[id] already renders correctly and securely. Fixed by
// linking every lifecycle_state, unconditionally, to the SAME existing,
// unchanged /game/[id] page — no new detail view was built, because one
// already existed and already enforces ownership correctly.
// ---------------------------------------------------------------------------

test("SOURCE: the route distinguishes ok:false (history_unavailable) from ok:true, rather than a bare null check", () => {
  assert.match(HISTORY_ROUTE, /const lookup = await listPlayerHistory\(playerId\);/);
  assert.match(HISTORY_ROUTE, /if \(!lookup\.ok\)/);
  assert.match(HISTORY_ROUTE, /games: lookup\.games/);
});

test("SOURCE: EVERY lifecycle_state renders a link to /game/[id], not only in_progress", () => {
  // The old, narrower guard must be gone...
  assert.doesNotMatch(CLIENT, /\{entry\.lifecycle_state === "in_progress" && \(/);
  // ...replaced by an unconditional link whose LABEL still distinguishes
  // in_progress ("continue") from every other state ("open").
  assert.match(CLIENT, /href=\{`\/game\/\$\{entry\.game_id\}`\}/);
  assert.match(CLIENT, /entry\.lifecycle_state === "in_progress" \? "Folytatás →" : "Megnyitás →"/);
});

test("SOURCE: the completed-game link reuses /game/[id] as-is -- no new detail-view route or component was introduced for this", () => {
  // A single href pattern for every state, not a second code path per state.
  const hrefOccurrences = CLIENT.match(/href=\{`\/game\/\$\{entry\.game_id\}`\}/g) ?? [];
  assert.equal(hrefOccurrences.length, 1, "exactly one link site, covering every lifecycle_state uniformly");
});

test("the history link is reachable from the header's Profil menu, only when authenticated", () => {
  const authBranch = ACCOUNT_CONTROL.slice(
    ACCOUNT_CONTROL.indexOf("{authenticated ? ("),
    ACCOUNT_CONTROL.indexOf(") : (")
  );
  assert.match(authBranch, /href="\/history"/);
  assert.match(authBranch, /Játékaim/);

  const unauthBranch = ACCOUNT_CONTROL.slice(ACCOUNT_CONTROL.indexOf(") : ("));
  assert.doesNotMatch(unauthBranch.slice(0, unauthBranch.indexOf("</>")), /href="\/history"/);
});
