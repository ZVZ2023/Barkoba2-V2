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
 * The semantic level of the locked target. Fixed at lock time and never
 * renegotiated, because the failure it prevents is the Composer sliding
 * between readings mid-game — answering one question about the category and
 * the next about a prototypical instance.
 *
 * generic_type      — "bicycle": the kind of thing. Subtypes and variants
 *                     (electric, folding, tandem) are all instances of it, so
 *                     "does it have an electric version?" is YES.
 * specific_instance — "my red bicycle": one particular thing. Variants of the
 *                     category are NOT it.
 */
export type TargetGranularity = "generic_type" | "specific_instance";

/**
 * The language the game is conducted in. Detected once, by the Validator,
 * from the Composer's own words — there is no language-selection screen and
 * no extra model call. This governs the LANGUAGE OF PLAY only. It is not a
 * UI locale and there is no i18n layer behind it.
 */
export type GameLanguage = "hu" | "en";

/**
 * "clue" joined this union in 0.9.8.0 rather than becoming a parallel concept:
 * a clue occupies a turn in the transcript so it needs a turn_type, and the AI
 * Racer selects it the same way it selects question or guess. It is never an
 * answer and never a guess — it spends a clue credit and nothing else.
 */
export type RacerAction = "question" | "guess" | "concede" | "clue";

export type GuessDetectorMethod = "heuristic" | "classifier";

/**
 * V2.5 — WHO produced a model-authored turn, and under which prompt.
 *
 * The V2.5-1 evidence audit found this recorded nowhere. Verified against a
 * real completed game: the only keys in any persisted raw_output are `action`,
 * `guess_text`, `question_text` and `rationale`. The reasoning was durable; the
 * identity of the reasoner was not, which makes fair model-vs-model comparison
 * impossible and every historical game model-ambiguous.
 *
 * DELIBERATELY NOT PART OF RacerTurnOutput OR ComposerAnswerResult. Those types
 * are serialized verbatim into `racer_output_raw` and thence into
 * corpus.game_turns.raw_output, which is defined as the participant's own raw
 * structured output. Provenance is a fact about the CALL, not about the move,
 * and it travels in dedicated columns so raw_output stays exactly what it
 * claims to be. test/corpusEvidence.test.ts pins that key set.
 */
export interface ModelProvenance {
  /**
   * The model the API reported having used, not the alias requested. They
   * differ whenever a configured id resolves to a dated snapshot, and only the
   * resolved one is evidence. Falls back to the requested id if absent.
   */
  model_id: string;
  /** "anthropic" for every call this codebase makes today. */
  model_provider: string;
  /** Bumped by hand in the prompt module. See RACER_PROMPT_VERSION. */
  prompt_version: string;
}

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

  // --- 0.6.0.1: question correction (mobile autocorrect recovery) ---
  /**
   * The question as first submitted, kept when an edit was accepted so the
   * transcript shows what was repaired. question_text holds the correction.
   * Null when the question was never edited.
   */
  original_question_text: string | null;
  edit_status: "accepted" | "rejected" | null;
  /** The judge's one-line reason, for both accepted and rejected edits. */
  edit_reason: string | null;

  // --- V2.5: Game Intelligence provenance ---------------------------------
  //
  // Null on every turn written before 2.5.0.0, and null forever on those turns.
  // That is the honest record: nothing observed them, and a backfill would be
  // inventing data. Analysis must EXCLUDE null-provenance turns from model
  // comparison rather than assume a model for them.

  /** Resolved model that produced this turn. Null when no model authored it. */
  model_id: string | null;
  model_provider: string | null;
  prompt_version: string | null;
  /**
   * When the Composer's answer landed on this entry. ISO 8601.
   *
   * `timestamp` is when the entry was CREATED — for an AI-Racer game, the
   * moment the Racer's question was appended. The answer arrives on a later
   * request and, before 2.5.0.0, left no trace of when. Without this the only
   * derivable quantity was the interval to the next turn, which also contains
   * the model call, so Composer think time and model latency were inseparable.
   */
  answered_at: string | null;
  /**
   * The question as first emitted, before the Guess Detector's intent
   * resolution rewrote it.
   *
   * Both resolution branches destroy the original: `confirm_guess` nulls
   * question_text, `continue_questioning` replaces it. Distinct from
   * `original_question_text`, which records a HUMAN Racer's own typo repair in
   * /ask. These are different events by different actors and must not share a
   * field, or "who changed this question, and why" stops being answerable.
   */
  pre_revision_question_text: string | null;

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
  granularity: TargetGranularity;
  /** Qualifiers that narrow the target, or null if it is unqualified. */
  modifiers: string | null;
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

/** Verdict on whether an edited question asks the same thing. */
export interface QuestionEditResult {
  reasoning: string;
  same_intent: boolean;
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
  /**
   * V2.1.1 — the anonymous Player who started this game, or null.
   *
   * A REFERENCE, not a foreign key: there is no players table for it to point
   * at. The identity lives in a signed cookie held by the client, and this
   * field records which one acted here, inside game state that already expires
   * on its own. That is deliberate — V2.1.1 must not choose the durable store
   * that belongs to V2.2.
   *
   * Null is normal and always will be: identity may be unconfigured, and games
   * created before V2.1.1 never had it.
   */
  player_id: string | null;
  /**
   * V2.3 — who occupies each seat.
   *
   * References, not foreign keys, exactly like `player_id`: there is no players
   * table for the anonymous majority to point at.
   *
   * Until V2.3 a game had at most one human, so "which client renders" and "who
   * is asking" were the same question and `composer_kind`/`racer_kind` answered
   * both. In Human↔Human they are different questions. These two fields are what
   * make role a property of the REQUEST rather than only of the game, and they
   * are the basis of every authorization check in the H↔H routes.
   *
   * Populated for the human seat in the existing single-human modes too, so the
   * seat model has one meaning everywhere rather than a special case.
   */
  composer_player_id: string | null;
  racer_player_id: string | null;
  /**
   * V2.3 — the Human↔Human invitation code, so the Composer can retrieve the
   * link after a refresh. Null in every other mode.
   *
   * Safe to hold here because it is surfaced ONLY through the Composer branch
   * of lib/gameView.ts; no Racer projection includes it. It is an invitation,
   * not a credential — the authoritative guard against a third player is
   * `racer_player_id` already being set.
   */
  join_code: string | null;
  phase: GamePhase;
  created_at: string;
  expires_at: string;
  max_questions: number;
  /** Language of play, fixed at creation. Never renegotiated mid-game. */
  game_language: GameLanguage;
  /**
   * The Validator judged the target to rest on the Composer's private
   * knowledge. Recorded so the result screen can say plainly that adjudication
   * rests on the game record rather than on independent verification.
   */
  private_target: boolean;
  /** Always "human" in the 0.3.x series. Recorded, never branched on. */
  composer_kind: ParticipantKind;
  /** "ai" in 0.3.x (human Composer), "human" in 0.6.x (AI Composer). */
  racer_kind: ParticipantKind;
  /**
   * V2.5-B3 — WHICH AI fills the Racer seat.
   *
   * A string rather than the `ModelProviderId` union on purpose: GameRecord is
   * serialized into Redis and read back by a later deployment, so a record
   * written when a provider existed could be read after it was removed. Storing
   * the narrow type would let a stale record masquerade as valid; storing text
   * and validating on read keeps the record honest about what it actually says.
   *
   * Null means Anthropic — the behaviour of every game recorded before B3, and
   * the value for any game whose Racer is a human. Fixed at creation and never
   * renegotiated: every turn of a game must be played by the same player, or
   * the transcript describes no one.
   *
   * OPERATIONAL STATE ONLY. The durable evidence of who played is
   * corpus.game_turns.model_provider, written per turn since 2.5.0.0. This
   * field exists so turn N+1 reaches the same provider as turn N; it is
   * deliberately NOT mirrored into a corpus column, for the same reason
   * migration 0003 refused a game-mode column — a second source of truth that
   * can drift from the first.
   */
  racer_provider: string | null;
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
   * V2.2 — the Adjudicator's and Integrity Review's own verdicts, kept
   * alongside the derived `result`.
   *
   * `result` is the CONCLUSION of the result table; these are its INPUTS. They
   * are not recoverable from it: "racer_win_integrity_violation" could follow a
   * concede or an incorrect guess, and only these fields say which. Raw
   * evidence, stored as produced.
   */
  adjudicator_verdict: AdjudicatorVerdict | null;
  integrity_verdict: IntegrityVerdict | null;
  /**
   * The Adjudicator's own confidence, 0..1, exactly as produced.
   *
   * Generated on every adjudication since M4 and, until V2.2, discarded by the
   * resolve route despite AdjudicatorResult documenting it as recorded for
   * tuning. Stored raw: never interpreted, normalised or turned into a quality
   * score. Any such reading is derived analysis and belongs in `derived.*`.
   */
  adjudication_confidence: number | null;
  /**
   * THE SINGLE DECLASSIFICATION POINT.
   *
   * Null for the entire life of the game. Written exactly once, by
   * /api/game/[id]/resolve, at the transition to phase "complete", so the
   * result screen can show the target without the game page ever gaining
   * access to secretStore. If you are reading this because you want the target
   * somewhere else: do not widen this. Add another deliberate, auditable
   * declassification point, or reconsider the requirement.
   *
   * V2.2 WIDENED WHAT THIS POINT DECLASSIFIES, NOT HOW MANY POINTS EXIST.
   * The four `revealed_*` companions below carry the target's definition,
   * granularity, modifiers and lock time into public state at the same instant,
   * under the same rule, so that the durable corpus can record what the target
   * actually meant without any second module ever reading secretStore. That was
   * the deliberate alternative to adding lib/corpus/* to
   * PERMITTED_SECRET_IMPORTERS — one declassification seam, widened on purpose,
   * beats two seams that each look reasonable alone.
   *
   * The accepted cost: a game that never resolves never declassifies, so
   * abandoned games carry no target metadata at all. Isolation outranks
   * research completeness.
   */
  revealed_target: string | null;
  /** The hidden definition that fixed the target's meaning. See revealed_target. */
  revealed_definition: string | null;
  /** generic_type vs specific_instance — the granularity adjudication rests on. */
  revealed_granularity: TargetGranularity | null;
  /** Qualifiers that narrowed the target, or null. */
  revealed_modifiers: string | null;
  /** When the target became immutable. */
  revealed_locked_at: string | null;
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

  // --- V2.5: benchmark identity -------------------------------------------
  //
  // PROSPECTIVE ONLY. corpus.games is immutable once finalized, and 0003's
  // exemption list covers participant unlink and collection_context alone.
  // A finalized game therefore cannot be tagged retroactively, and the
  // exemption list is deliberately not being widened to allow it. Retroactive
  // designation of an existing game belongs in derived.*.
  //
  // Set at creation, from a server-secret-gated header, so an ordinary client
  // cannot mark its own game as a benchmark and pollute the comparison set.

  /** Which benchmark case this run instantiates. Null is ordinary play. */
  benchmark_case_id: string | null;
  /** Groups repeated runs of one case. Minted server-side; never client-supplied. */
  benchmark_run_id: string | null;
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
  /**
   * Locked with the target. Null for 0.3.x games, where a human chose the
   * target and no AI is answering repeatedly against it.
   */
  granularity: TargetGranularity | null;
  /** e.g. "red, belongs to the Composer". Null when there are none. */
  modifiers: string | null;
  locked_at: string | null; // set once questioning begins; target becomes immutable
}

export interface ValidatorResult {
  status: "VALID" | "CLARIFICATION_REQUIRED" | "INVALID";
  message: string; // clarifying question, or reason for invalidity
  difficulty_warning: string | null; // non-blocking warning, per spec
  /**
   * True when the target's identity rests on facts only the Composer can know
   * — a personal acquaintance, a private object, a family memory.
   *
   * This is a WARNING, never a rejection. Barkóba's Composer owns the target.
   */
  private_knowledge: boolean;
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
  /**
   * Clues already given, in turn order. Empty when the game has no clue mode,
   * and empty for every record written before 0.9.8.0 — clue turns simply do
   * not exist in those logs, so nothing needs migrating.
   */
  clues: RacerClueTurn[];
  /** Clue requests still available. Zero means the action is not offered at all. */
  clue_credits_available: number;
}

export interface RacerClueTurn {
  turn_index: number;
  clue: string;
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
