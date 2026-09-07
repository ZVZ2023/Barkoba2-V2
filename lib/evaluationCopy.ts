import type { ExperienceMode, ParticipantKind, RacerAction } from "./types";

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
//
// V2.9.2.1 PRODUCTION FIX — every line here was written assuming the Racer
// is always the AI ("Az AI tippje", "Az AI feladta", 3rd-person verb forms
// like "eltalálnia", and "a titkod"/"a válaszaid" addressed to the
// Composer). That was true of this module's only caller at the time
// (GameClient.tsx: human Composer, AI Racer). EvaluationState.tsx is also
// mounted from RacerClient.tsx (AI Composer, HUMAN Racer) — a real game
// there showed "Az AI tippje: „Kite”." to the human who had just typed
// "Kite" themselves. Every function here now takes `racerKind`, read
// straight from the game record (game.racer_kind) by the caller — never
// inferred from account identity or from which file happens to be
// rendering — and the perspective changes ONLY when racer_kind is
// "human". racer_kind === "ai" (the original, already-correct wording) is
// byte-for-byte unchanged. HumanClient.tsx (Human-vs-Human) does not use
// this module at all, so its own perspective handling is untouched by this
// fix either way.
// ---------------------------------------------------------------------------

/**
 * "Az AI tippje: „<guess>”." when the AI is the Racer, or "A tipped:
 * „<guess>”." when the human viewer themselves is the Racer -- or null when
 * there is nothing to show (a concede, or a missing/blank guess).
 * Deliberately mode-independent: the FACT of what was guessed is never
 * itself dressed up or hedged by tone, only WHO guessed varies by role.
 */
export function guessRevealLine(finalGuessText: string | null, racerKind: ParticipantKind): string | null {
  const guess = (finalGuessText ?? "").trim();
  if (!guess) return null;
  return racerKind === "human" ? `A tipped: „${guess}”.` : `Az AI tippje: „${guess}”.`;
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
//
// TWO PERSPECTIVES, NOT ONE. "aiRacer" is the ORIGINAL, unchanged wording
// (racer_kind === "ai" — the viewer is the human Composer: the AI is the
// one who guessed or conceded, "a titkod"/"a válaszaid" correctly address
// the viewer as the secret-holder whose answers are under review).
// "humanRacer" is the V2.9.2.1 addition (racer_kind === "human" — the
// viewer is the human Racer themselves: they are the one who guessed or
// conceded, and the secret/answers under review belong to the AI Composer,
// never the viewer, so those lines drop the "your" framing instead of
// misattributing it).
// ---------------------------------------------------------------------------
const STATUS_LINES: Record<ExperienceMode, { aiRacer: StatusLines; humanRacer: StatusLines }> = {
  competitive: {
    aiRacer: {
      guess: "Az eredmény hivatalos ellenőrzése folyamatban.",
      concede: "Az AI feladta. Az eredmény hivatalos ellenőrzése folyamatban.",
    },
    humanRacer: {
      guess: "Az eredmény hivatalos ellenőrzése folyamatban.",
      concede: "Feladtad. Az eredmény hivatalos ellenőrzése folyamatban.",
    },
  },
  friendly: {
    aiRacer: {
      guess: "Nézzük meg együtt, sikerült-e eltalálnia!",
      concede: "Az AI feladta a próbálkozást. Nézzük meg, kiállták-e a válaszaid az ellenőrzést!",
    },
    humanRacer: {
      guess: "Nézzük meg, sikerült-e eltalálnod!",
      concede: "Feladtad a próbálkozást. Nézzük meg, kiállták-e a kapott válaszok az ellenőrzést!",
    },
  },
  teaching: {
    aiRacer: {
      guess:
        "A Barkóba most azt ellenőrzi, hogy ez ugyanarra a dologra utal-e, mint a titkod, és hogy a korábbi válaszok is következetesek maradtak-e.",
      concede:
        "Az AI feladta. A Barkóba most azt ellenőrzi, hogy a korábbi válaszok következetesek maradtak-e.",
    },
    humanRacer: {
      guess:
        "A Barkóba most azt ellenőrzi, hogy ez ugyanarra a dologra utal-e, mint a rögzített titok, és hogy a korábbi válaszok is következetesek maradtak-e.",
      concede:
        "Feladtad. A Barkóba most azt ellenőrzi, hogy a korábbi válaszok következetesek maradtak-e.",
    },
  },
  humorous: {
    aiRacer: {
      guess: "Most jön a hivatalos igazságpillanat — lássuk, tényleg fején találta-e a szöget!",
      concede: "Az AI feladta — most kiderül, hogy tényleg megérdemelten.",
    },
    humanRacer: {
      guess: "Most jön a hivatalos igazságpillanat — lássuk, tényleg fején találtad-e a szöget!",
      concede: "Feladtad — most kiderül, hogy tényleg megérdemelten.",
    },
  },
};

/** A legacy game (no experience_mode) gets the neutral Competitive wording -- the least presumptuous default, consistent with every other mode-aware legacy fallback in this codebase. */
const LEGACY_STATUS_LINES = STATUS_LINES.competitive;

/**
 * The mode-flavored sentence describing what's being checked right now.
 * Never asserts a result; only ever describes the pending check itself.
 * `racerKind` comes from the game record (game.racer_kind), never from
 * account identity or which screen is rendering.
 */
export function evaluationStatusLine(
  mode: ExperienceMode | null,
  finalAction: RacerAction | null,
  racerKind: ParticipantKind
): string {
  const byMode = mode ? STATUS_LINES[mode] : LEGACY_STATUS_LINES;
  const lines = racerKind === "human" ? byMode.humanRacer : byMode.aiRacer;
  return finalAction === "concede" ? lines.concede : lines.guess;
}
