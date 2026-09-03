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
// question for the current state. If the LEADING run of entries doesn't
// match — a different opening question, a non-"question" turn, or a
// model-authored turn (model_id set) before Phase One ever locked a sandbox —
// Phase One reports itself "not applicable" (complete with no sandbox) and
// every turn is untouched, unchanged Phase Two. This makes the feature
// inert-by-construction for any game that did not start inside it, with no
// explicit version/feature-flag check required.
//
// COMPLETION FREEZES THE SUMMARY. The instant the deterministic prefix
// completes (a sandbox locked with no specificity question, or its
// specificity answered), derivation STOPS and returns that summary
// immediately — it never inspects, matches against, or is invalidated by
// anything qa_log holds afterward. Phase Two's own model-authored entries
// come after this point on every game Phase One ever ran for, and the model
// Racer's request depends on this same locked summary reaching it on EVERY
// Phase Two turn, not only the handoff turn — so a model-authored entry must
// never trip the "doesn't match" check above once Phase One is done; that
// check exists only to bound the UNRECOGNIZED-prefix case (V2.8.4 language-
// gate correction's sibling fix).
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
  /** The next deterministic question to ask, or null when `complete`, when a question is already pending an answer, or when `unresolved`. */
  nextQuestionText: string | null;
  /**
   * V2.8.4.1 correction — REFERENT SCOPE, doubly unresolved. True only when
   * IS-IS was given on both the primary referent-scope question and its
   * deterministic clarification. Never true alongside `complete: true` —
   * referent scope is a rule the Setter chooses, not an uncertain fact, so
   * Phase One does not guess a value and hand `specificity: "mixed"` to
   * Phase Two; it stops, asks nothing further, and the caller must not call
   * the provider. The Setter resolves this the ordinary way: correcting one
   * of the two scope answers to a definite YES or NO.
   */
  unresolved: boolean;
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

// ---------------------------------------------------------------------------
// V2.8.4.1 — REFERENT SCOPE. The original specificity wording ("Is it one
// particular X?") was ambiguous about what "particular" meant: "Swiss Army
// knife" reads as more specific than "knife," but it is still a kind/category
// — any matching Swiss Army knife is an acceptable answer. Only "MY Swiss Army
// knife" identifies one uniquely identifiable individual. The new wording asks
// for that distinction directly, and — per the approved fix — is the SAME
// sentence for every sandbox rather than a sandbox-specific variant, since the
// underlying question ("does the correct answer name one unique individual,
// or would any matching example do?") does not actually depend on whether the
// thing is living, physical, a place, or an event.
// ---------------------------------------------------------------------------
const SPECIFICITY_QUESTIONS: Record<GameLanguage, Record<SpecificitySandbox, string>> = {
  en: {
    living: "Does the correct answer need to identify one uniquely identifiable individual?",
    physical: "Does the correct answer need to identify one uniquely identifiable individual?",
    place: "Does the correct answer need to identify one uniquely identifiable individual?",
    event: "Does the correct answer need to identify one uniquely identifiable individual?",
  },
  hu: {
    living: "A helyes válasznak egyetlen, egyedileg azonosítható példányt kell megneveznie?",
    physical: "A helyes válasznak egyetlen, egyedileg azonosítható példányt kell megneveznie?",
    place: "A helyes válasznak egyetlen, egyedileg azonosítható példányt kell megneveznie?",
    event: "A helyes válasznak egyetlen, egyedileg azonosítható példányt kell megneveznie?",
  },
};

/**
 * V2.8.4 (pre-hotfix) wording, kept ONLY so derivePhaseOneState can still
 * recognize a specificity question already asked/pending in an in-progress
 * game's stored qa_log. Never emitted for a new question — see
 * nextQuestionText below, which always reads from SPECIFICITY_QUESTIONS. A
 * game that already has this exact text sitting unanswered keeps working
 * (the player answers it, replay recognizes it, Phase One completes exactly
 * as it would have before this hotfix); a NEW specificity question, for that
 * same game or any other, is always the new referent-scope wording.
 */
const LEGACY_SPECIFICITY_QUESTIONS: Record<GameLanguage, Record<SpecificitySandbox, string>> = {
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

// ---------------------------------------------------------------------------
// V2.8.4.1 CORRECTION — REFERENT SCOPE, RESOLVED NOT GUESSED. The first
// referent-scope hotfix let IS-IS on the primary question complete Phase One
// immediately with specificity "mixed", handing the ambiguity to Phase Two.
// That was wrong: referent scope is a rule the SETTER chooses when writing
// the target, not an external fact the Racer could ever resolve by asking
// more questions. IS-IS on the primary question now asks exactly one more
// deterministic clarification instead; IS-IS on THAT is left fully
// unresolved (see PhaseOneState.unresolved) rather than guessed as "mixed".
// ---------------------------------------------------------------------------
const CLARIFICATION_QUESTIONS: Record<GameLanguage, string> = {
  en: "Would more than one example fully matching the intended target count as a correct answer?",
  hu: "Egynél több, a megadott célpontnak teljesen megfelelő példány is helyes válasznak számítana?",
};

function hasSpecificity(sandbox: PhaseOneSandbox): sandbox is SpecificitySandbox {
  return sandbox === "living" || sandbox === "physical" || sandbox === "place" || sandbox === "event";
}

/**
 * True for the current (new-wording) referent-scope specificity question, in
 * either language. UI-only: lets GameClient show the "my Swiss Army knife" /
 * "a Swiss Army knife" helper text under this specific question without the
 * client needing its own copy of the canonical strings. Deliberately false
 * for the legacy wording — an in-progress game's old pending question does
 * not need (and was never designed with) this helper text.
 */
export function isReferentScopeQuestion(questionText: string): boolean {
  return (
    questionText === SPECIFICITY_QUESTIONS.en.living ||
    questionText === SPECIFICITY_QUESTIONS.hu.living
  );
}

const NOT_APPLICABLE: PhaseOneState = {
  sandbox: null,
  specificity: null,
  mixedSpineQuestions: [],
  complete: true,
  nextQuestionText: null,
  unresolved: false,
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
  const clarificationText = CLARIFICATION_QUESTIONS[language];

  let sandbox: PhaseOneSandbox | null = null;
  let specificity: PhaseOneSpecificity | null = null;
  const mixedSpineQuestions: number[] = [];
  let spineIndex = 0; // 0-based index into `spine`, i.e. how many spine questions are already answered
  // Which of the two referent-scope questions Phase One is currently on.
  // Only ever advances to "clarification" after IS-IS on the primary
  // question, in a game where the clarification genuinely follows (see the
  // legacy-compatibility branch below for the alternative).
  let scopeStage: "primary" | "clarification" = "primary";

  const locked = (): PhaseOneState => ({
    sandbox,
    specificity,
    mixedSpineQuestions,
    complete: true,
    nextQuestionText: null,
    unresolved: false,
  });

  for (let i = 0; i < qaLog.length; i += 1) {
    const entry = qaLog[i]!;
    if (entry.turn_type !== "question" || entry.model_id !== null) return NOT_APPLICABLE;

    if (sandbox === null) {
      if (spineIndex > 4 || entry.question_text !== spine[spineIndex]) return NOT_APPLICABLE;

      if (entry.composer_response === null) {
        // This spine question is asked but not yet answered — nothing to
        // generate; the route's own "pending question" check already keeps
        // callers from reaching here in practice, but replay stays correct
        // either way.
        return { sandbox, specificity, mixedSpineQuestions, complete: false, nextQuestionText: null, unresolved: false };
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
        // Neither has a specificity question, so Phase One is already done:
        // freeze and return now, before any trailing Phase Two entry (which
        // would fail the "question" / model_id === null check above) is ever
        // looked at.
        sandbox = entry.composer_response === "YES" ? "abstract" : "unclassified";
        return locked();
      }
      continue;
    }

    if (hasSpecificity(sandbox) && specificity === null) {
      if (scopeStage === "primary") {
        const legacyText = LEGACY_SPECIFICITY_QUESTIONS[language][sandbox];
        if (entry.question_text !== specificityText[sandbox] && entry.question_text !== legacyText) {
          return NOT_APPLICABLE;
        }
        if (entry.composer_response === null) {
          return { sandbox, specificity, mixedSpineQuestions, complete: false, nextQuestionText: null, unresolved: false };
        }
        if (entry.composer_response === "YES") {
          specificity = "particular";
          return locked();
        }
        if (entry.composer_response === "NO") {
          specificity = "kind";
          return locked();
        }

        // AMBIGUOUS on the primary referent-scope question.
        const next = qaLog[i + 1];
        if (next && next.question_text !== clarificationText) {
          // LEGACY COMPATIBILITY. Something other than the clarification
          // question already follows — proof that Phase One already
          // completed here under the pre-correction rule (IS-IS -> "mixed",
          // handed straight to Phase Two) and Phase Two has already acted on
          // it. That already happened; replay must reproduce it exactly, not
          // retroactively reopen it. (A fresh IS-IS with nothing following
          // yet, or with the clarification question following, falls through
          // to the corrected behavior below instead.)
          specificity = "mixed";
          return locked();
        }
        scopeStage = "clarification";
        continue;
      }

      // scopeStage === "clarification"
      if (entry.question_text !== clarificationText) return NOT_APPLICABLE;
      if (entry.composer_response === null) {
        return { sandbox, specificity, mixedSpineQuestions, complete: false, nextQuestionText: null, unresolved: false };
      }
      if (entry.composer_response === "YES") {
        // More than one fully-matching example would count -> a category.
        specificity = "kind";
        return locked();
      }
      if (entry.composer_response === "NO") {
        // Only one exact instance would count -> a particular.
        specificity = "particular";
        return locked();
      }
      // IS-IS on the clarification too. Referent scope is the Setter's own
      // choice, not an external fact — Phase One does not guess. It stops
      // here: not complete, nothing further to ask, and the caller must not
      // call the provider. See PhaseOneState.unresolved.
      return {
        sandbox,
        specificity: null,
        mixedSpineQuestions,
        complete: false,
        nextQuestionText: null,
        unresolved: true,
      };
    }

    // Unreachable in practice: every branch above already returns the
    // instant Phase One completes or becomes unresolved, so no further loop
    // iteration is ever reached with a locked, specificity-resolved sandbox.
    // Kept as a structural safeguard, not a live path.
    return NOT_APPLICABLE;
  }

  const complete = sandbox !== null && (!hasSpecificity(sandbox) || specificity !== null);
  const nextQuestionText = complete
    ? null
    : sandbox === null
      ? spine[spineIndex]!
      : hasSpecificity(sandbox)
        ? scopeStage === "primary"
          ? specificityText[sandbox]!
          : clarificationText
        : null;

  return { sandbox, specificity, mixedSpineQuestions, complete, nextQuestionText, unresolved: false };
}
