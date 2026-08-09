// ---------------------------------------------------------------------------
// Barkóba V1 — core types
//
// IMPORTANT ISOLATION INVARIANT:
// SecretRecord must never be imported by, or passed into, any code path that
// builds a prompt for the Racer. Only lib/secretStore.ts's two named getters
// (getSecretForValidation, getSecretForAdjudication) may read it.
//
// M3 adds a second, stricter layer: the Racer prompt builder does not accept
// GameRecord at all — it accepts RacerPublicState, an explicit narrowing.
// If GameRecord ever grows a leaky field, the Racer does not inherit it
// silently; someone has to edit toRacerPublicState() on purpose.
// ---------------------------------------------------------------------------

export type GamePhase =
  | "pending_validation" // target submitted, awaiting Validator result
  | "clarification_required" // Validator asked for a tighter referent
  | "questioning" // Q&A loop in progress
  | "guess_pending_confirmation" // reserved for Phase 2 human-Racer mode — see docs/DESIGN-NOTES.md
  | "resolving" // GUESS or CONCEDE declared, awaiting Adjudicator/Integrity Review
  | "complete"; // game over, result recorded

export type ComposerAnswer = "YES" | "NO" | "AMBIGUOUS";

/**
 * Who is playing a seat. Recorded from 0.3.0.1 onward so that stored games
 * carry their own configuration rather than having it inferred from whatever
 * the code happened to do at the time.
 *
 * In the 0.3.x series these are ALWAYS composer_kind="human", racer_kind="ai".
 * Nothing branches on them yet, and nothing should until 0.6.x — see
 * docs/DESIGN-NOTES.md §9 for the specific control-flow coupling that has to
 * change before an AI Composer or a human Racer is possible.
 */
export type ParticipantKind = "human" | "ai";

// --- 0.6.x: AI Composer vs Human Racer -------------------------------------

/**
 * How hard the AI Composer should make the target.
 *
 * These describe DEDUCTIVE DISTANCE, never obscurity. The AI has a vastly
 * larger knowledge pool than any human player and must not use it to win.
 */
export type Difficulty = "easy" | "medium" | "hard";

/** Only offered on Hard. Easy and Medium always run as "none". */
export type ClueMode = "none" | "minimal" | "progressive";

/**
 * The language the game is conducted in. Detected once, by the Validator,
 * from the Composer's own words — there is no language-selection screen and
 * no extra model call. This governs the LANGUAGE OF PLAY only. It is not a
 * UI locale and there is no i18n layer behind it.
 */
export type GameLanguage = "hu" | "en";

export type RacerAction = "question" | "guess" | "concede";

export type GuessDetectorMethod = "heuristic" | "classifier";

/**
 * How a flagged guess was resolved. In V1 the Racer is an AI with forced
 * structured output, so there is no human on that side of the table to show a
 * confirmation control to. A flag is resolved by re-prompting the Racer
 * itself. The human Composer never sees this exchange.
 */
export type GuessIntentOutcome = "confirm_guess" | "continue_questioning";

/**
 * One row in the game log. Deliberately over-provisioned with dormant,
 * nullable fields so Z-Score, Warning Triangle, or other post-hoc metrics
 * can be populated later without a schema migration. None of these dormant
 * fields are read or written by V1 logic — they exist only so future work
 * doesn't have to touch stored records.
 */
export interface QuestionLogEntry {
  id: string;
  /**
   * Sequential turn number, 1-based, unique within a game.
   *
   * This is NOT a question counter and must not be used as one. `question_count`
   * on GameRecord is the single authoritative record of charged questions. The
   * two diverge on purpose: a free AMBIGUOUS answer advances turn_index without
   * advancing question_count, as does a question swapped in after a Guess
   * Detector flag. Anything that needs "how many questions has this cost?" reads
   * question_count; anything that needs "which turn was this?" reads turn_index.
   */
  turn_index: number;
  turn_type: RacerAction;
  /**
   * The AI participant's raw tool output for this turn, whichever seat it
   * occupies: the Racer's move in 0.3.x, the Composer's answer in 0.6.x.
   * The field name predates role inversion and is kept to avoid churning a
   * schema that is otherwise correct.
   */
  racer_output_raw: string;
  /** Denormalized from racer_output_raw so readers never re-parse JSON to render a thread. */
  question_text: string | null;
  guess_text: string | null;
  composer_response: ComposerAnswer | null;
  ambiguous_explanation: string | null;
  guess_detector_flagged: boolean;
  guess_detector_method: GuessDetectorMethod | null;
  timestamp: string; // ISO 8601

  // --- M3: guess-intent resolution (only set when guess_detector_flagged) ---
  guess_intent_outcome: GuessIntentOutcome | null;
  /**
   * Optional steer from an AI Composer, attached to any answer type. Null
   * unless clue_mode is "minimal" or "progressive". Distinct from
   * ambiguous_explanation, which explains why a binary answer would mislead
   * and exists in both directions of play.
   */
  clue_text: string | null;
  /** True when this AMBIGUOUS answer consumed a question credit (free cap exhausted). */
  ambiguous_consumed_credit: boolean;

  // --- dormant in V1: present in schema, unused until explicitly defined ---
  quality_score: number | null; // Z-Score successor
  information_gain: number | null;
  strategy_classification: string | null;
  integrity_flag: string | null; // candidate Warning-Triangle successor
  confidence: number | null;
  latency_ms: number | null;
}

// --- M4: resolution ---------------------------------------------------------

export type AdjudicatorVerdict = "correct" | "incorrect";
export type IntegrityVerdict = "upheld" | "violated";

/** What the AI Composer locks in before questioning begins. */
export interface ComposerTargetResult {
  target: string;
  /** The hidden definition fixing exactly what the target means. */
  definition: string;
  reasoning: string;
}

/** One answer from the AI Composer. */
export interface ComposerAnswerResult {
  reasoning: string;
  answer: ComposerAnswer;
  /** Set only when the answer is AMBIGUOUS. */
  ambiguous_explanation: string | null;
  /** Set only when clue_mode permits it. */
  clue_text: string | null;
}

export interface AdjudicatorResult {
  verdict: AdjudicatorVerdict;
  /** 0..1. Recorded for tuning; does not gate the verdict in V1. */
  confidence: number;
  reasoning: string;
}

export interface IntegrityReviewResult {
  verdict: IntegrityVerdict;
  /** turn_index values of answers found to contradict the target. Evidence. */
  contradicting_turns: number[];
  reasoning: string;
}

/**
 * Audit trail for a corrected answer. Internal diagnostics only — deliberately
 * NOT shown to the Integrity Review, which judges the corrected branch as the
 * only branch. Correcting a mistap is ordinary play, and a reviewer told about
 * it would be inclined to read it as evidence of something.
 */
export interface CorrectionRecord {
  at: string; // ISO 8601
  turn_index: number;
  from: ComposerAnswer;
  to: ComposerAnswer;
  /** How many downstream turns were discarded as a result. */
  discarded_turns: number;
}

export type GameResult =
  | "racer_correct"
  | "racer_incorrect"
  | "composer_win_integrity_upheld"
  | "racer_win_integrity_violation"
  | null;

/**
 * Public game state. Safe to send to the client. Contains no target
 * information whatsoever. Note that this is still NOT what the Racer
 * receives — see RacerPublicState.
 */
export interface GameRecord {
  game_id: string;
  phase: GamePhase;
  created_at: string;
  expires_at: string;
  max_questions: number;
  /** Language of play, detected once at creation. Never renegotiated mid-game. */
  game_language: GameLanguage;
  /** Always "human" in the 0.3.x series. Recorded, never branched on. */
  composer_kind: ParticipantKind;
  /** "ai" in 0.3.x (human Composer), "human" in 0.6.x (AI Composer). */
  racer_kind: ParticipantKind;
  /**
   * Set only when the AI is the Composer. Null in 0.3.x games, where the
   * human chose the target and difficulty is not a meaningful concept.
   */
  difficulty: Difficulty | null;
  /** Only ever non-"none" on Hard. Null in 0.3.x games. */
  clue_mode: ClueMode | null;
  question_count: number;
  /** Total AMBIGUOUS answers given, free and costed alike. */
  ambiguous_count: number;
  qa_log: QuestionLogEntry[];
  final_action: RacerAction | null;
  final_guess_text: string | null;
  result: GameResult;
  integrity_notes: string | null;
  /**
   * turn_index values the Integrity Review found contradictory.
   *
   * Deliberately a NEW field rather than QuestionLogEntry.integrity_flag, which
   * is the dormant Warning-Triangle successor and stays untouched until that
   * feature is explicitly commissioned.
   */
  integrity_flagged_turns: number[] | null;
  adjudication_notes: string | null;
  /**
   * THE SINGLE DECLASSIFICATION POINT.
   *
   * Null for the entire life of the game. Written exactly once, by
   * /api/game/[id]/resolve, at the transition to phase "complete", so the
   * result screen can show the target without the game page ever gaining
   * access to secretStore. If you are reading this because you want the target
   * somewhere else: do not widen this. Add another deliberate, auditable
   * declassification point, or reconsider the requirement.
   */
  revealed_target: string | null;
  /** Corrected answers, newest last. Diagnostics only. */
  corrections: CorrectionRecord[];
  /**
   * Turn sequences discarded by a rewind, newest last.
   *
   * Kept for diagnostics and structurally invisible to gameplay: the Racer
   * reads only qa_log via toRacerPublicState(), and the Integrity Review reads
   * only qa_log. Neither can reach this field, so an abandoned branch cannot
   * influence a question or a verdict.
   */
  abandoned_branches: QuestionLogEntry[][];
  clarification_prompt: string | null; // set when phase = clarification_required
}

/**
 * Secret game state. Never reaches the Racer. Stored under a separate KV
 * key/namespace from GameRecord so the two can never be accidentally
 * serialized together into one API response.
 */
export interface SecretRecord {
  game_id: string;
  target: string;
  private_clarification: string;
  locked_at: string | null; // set once questioning begins; target becomes immutable
}

export interface ValidatorResult {
  status: "VALID" | "CLARIFICATION_REQUIRED" | "INVALID";
  message: string; // clarifying question, or reason for invalidity
  difficulty_warning: string | null; // non-blocking warning, per spec
  /**
   * Dominant conversational language of the Composer's submission. Detection
   * only — the Validator must never rewrite, normalize, or translate the
   * target or the private clarification, which stay canonical verbatim.
   */
  game_language: GameLanguage;
}

// ---------------------------------------------------------------------------
// Racer-facing types. Everything below is what the Racer is allowed to know.
// ---------------------------------------------------------------------------

export interface RacerTranscriptTurn {
  turn_index: number;
  question: string;
  answer: ComposerAnswer | null;
  ambiguous_explanation: string | null;
}

/**
 * The complete universe of information the Racer receives. Built only by
 * toRacerPublicState() in lib/racerState.ts. Structurally incapable of
 * carrying target data — there is no field for it.
 */
export interface RacerPublicState {
  question_count: number;
  max_questions: number;
  questions_remaining: number;
  /** Language the Racer must play in. Carries no information about the target. */
  game_language: GameLanguage;
  transcript: RacerTranscriptTurn[];
}

export interface RacerTurnOutput {
  action: RacerAction;
  question_text: string | null;
  guess_text: string | null;
  rationale: string;
}

export interface GuessIntentResolution {
  resolution: GuessIntentOutcome;
  guess_text: string | null;
  revised_question: string | null;
}
