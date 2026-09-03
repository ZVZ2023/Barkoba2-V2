import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isGameLanguage,
  normalizeLanguageChoice,
  resolveGameLanguage,
} from "../lib/gameLanguage";

// ---------------------------------------------------------------------------
// V2.5 — game language vs shell language.
//
// The rule is a pure function, so cases 1–8 below are EXECUTED rather than
// asserted against route source. The remaining cases are structural guards on
// the two things that must not drift: the shell staying Hungarian, and the
// downstream model paths continuing to read game.game_language.
// ---------------------------------------------------------------------------

// --- 1 & 2. AUTO follows the Validator's reading ---------------------------

test("AUTO + a clear English submission plays in English", () => {
  assert.equal(resolveGameLanguage("auto", "en"), "en");
  // Absent is the same as "auto": a client that sends nothing still gets the
  // detection rather than a pinned default.
  assert.equal(resolveGameLanguage(undefined, "en"), "en");
});

test("AUTO + a clear Hungarian submission plays in Hungarian", () => {
  assert.equal(resolveGameLanguage("auto", "hu"), "hu");
  assert.equal(resolveGameLanguage(undefined, "hu"), "hu");
});

// --- 3 & 4. An explicit choice outranks detection --------------------------

test("explicit English overrides a Hungarian detection", () => {
  // The case the three-state control exists for: a one-word target such as
  // Grok, Apple or Tesla tells a detector nothing about which language the
  // human meant to play in, so the human must be able to say.
  assert.equal(resolveGameLanguage("en", "hu"), "en");
});

test("explicit Magyar overrides an English detection", () => {
  assert.equal(resolveGameLanguage("hu", "en"), "hu");
});

// --- 5. A malformed request never becomes game state -----------------------

test("an invalid client language is ignored, not adopted", () => {
  for (const junk of ["klingon", "EN", "", null, 42, {}, [], true, "hu-HU"]) {
    const resolved = resolveGameLanguage(junk, "en");
    // It degrades to the detection — never to the junk, and never to an error.
    assert.equal(resolved, "en", `${JSON.stringify(junk)} should have been ignored`);
    assert.equal(normalizeLanguageChoice(junk), "auto");
  }
  // With nothing to fall back to, it still lands on a real language.
  assert.equal(resolveGameLanguage("klingon", null), "hu");
});

test("the result is always a valid GameLanguage", () => {
  for (const req of ["auto", "hu", "en", undefined, null, "nonsense"]) {
    for (const det of ["hu", "en", null, undefined, "nonsense", 7]) {
      assert.ok(
        isGameLanguage(resolveGameLanguage(req, det)),
        `resolve(${JSON.stringify(req)}, ${JSON.stringify(det)}) escaped the union`
      );
    }
  }
});

// --- 6. Unusable detection falls back --------------------------------------

test("AUTO falls back to Hungarian when detection is unavailable or unusable", () => {
  assert.equal(resolveGameLanguage("auto", null), "hu");
  assert.equal(resolveGameLanguage("auto", undefined), "hu");
  assert.equal(resolveGameLanguage("auto", "unknown"), "hu");
  assert.equal(resolveGameLanguage("auto", ""), "hu");
});

// --- 7 & 8. AI Composer: no text to detect from ----------------------------

test("AI Composer + AUTO plays in Hungarian", () => {
  // Detection is null on this path by construction — the AI chooses its target
  // only after the language is fixed, so there is no human wording to read.
  assert.equal(resolveGameLanguage("auto", null), "hu");
  assert.equal(resolveGameLanguage(undefined, null), "hu");
});

test("AI Composer + explicit English plays in English", () => {
  assert.equal(resolveGameLanguage("en", null), "en");
});

// --- the creation sites actually use it ------------------------------------

const CREATE_ROUTE = readFileSync("app/api/game/create/route.ts", "utf8");

test("no creation site hardcodes a game language any more", () => {
  // All three literals — two createGame calls and the AI target selection —
  // were `"hu"`, which is why an English game was impossible.
  assert.doesNotMatch(CREATE_ROUTE, /game_language: "hu"/);
  assert.doesNotMatch(CREATE_ROUTE, /gameLanguage: "hu"/);
  assert.match(CREATE_ROUTE, /game_language: resolveGameLanguage\(/);
  assert.match(CREATE_ROUTE, /gameLanguage: aiGameLanguage/);
});

// V2.8.4 — REVERSED. The human path briefly read the Validator's own
// language detection here, which fixed one bug (an English target forced
// into Hungarian) by reintroducing another: this shell's answer controls
// (GameClient.tsx's IGEN/NEM/IS-IS) are hardcoded Hungarian with no language
// switch, so AUTO silently detecting "en" from the target text produced
// English questions beside permanently-Hungarian buttons. Both creation
// sites now pass null for `detected`, so AUTO collapses to the shell's own
// language ("hu") on both paths — only an EXPLICIT "hu"/"en" choice still
// changes anything. See test/phaseOneLanguageGate.test.ts for the real-flow
// proof this closes.
test("neither creation path feeds target-text detection into AUTO any more", () => {
  const detectionCalls = CREATE_ROUTE.match(/resolveGameLanguage\([^)]*\)/g) ?? [];
  assert.equal(detectionCalls.length, 2, "both creation call sites must still exist");
  for (const call of detectionCalls) {
    assert.match(call, /resolveGameLanguage\(body\.game_language, null\)/);
  }
  assert.doesNotMatch(CREATE_ROUTE, /resolveGameLanguage\([^)]*validation\.game_language/);
});

// --- 9. the shell stays Hungarian ------------------------------------------

test("the setup screens gained a language choice, not a translated interface", () => {
  for (const path of ["app/ComposerEntry.tsx", "app/RacerSetup.tsx"]) {
    const src = readFileSync(path, "utf8");
    assert.match(src, /A játék nyelve/, `${path} must offer the choice`);
    assert.match(src, /Automatikus/);
    assert.match(src, /game_language: gameLanguage/, `${path} must send it`);
  }
});

test("no i18n layer was introduced", () => {
  // The product rule is that shell and game language are SEPARATE, not that the
  // shell becomes translatable. "English" appearing below is a language name on
  // a button, not translated interface copy.
  for (const path of ["app/ComposerEntry.tsx", "app/RacerSetup.tsx"]) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(src, /useTranslation|i18n|\bt\(["'`]/, `${path} must not translate itself`);
  }
});

// --- 10 & 11. downstream and history --------------------------------------

test("every model path still reads game.game_language", () => {
  // The plumbing was already correct and must stay untouched: setting the value
  // at creation is the entire fix.
  const paths: Array<[string, number]> = [
    ["app/api/game/[id]/ask/route.ts", 3],
    ["app/api/game/[id]/clue/route.ts", 1],
    ["app/api/game/[id]/resolve/route.ts", 2],
  ];
  for (const [path, expected] of paths) {
    const hits = (readFileSync(path, "utf8").match(/gameLanguage: game\.game_language/g) ?? [])
      .length;
    assert.equal(hits, expected, `${path} should pass the game language ${expected}x`);
  }
  // The Racer receives it through the narrowing boundary, never the raw record.
  assert.match(readFileSync("lib/racerState.ts", "utf8"), /game_language: game\.game_language/);
});

test("historical games need no migration", () => {
  // game_language has been a persisted GameRecord field since M3; this change
  // only alters what is written INTO it at creation. Records already in Redis
  // are normalised on read, and the corpus column is untouched.
  assert.match(readFileSync("lib/gameStore.ts", "utf8"), /record\.game_language !== "hu"/);
  assert.doesNotMatch(CREATE_ROUTE, /ALTER TABLE|migration/i);
});
