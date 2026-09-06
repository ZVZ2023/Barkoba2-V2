import type { ExperienceMode, RacerAction } from "./types";

// ---------------------------------------------------------------------------
// V2.8.8.1 (C/D) — the evaluation overlay's guess-reveal line and
// mode-flavored status sentence, as pure functions. Extracted so both are
// unit-testable without rendering React, matching this codebase's
// established convention (lib/resultCopy.ts, lib/experienceMode.ts).
//
// SAFE-PRESENTATION BOUNDARY: this module decides WORDING ONLY. It never
// touches truth classification, adjudication, integrity review, or the
// verdict itself -- it is handed the ALREADY-DECIDED final_action and the
// ALREADY-VISIBLE (post pre-guess-confirmation-checkpoint) final_guess_text,
// and only chooses how to phrase describing them while the player waits.
// ---------------------------------------------------------------------------

/**
 * "Az AI tippje: „<guess>”." -- or null when there is nothing to show (a
 * concede, or a missing/blank guess). Deliberately mode-independent: the
 * FACT of what the AI guessed is never itself dressed up or hedged by tone.
 */
export function guessRevealLine(finalGuessText: string | null): string | null {
  const guess = (finalGuessText ?? "").trim();
  if (!guess) return null;
  return `Az AI tippje: „${guess}”.`;
}

interface StatusLines {
  /** Shown when final_action is "guess" (a guess is being adjudicated). */
  guess: string;
  /** Shown when final_action is "concede" (no guess to judge; Integrity Review governs the outcome). */
  concede: string;
}

// ---------------------------------------------------------------------------
// Required character per the approved decision:
//   Competitive — concise and serious.
//   Friendly    — warm and collaborative.
//   Teaching    — briefly explains what Barkóba is actually checking.
//   Humorous    — playful wording; never distorts status or truth.
// Every line here only describes WHAT IS BEING CHECKED, never asserts an
// outcome -- the verdict is not yet known at this point in the flow.
// ---------------------------------------------------------------------------
const STATUS_LINES: Record<ExperienceMode, StatusLines> = {
  competitive: {
    guess: "Az eredmény hivatalos ellenőrzése folyamatban.",
    concede: "Az AI feladta. Az eredmény hivatalos ellenőrzése folyamatban.",
  },
  friendly: {
    guess: "Nézzük meg együtt, sikerült-e eltalálnia!",
    concede: "Az AI feladta a próbálkozást. Nézzük meg, kiállták-e a válaszaid az ellenőrzést!",
  },
  teaching: {
    guess:
      "A Barkóba most azt ellenőrzi, hogy ez ugyanarra a dologra utal-e, mint a titkod, és hogy a korábbi válaszok is következetesek maradtak-e.",
    concede:
      "Az AI feladta. A Barkóba most azt ellenőrzi, hogy a korábbi válaszok következetesek maradtak-e.",
  },
  humorous: {
    guess: "Most jön a hivatalos igazságpillanat — lássuk, tényleg fején találta-e a szöget!",
    concede: "Az AI feladta — most kiderül, hogy tényleg megérdemelten.",
  },
};

/** A legacy game (no experience_mode) gets the neutral Competitive wording -- the least presumptuous default, consistent with every other mode-aware legacy fallback in this codebase. */
const LEGACY_STATUS_LINES = STATUS_LINES.competitive;

/**
 * The mode-flavored sentence describing what's being checked right now.
 * Never asserts a result; only ever describes the pending check itself.
 */
export function evaluationStatusLine(
  mode: ExperienceMode | null,
  finalAction: RacerAction | null
): string {
  const lines = mode ? STATUS_LINES[mode] : LEGACY_STATUS_LINES;
  return finalAction === "concede" ? lines.concede : lines.guess;
}
