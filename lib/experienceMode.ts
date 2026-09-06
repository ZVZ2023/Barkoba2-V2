import type { ClueMode, ExperienceMode } from "./types";

// ---------------------------------------------------------------------------
// V2.8.8 — the experience-mode preset. ONE central module so every reader
// (setup UI, the create-game route, provenance/history display) agrees on
// the valid values and the preset mapping, rather than each reimplementing
// its own list.
//
// Pure — no React, no DOM, no model call — same reason lib/clueCredits.ts
// and lib/questionPolicy.ts are pure.
// ---------------------------------------------------------------------------

export const EXPERIENCE_MODES: readonly ExperienceMode[] = [
  "competitive",
  "friendly",
  "teaching",
  "humorous",
];

export function isExperienceMode(value: unknown): value is ExperienceMode {
  return typeof value === "string" && (EXPERIENCE_MODES as readonly string[]).includes(value);
}

/**
 * NEW-GAME-ONLY preset mapping: the experience mode a player picks replaces
 * the old separate assistance ("Segítség") selector for any game created
 * with an experience_mode. This is what lets "Competitive + Progressive
 * assistance" become structurally impossible to create, rather than merely
 * discouraged in the UI.
 *
 * This is a PRESET, not a rewrite of clue_mode's own meaning: clue_mode
 * keeps meaning exactly what it always meant (how much AI-generated hint
 * content the Composer-answering prompt gives), unchanged for every
 * historical game. Only how a NEW game arrives at a clue_mode value changes.
 */
export function clueModeForExperienceMode(mode: ExperienceMode): ClueMode {
  switch (mode) {
    case "competitive":
      return "none";
    case "friendly":
      return "minimal";
    case "teaching":
      // Teaching gets the richer, escalating guidance clue_mode already
      // supports — reusing the existing "progressive" level rather than
      // inventing a fourth clue intensity for one preset.
      return "progressive";
    case "humorous":
      return "minimal";
  }
}

/** Hungarian setup-chrome labels — matches every sibling control (Nehézség, Segítség, Kérdések). */
export const EXPERIENCE_MODE_LABEL_HU: Record<ExperienceMode, string> = {
  competitive: "Verseny",
  friendly: "Baráti",
  teaching: "Tanító",
  humorous: "Humoros",
};

/** Mobile-width setup descriptions, Hungarian chrome. */
export const EXPERIENCE_MODE_DESCRIPTION_HU: Record<ExperienceMode, string> = {
  competitive: "Szigorú, tiszta párbaj. Nincs súgó.",
  friendly: "Segítőkész játék. Elérhető a súgó.",
  teaching: "Segít jobban kérdezni és tanulni. Elérhető a súgó.",
  humorous: "Játékos hangvétel. Elérhető a súgó.",
};

/** The visible default for every new-game setup screen (decision: Friendly, never Competitive). */
export const DEFAULT_EXPERIENCE_MODE: ExperienceMode = "friendly";
