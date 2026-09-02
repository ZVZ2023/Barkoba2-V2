import type { GameLanguage, QuestionLogEntry } from "./types";

// ---------------------------------------------------------------------------
// V2.8.4 — Runtime Phase One v6.1: deterministic sandbox classification.
//
// Zero provider calls. Pure, no I/O — the same reason lib/rewind.ts and
// lib/duplicateQuestionGuard.ts are pure: the state machine IS the feature,
// so it is exercised directly in tests rather than implied by route control
// flow. Structurally incapable of reading the secret target: this module
// takes only a game's qa_log (already public question/answer text) and its
// language — no GameRecord, no SecretRecord, nothing else. It must never
// import lib/secretStore.ts; scripts/check-isolation.mjs does not need to
// enforce this specially because there is nothing here for it to import.
//
// REPLAY, NOT STORED POSITION. Phase One's current state is derived fresh
// from game.qa_log's own leading run of deterministic entries every time —
// there is no separate "current spine position" field on GameRecord. That is
// what makes reload, correction, and rewind all work for free through the
// EXISTING mechanisms: a correction's splitAtTurn() already truncates
// qa_log before the next /turn call regenerates a turn, so the very next
// derivePhaseOneState() call simply sees the shorter log and recomputes the
// right answer — no invalidation code of its own is needed anywhere.
//
// SELF-BOUNDING BY TEXT MATCH. A Phase One entry is recognized by matching
// its (static, localized) question_text against the exact next expected
// question for the current state. The instant an entry doesn't match — a
// different question, a non-"question" turn, or a model-authored turn
// (model_id set) — Phase One reports itself "not applicable" (complete with
// no sandbox) and every subsequent turn is untouched, unchanged Phase Two.
// This makes the feature inert-by-construction for any game that did not
// start inside it, with no explicit version/feature-flag check required.
//
// HONEST PROVENANCE, NO INVENTED SENTINEL. A deterministic Phase One turn
// leaves QuestionLogEntry.model_id / model_provider / prompt_version /
// latency_ms exactly null — the schema's own pre-existing, documented
// meaning ("Null when no model authored it" — see lib/types.ts) is already
// the honest representation of "no model call happened here." Nothing new
// was added to represent this.
// ---------------------------------------------------------------------------

export type PhaseOneSandbox = "living" | "physical" | "place" | "event" | "abstract" | "unclassified";

export type PhaseOneSpecificity = "particular" | "kind" | "mixed";

/**
 * The result of replaying a game's qa_log against the deterministic spine.
 *
 * `complete: false` means Phase One must ask `nextQuestionText` next.
 * `complete: true` with `sandbox: null` means Phase One never applied to
 * this game (or has nothing further to say) — proceed exactly as before.
 * `complete: true` with `sandbox` set means classification is finished and
 * the model Racer should take over, informed by this state.
 */
export interface PhaseOneState {
  sandbox: PhaseOneSandbox | null;
  /** Null until a specificity question is answered; also null for abstract/unclassified, which have none. */
  specificity: PhaseOneSpecificity | null;
  /** 1-based spine question numbers (1-4) answered IS-IS/AMBIGUOUS — contested evidence, not a NO. */
  mixedSpineQuestions: number[];
  complete: boolean;
  /** The next deterministic question to ask, or null when `complete` or when a question is already pending an answer. */
  nextQuestionText: string | null;
}

const SANDBOX_ORDER: readonly PhaseOneSandbox[] = ["living", "physical", "place", "event"];

const SPINE_QUESTIONS: Record<GameLanguage, readonly [string, string, string, string, string]> = {
  en: [
    "Is it alive?",
    "Is it a physical thing or substance?",
    "Is it a place or location?",
    "Is it an event or occurrence?",
    "Is it primarily non-physical or informational?",
  ],
  hu: [
    "Élő?",
    "Fizikai dolog vagy anyag?",
    "Hely vagy helyszín?",
    "Esemény vagy történés?",
    "Elsősorban nem fizikai vagy információs természetű?",
  ],
};

type SpecificitySandbox = "living" | "physical" | "place" | "event";

const SPECIFICITY_QUESTIONS: Record<GameLanguage, Record<SpecificitySandbox, string>> = {
  en: {
    living: "Is it one particular living being?",
    physical: "Is it one particular physical item or substance?",
    place: "Is it one particular place?",
    event: "Is it one particular event?",
  },
  hu: {
    living: "Egy konkrét élőlényre gondoltál?",
    physical: "Egy konkrét fizikai dologra vagy anyagra gondoltál?",
    place: "Egy konkrét helyre gondoltál?",
    event: "Egy konkrét eseményre gondoltál?",
  },
};

function hasSpecificity(sandbox: PhaseOneSandbox): sandbox is SpecificitySandbox {
  return sandbox === "living" || sandbox === "physical" || sandbox === "place" || sandbox === "event";
}

const NOT_APPLICABLE: PhaseOneState = {
  sandbox: null,
  specificity: null,
  mixedSpineQuestions: [],
  complete: true,
  nextQuestionText: null,
};

/**
 * Derive Phase One's current state from a game's qa_log alone. Pure,
 * deterministic, and safe to call on every turn-generation request — this
 * is the ONLY source of truth for "where is Phase One," so there is nothing
 * to keep in sync after a reload, a correction, or a rewind.
 */
export function derivePhaseOneState(qaLog: readonly QuestionLogEntry[], language: GameLanguage): PhaseOneState {
  const spine = SPINE_QUESTIONS[language];
  const specificityText = SPECIFICITY_QUESTIONS[language];

  let sandbox: PhaseOneSandbox | null = null;
  let specificity: PhaseOneSpecificity | null = null;
  const mixedSpineQuestions: number[] = [];
  let spineIndex = 0; // 0-based index into `spine`, i.e. how many spine questions are already answered

  for (const entry of qaLog) {
    if (entry.turn_type !== "question" || entry.model_id !== null) return NOT_APPLICABLE;

    if (sandbox === null) {
      if (spineIndex > 4 || entry.question_text !== spine[spineIndex]) return NOT_APPLICABLE;

      if (entry.composer_response === null) {
        // This spine question is asked but not yet answered — nothing to
        // generate; the route's own "pending question" check already keeps
        // callers from reaching here in practice, but replay stays correct
        // either way.
        return { sandbox, specificity, mixedSpineQuestions, complete: false, nextQuestionText: null };
      }

      if (spineIndex < 4) {
        if (entry.composer_response === "YES") {
          sandbox = SANDBOX_ORDER[spineIndex] as PhaseOneSandbox;
        } else if (entry.composer_response === "NO") {
          spineIndex += 1;
        } else {
          // AMBIGUOUS is this app's internal name for IS-IS. Q1–Q4: mixed
          // evidence, NOT a NO — continue to the next spine question exactly
          // as a NO would, but record it as contested.
          mixedSpineQuestions.push(spineIndex + 1);
          spineIndex += 1;
        }
      } else {
        // Q5 — YES locks Abstract; NO or IS-IS both classify Unclassified.
        sandbox = entry.composer_response === "YES" ? "abstract" : "unclassified";
      }
      continue;
    }

    if (hasSpecificity(sandbox) && specificity === null) {
      if (entry.question_text !== specificityText[sandbox]) return NOT_APPLICABLE;
      if (entry.composer_response === null) {
        return { sandbox, specificity, mixedSpineQuestions, complete: false, nextQuestionText: null };
      }
      specificity =
        entry.composer_response === "YES" ? "particular" : entry.composer_response === "NO" ? "kind" : "mixed";
      continue;
    }

    // Sandbox has no specificity question (abstract/unclassified) or
    // specificity is already answered — Phase One's classification is
    // final; anything further belongs to Phase Two.
    return NOT_APPLICABLE;
  }

  const complete = sandbox !== null && (!hasSpecificity(sandbox) || specificity !== null);
  const nextQuestionText = complete
    ? null
    : sandbox === null
      ? spine[spineIndex]!
      : hasSpecificity(sandbox)
        ? specificityText[sandbox]!
        : null;

  return { sandbox, specificity, mixedSpineQuestions, complete, nextQuestionText };
}
