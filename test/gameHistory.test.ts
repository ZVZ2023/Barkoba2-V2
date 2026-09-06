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

// ---------------------------------------------------------------------------
// V2.8.8.5 — MEANINGFUL GAME-HISTORY CARDS.
//
// Executable proof that the SERVER never returns target/guess for anything
// but a completed, owned game lives in test/playerHistory.test.ts
// (completed-target visibility, incomplete-target secrecy, non-owner
// isolation, missing historical fields, query efficiency). These are the
// source-contract confirmations that the CLIENT renders what the server
// sends correctly and prominently, scoped to completed cards only.
// ---------------------------------------------------------------------------

test("SOURCE: target is the completed card's most prominent identifying text -- rendered first, in the largest/boldest text on the card", () => {
  const completedAt = CLIENT.indexOf('entry.lifecycle_state === "completed"');
  assert.ok(completedAt > 0);
  const block = CLIENT.slice(completedAt, completedAt + 2500);
  const targetAt = block.indexOf("entry.target ?? c.targetNotRetained");
  const guessAt = block.indexOf("c.guessLabel");
  assert.ok(targetAt > 0 && (guessAt < 0 || targetAt < guessAt), "target must render before the guess line");
  assert.match(block, /text-base font-semibold/, "target uses the card's largest, boldest text treatment");
});

test("SOURCE: the final guess renders beneath the target, only when retained -- no placeholder when absent", () => {
  const completedAt = CLIENT.indexOf('entry.lifecycle_state === "completed"');
  const block = CLIENT.slice(completedAt, completedAt + 1200);
  assert.match(block, /\{entry\.final_guess_text && \(/, "the guess line is conditional on being present, never a forced placeholder");
});

test("SOURCE: questions-used/limit is displayed on the completed card", () => {
  const completedAt = CLIENT.indexOf('entry.lifecycle_state === "completed"');
  const block = CLIENT.slice(completedAt, completedAt + 2500);
  assert.match(block, /entry\.question_count\} \/ \{entry\.max_questions\}/);
});

test("SOURCE: date/time is secondary metadata on the completed card -- rendered after target/guess/mode/questions/outcome, not first", () => {
  const completedAt = CLIENT.indexOf('entry.lifecycle_state === "completed"');
  const block = CLIENT.slice(completedAt, completedAt + 2500);
  const targetAt = block.indexOf("entry.target ?? c.targetNotRetained");
  const dateAt = block.indexOf("formatWhen(entry.created_at, entry.game_language)");
  assert.ok(targetAt > 0 && dateAt > targetAt, "date must be rendered after the target, not before it");
});

test("SOURCE: role, experience mode, and final outcome are all present on the completed card, human-readable (never a raw enum)", () => {
  const completedAt = CLIENT.indexOf('entry.lifecycle_state === "completed"');
  const block = CLIENT.slice(completedAt, completedAt + 2500);
  assert.match(block, /entry\.role \? ROLE_HU\[entry\.role\]/);
  assert.match(block, /EXPERIENCE_MODE_LABEL_HU\[entry\.experience_mode\]/);
  assert.match(block, /status\.text/, "final outcome uses the SAME translated statusOf() text as every other card, never a raw outcome enum");
});

test("SOURCE: the completed card carries an explicit, localized 'not retained' label for a missing target -- never a blank or raw null", () => {
  assert.match(CLIENT, /targetNotRetained: "A cél nincs megőrizve ehhez a játékhoz\."/);
  assert.match(CLIENT, /targetNotRetained: "The target was not retained for this game\."/);
});

test("SOURCE: the Megnyitás link is preserved unchanged for completed cards too -- reused, not reimplemented", () => {
  const completedAt = CLIENT.indexOf('entry.lifecycle_state === "completed"');
  const block = CLIENT.slice(completedAt, completedAt + 2500);
  assert.match(block, /\{megnyitas\}/);
});

test("SOURCE: a non-completed game's card layout is completely unchanged -- the enriched fields are scoped to completed only", () => {
  assert.doesNotMatch(CLIENT, /entry\.lifecycle_state === "in_progress" && \(\s*<>/);
  const nonCompletedAt = CLIENT.indexOf("Every non-completed lifecycle_state keeps the ORIGINAL");
  assert.ok(nonCompletedAt > 0);
  const block = CLIENT.slice(nonCompletedAt, nonCompletedAt + 1500);
  assert.doesNotMatch(block, /entry\.target/, "target must never even be READ in the non-completed branch");
  assert.doesNotMatch(block, /entry\.final_guess_text/, "guess must never even be read in the non-completed branch");
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
