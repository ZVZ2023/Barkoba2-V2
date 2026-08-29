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
