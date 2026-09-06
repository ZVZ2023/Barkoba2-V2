import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.8.8 SLICE 3 — setup/play/history UI and localization.
//
// No rendering harness exists in this project (see
// test/resultScreenProfileLeak.test.ts's own doc), so wiring is proven from
// source, matching this codebase's established convention.
// ---------------------------------------------------------------------------

const RACER_SETUP = readFileSync("app/RacerSetup.tsx", "utf8");
const COMPOSER_ENTRY = readFileSync("app/ComposerEntry.tsx", "utf8");
const HUMAN_SETUP = readFileSync("app/play/human/HumanSetup.tsx", "utf8");
const GAME_CLIENT = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
const RACER_CLIENT = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");
const HUMAN_CLIENT = readFileSync("app/game/[id]/HumanClient.tsx", "utf8");
const HISTORY_CLIENT = readFileSync("app/history/HistoryClient.tsx", "utf8");
const GAME_CORPUS = readFileSync("lib/corpus/gameCorpus.ts", "utf8");

// ---------------------------------------------------------------------------
// Setup screens: all three submit experience_mode, defaulting to Friendly.
// ---------------------------------------------------------------------------

test("RacerSetup.tsx: the OLD clue_mode/Segítség selector is gone -- experience_mode replaces it for new games", () => {
  assert.doesNotMatch(RACER_SETUP, /const CLUE_MODES/, "the old selector's data array must be gone, not merely renamed");
  assert.doesNotMatch(RACER_SETUP, /clue_mode:/, "must no longer submit a raw clue_mode");
  assert.match(RACER_SETUP, /useState<ExperienceMode>\(DEFAULT_EXPERIENCE_MODE\)/);
  assert.match(RACER_SETUP, /experience_mode: experienceMode,/);
  // Difficulty remains a separate, untouched axis.
  assert.match(RACER_SETUP, /useState<Difficulty>\("easy"\)/);
});

test("ComposerEntry.tsx: a NEW experience_mode selector, defaulting to Friendly -- this screen never had an assistance picker before", () => {
  assert.match(COMPOSER_ENTRY, /useState<ExperienceMode>\(DEFAULT_EXPERIENCE_MODE\)/);
  assert.match(COMPOSER_ENTRY, /experience_mode: experienceMode,/);
  // Entitlement/config/heading from V2.8.7.2 remain untouched.
  assert.match(COMPOSER_ENTRY, /role="Te gondolsz valamire\. A Barkóba AI fogja kitalálni\."/);
});

test("HumanSetup.tsx: a NEW experience_mode selector, defaulting to Friendly", () => {
  assert.match(HUMAN_SETUP, /useState<ExperienceMode>\(DEFAULT_EXPERIENCE_MODE\)/);
  assert.match(HUMAN_SETUP, /experience_mode: experienceMode,/);
});

test("all three setup screens render exactly the four approved Hungarian labels via the ONE shared lib/experienceMode.ts map -- no direction-specific label list", () => {
  for (const src of [RACER_SETUP, COMPOSER_ENTRY, HUMAN_SETUP]) {
    assert.match(src, /from "@\/lib\/experienceMode"/);
    assert.match(src, /EXPERIENCE_MODE_LABEL_HU/);
    assert.match(src, /EXPERIENCE_MODE_DESCRIPTION_HU/);
    assert.doesNotMatch(src, /"Verseny"|"Baráti"|"Tanító"|"Humoros"/, "labels must come from the shared map, not be re-literalized per screen");
  }
});

// ---------------------------------------------------------------------------
// In-play mode badge: all three screens, visible only for a mode-bearing
// game, absent for a legacy one.
// ---------------------------------------------------------------------------

test("GameClient.tsx / RacerClient.tsx / HumanClient.tsx: the mode badge is conditional on the game's OWN experience_mode, absent for a legacy (null) game", () => {
  assert.match(GAME_CLIENT, /\{game\.experience_mode \? ` · \$\{EXPERIENCE_MODE_LABEL_HU\[game\.experience_mode\]\}` : ""\}/);
  assert.match(RACER_CLIENT, /game\.experience_mode\s*\n\s*\? ` · \$\{EXPERIENCE_MODE_LABEL_HU\[game\.experience_mode\]\}`/);
  assert.match(HUMAN_CLIENT, /\{view\.experience_mode \? ` · \$\{EXPERIENCE_MODE_LABEL_HU\[view\.experience_mode\]\}` : ""\}/);
});

test("RacerClient.tsx: a mode-bearing game shows the MODE, not the raw clue_mode suffix -- no redundant double-display of the same underlying fact", () => {
  const introAt = RACER_CLIENT.indexOf("Az AI gondolt valamire. Te kérdezel.");
  const introBlock = RACER_CLIENT.slice(introAt, introAt + 900);
  assert.match(introBlock, /game\.experience_mode\s*\n\s*\?[\s\S]*?EXPERIENCE_MODE_LABEL_HU\[game\.experience_mode\]/);
  assert.match(introBlock, /: game\.clue_mode && game\.clue_mode !== "none"/, "the legacy clue_mode suffix must still exist as the ELSE branch");
});

// ---------------------------------------------------------------------------
// History: query includes experience_mode, response carries it, client
// displays it.
// ---------------------------------------------------------------------------

test("lib/corpus/gameCorpus.ts: listPlayerHistory's query selects experience_mode and maps it onto PlayerHistoryEntry", () => {
  const fnAt = GAME_CORPUS.indexOf("export async function listPlayerHistory");
  const fn = GAME_CORPUS.slice(fnAt, fnAt + 2000);
  assert.match(fn, /SELECT[\s\S]*experience_mode/);
  assert.match(fn, /experience_mode: typeof row\.experience_mode === "string" \? row\.experience_mode : null,/);
});

test("HistoryClient.tsx: the local HistoryEntry mirror includes experience_mode, and renders the shared label for a mode-bearing game only", () => {
  assert.match(HISTORY_CLIENT, /experience_mode: string \| null;/);
  assert.match(HISTORY_CLIENT, /isExperienceMode\(entry\.experience_mode\)/);
  assert.match(HISTORY_CLIENT, /EXPERIENCE_MODE_LABEL_HU\[entry\.experience_mode\]/);
  // Still imports from the pure, browser-safe lib/experienceMode.ts only --
  // never from lib/corpus/gameCorpus.ts (the isolation boundary this file's
  // own doc comment already states for a different pairing of modules).
  assert.doesNotMatch(HISTORY_CLIENT, /from "@\/lib\/corpus\//);
});
