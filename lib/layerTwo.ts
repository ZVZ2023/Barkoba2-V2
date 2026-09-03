import type { PhaseOneSandbox } from "./phaseOne";
import type { GameLanguage, QuestionLogEntry } from "./types";

// ---------------------------------------------------------------------------
// V2.8.5 — Layer Two Reasoning Engine. V2.8.5 ENGINE-CONTRACT CORRECTION —
// six defects fixed after independent review of the original combined patch;
// each fix is called out at its own site below with "CORRECTION —".
//
// NOT an ordered questionnaire, taxonomy walk, or candidate list. A
// scope-aware constrained branch graph: dimensions generate possible
// questions; propositions test one claim; branches become legal only through
// SUFFICIENT (stable) evidence; typical evidence may rank hypotheses but
// never lock a branch; IS-IS is contested evidence and never becomes YES or
// NO. Phase One (lib/phaseOne.ts) remains responsible for sandbox and
// referent scope — this module inherits both and never repeats them.
//
// REPLAY, NOT STORED POSITION — same discipline as lib/phaseOne.ts. There is
// no separate "current Layer Two state" field anywhere in GameRecord. Every
// call derives the complete traversal state fresh from game.qa_log, which is
// what makes reload, correction, and rewind work for free: a correction's
// splitAtTurn() already truncates qa_log, so the very next derivation simply
// sees the shorter log and recomputes the right state — including the one
// sandbox repair, which is undone automatically the instant its turn is
// discarded (CORRECTION 3's requirement).
//
// NO NEW PERSISTED COLUMN, NO MIGRATION. Every field this module reads or
// writes lives inside QuestionLogEntry.racer_output_raw — already a free-form
// JSON string (RacerTurnOutput, serialized verbatim) that flows unchanged
// into corpus.game_turns.raw_output, a jsonb column with no fixed shape. A
// historical (pre-5.0.0) turn's raw_output simply lacks these keys, which
// this module treats as "no Layer Two metadata was ever declared for this
// turn" — never as an invented default.
//
// DETERMINISTIC ENFORCEMENT vs. MODEL GUIDANCE — the load-bearing distinction
// this whole module exists to keep honest:
//   - DETERMINISTIC (this file): hard-parent closure (from ANY stable NO,
//     regardless of question_kind — CORRECTION 6), typical-evidence-cannot-
//     support-or-open-a-child, the one-shot IS-IS operationalization cap
//     (whose YES/NO now genuinely opens/closes the parent — CORRECTION 6),
//     the two-non-progress dimension stall (reactivable only by a genuine
//     audit/operationalization in that exact dimension — CORRECTION 6), the
//     one sandbox repair (now with a real reason/target and a real effect on
//     the active sandbox — CORRECTION 3), the mandatory Living/Place opening
//     gates with their own one-shot IS-IS operationalization (CORRECTION 2),
//     and — new in this correction — MANDATORY METADATA ITSELF: an ordinary
//     model-generated Layer Two question is now rejected outright if it
//     omits a declared dimension, question_kind, proposition_id, or
//     predicate_strength (CORRECTION 1). All of these are checked or
//     computed from DECLARED metadata with no model judgment call involved
//     once that metadata is present and well-formed.
//   - MODEL GUIDANCE ONLY (lib/prompts/racer.ts's card text): which dimension
//     to prioritize next, what a good discriminator looks like, when a
//     Leader/Rival separator is "identified", whether a candidate guess is
//     well-supported, and the SEMANTIC HONESTY of whatever label the model
//     chooses to attach (a model can still declare "stable" for a predicate
//     that is not actually stable — this module cannot and does not judge
//     truthfulness of a well-formed declaration, only its presence and
//     internal consistency with the rest of the ledger).
//   - A LIMIT OF DETERMINISTIC ENFORCEMENT, STATED PLAINLY: CORRECTION 1
//     closes the "omit metadata entirely" escape hatch, but it cannot and
//     does not verify that a declared "stable" predicate is genuinely
//     defining, or that a declared dimension label is the most useful one.
//     Enforcement is mechanical over WHETHER required metadata exists and is
//     well-formed; it is not a semantic judge of whether the model's own
//     labels are honest. That trust model already governs every other Racer
//     contract in this codebase (see racer.ts's own provenance docs) and is
//     not widened or narrowed here.
// ---------------------------------------------------------------------------

export type LayerTwoQuestionKind =
  | "branch_gate"
  | "discriminator"
  | "premise_audit"
  | "operationalization"
  | "adaptive_partition"
  | "guess";

export type PredicateStrength = "stable" | "typical";

export type StructuralEffect =
  | "branch_opened"
  | "branch_closed"
  | "scalar_tightened"
  | "separator_resolved"
  | "none";

export type SandboxRepairReason = "invariant_contradiction" | "structural_dead_end";

/**
 * The Layer-Two-specific fields a turn's raw_output MAY carry, alongside the
 * pre-existing RacerTurnOutput shape. Optional by construction — see the
 * module doc's "no migration" note. Read back out of racer_output_raw by
 * parseLayerTwoMeta(); never a separate persisted field.
 */
export interface LayerTwoMeta {
  dimension: string | null;
  question_kind: LayerTwoQuestionKind | null;
  proposition_id: string | null;
  parent_proposition: string | null;
  predicate_strength: PredicateStrength | null;
  /** Section 8 — true on the one turn that spends the sandbox repair. */
  sandbox_repair: boolean;
  /** CORRECTION 3 — required (non-null) whenever sandbox_repair is true; must be null otherwise. */
  sandbox_repair_reason: SandboxRepairReason | null;
  /** CORRECTION 3 — the proposed replacement sandbox; required (non-null) whenever sandbox_repair is true; must be null otherwise. */
  sandbox_repair_to: PhaseOneSandbox | null;
}

const EMPTY_META: LayerTwoMeta = {
  dimension: null,
  question_kind: null,
  proposition_id: null,
  parent_proposition: null,
  predicate_strength: null,
  sandbox_repair: false,
  sandbox_repair_reason: null,
  sandbox_repair_to: null,
};

const SANDBOX_VALUES = new Set<PhaseOneSandbox>(["living", "physical", "place", "event", "abstract", "unclassified"]);

function isSandboxValue(value: unknown): value is PhaseOneSandbox {
  return typeof value === "string" && SANDBOX_VALUES.has(value as PhaseOneSandbox);
}

function isRepairReason(value: unknown): value is SandboxRepairReason {
  return value === "invariant_contradiction" || value === "structural_dead_end";
}

/** Safe on any string, including one that is not JSON or predates this field set. */
export function parseLayerTwoMeta(rawOutput: string): LayerTwoMeta {
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    return {
      dimension: typeof parsed.dimension === "string" ? parsed.dimension : null,
      question_kind: isQuestionKind(parsed.question_kind) ? parsed.question_kind : null,
      proposition_id: typeof parsed.proposition_id === "string" ? parsed.proposition_id : null,
      parent_proposition:
        typeof parsed.parent_proposition === "string" ? parsed.parent_proposition : null,
      predicate_strength:
        parsed.predicate_strength === "stable" || parsed.predicate_strength === "typical"
          ? parsed.predicate_strength
          : null,
      sandbox_repair: parsed.sandbox_repair === true,
      sandbox_repair_reason: isRepairReason(parsed.sandbox_repair_reason) ? parsed.sandbox_repair_reason : null,
      sandbox_repair_to: isSandboxValue(parsed.sandbox_repair_to) ? parsed.sandbox_repair_to : null,
    };
  } catch {
    return EMPTY_META;
  }
}

function isQuestionKind(value: unknown): value is LayerTwoQuestionKind {
  return (
    value === "branch_gate" ||
    value === "discriminator" ||
    value === "premise_audit" ||
    value === "operationalization" ||
    value === "adaptive_partition" ||
    value === "guess"
  );
}

/**
 * A turn counts as Layer Two's if a model authored it (model_id !== null —
 * Phase One's own deterministic entries never set this) OR it carries our
 * deterministic gate marker. This is how Layer Two finds "its" slice of
 * qa_log without needing Phase One to report a boundary index: the two
 * engines are already mutually exclusive by this same test in reverse
 * (lib/phaseOne.ts's own replay stops the instant it sees a non-null
 * model_id or an unrecognized question).
 */
function isLayerTwoEntry(entry: QuestionLogEntry): boolean {
  if (entry.model_id !== null) return true;
  return rawHasMarker(entry.racer_output_raw, "layer_two_deterministic");
}

function rawHasMarker(raw: string, marker: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.rationale === marker;
  } catch {
    return false;
  }
}

function findPropositionEntry(
  qaLog: readonly QuestionLogEntry[],
  propositionId: string
): QuestionLogEntry | undefined {
  return qaLog.find(
    (e) =>
      e.turn_type === "question" &&
      isLayerTwoEntry(e) &&
      parseLayerTwoMeta(e.racer_output_raw).proposition_id === propositionId
  );
}

// ---------------------------------------------------------------------------
// Structural effect — computed by the ENGINE once an answer exists, never
// declared by the model. This is what keeps "predicate strength declared
// before the Setter answer and cannot be relabeled afterward" true by
// construction: the model commits to predicate_strength before it can
// possibly know the answer, and the effect that answer produces is derived
// here, deterministically, from that prior commitment plus the answer alone.
// ---------------------------------------------------------------------------

export function computeStructuralEffect(
  meta: Pick<LayerTwoMeta, "question_kind" | "predicate_strength">,
  answer: "YES" | "NO" | "AMBIGUOUS"
): StructuralEffect {
  // IS-IS (this app's AMBIGUOUS) is contested evidence. Never locks, opens,
  // or closes anything, regardless of declared kind or strength. Section 5.
  if (answer === "AMBIGUOUS") return "none";

  // Typical evidence never activates descendants and never produces a hard
  // effect — the entire point of the strength axis (section 3). The one
  // exception is premise_audit itself, whose declared JOB is to force a
  // stable determination; a "typical" premise_audit is a contradiction in
  // terms this function does not attempt to rescue — it still yields "none".
  if (meta.predicate_strength !== "stable") return "none";

  switch (meta.question_kind) {
    case "branch_gate":
      return answer === "YES" ? "branch_opened" : "branch_closed";
    case "premise_audit":
      return answer === "YES" ? "branch_opened" : "branch_closed";
    case "discriminator":
      return "separator_resolved";
    case "adaptive_partition":
      return "scalar_tightened";
    case "operationalization":
      return "separator_resolved";
    default:
      return "none";
  }
}

// ---------------------------------------------------------------------------
// Traversal state — replayed fresh from qa_log every call.
// ---------------------------------------------------------------------------

export interface LayerTwoState {
  /** Propositions a hard rejection (stable NO on ANY question kind — CORRECTION 6) has closed. Descendants naming one of these as a parent are illegal. */
  blockedPropositions: Set<string>;
  /**
   * Propositions currently supported ONLY by typical (soft) YES evidence — a
   * child may not name one as its parent. CORRECTION 6 — a typical NO is
   * soft negative evidence, not "support"; it is never added here.
   */
  typicalOnlySupported: Set<string>;
  /** Propositions answered IS-IS that have not been successfully operationalized. */
  contestedPropositions: Set<string>;
  /** How many times each proposition has already been operationalized (capped at 1). */
  operationalizationCount: Map<string, number>;
  /** The dimension of the most recently asked Layer Two question, or null before any. */
  activeDimension: string | null;
  /** Consecutive non-progress questions within the CURRENT active dimension. */
  consecutiveNonProgress: number;
  /**
   * Dimensions currently stalled. CORRECTION 6 — the ONLY way a dimension
   * leaves this set is a premise_audit or operationalization IN THAT EXACT
   * DIMENSION producing genuine (stable, non-"none") structural progress;
   * merely switching away and back, or any other later evidence anywhere
   * else, does not reactivate it. See validateCandidateMove's stalled-
   * dimension check, which is the enforcement side of this same contract.
   */
  stalledDimensions: Set<string>;
  /** The most recent typically-YES-supported "open" proposition in the active dimension, pending an audit before further descent. */
  pendingPremiseAudit: string | null;
  /** Section 8 — true once the one permitted sandbox repair has been used (any answer — YES, NO, or IS-IS all spend it). */
  sandboxRepairUsed: boolean;
  /**
   * CORRECTION 3 — the sandbox Phase One (or the "+1" corridor) originally
   * handed off, BEFORE any repair. Kept alongside activeSandbox specifically
   * so a caller can detect "a repair actually changed something" by
   * comparing the two directly, without depending on some other field
   * (such as racerState.phase_one.sandbox) that the turn route may itself
   * set to activeSandbox for card-selection purposes.
   */
  originalSandbox: PhaseOneSandbox;
  /** CORRECTION 3 — the sandbox actually in effect right now: originalSandbox, unless a repair was declared and answered YES. */
  activeSandbox: PhaseOneSandbox;
  /** CORRECTION 3 — true if the one repair was used and left the departed-from sense contested (IS-IS) rather than resolved either way. */
  repairContested: boolean;
  /** Total Layer Two questions asked so far (guesses/clues excluded). */
  questionsAsked: number;
}

function emptyState(originalSandbox: PhaseOneSandbox): LayerTwoState {
  return {
    blockedPropositions: new Set(),
    typicalOnlySupported: new Set(),
    contestedPropositions: new Set(),
    operationalizationCount: new Map(),
    activeDimension: null,
    consecutiveNonProgress: 0,
    stalledDimensions: new Set(),
    pendingPremiseAudit: null,
    sandboxRepairUsed: false,
    originalSandbox,
    activeSandbox: originalSandbox,
    repairContested: false,
    questionsAsked: 0,
  };
}

/**
 * Replay every Layer Two turn in qa_log and derive the current traversal
 * state. Pure, deterministic, safe to call on every turn-generation request —
 * exactly Phase One's own discipline, applied one layer up.
 *
 * `originalSandbox` is the sandbox Phase One (or the "+1" corridor) handed
 * off — NEVER mutated by this function or anywhere else. `state.activeSandbox`
 * is the REPLAY-DERIVED effective sandbox after accounting for a possible
 * repair (CORRECTION 3); it is what callers must use for card selection and
 * for `racerState.phase_one.sandbox`, while the historical Phase One result
 * itself stays untouched.
 */
export function deriveLayerTwoState(
  qaLog: readonly QuestionLogEntry[],
  originalSandbox: PhaseOneSandbox
): LayerTwoState {
  const state = emptyState(originalSandbox);

  for (const entry of qaLog) {
    if (entry.turn_type === "guess" || entry.turn_type === "concede") continue;
    if (entry.turn_type !== "question") continue;
    if (!isLayerTwoEntry(entry)) continue; // Phase One's own prefix, or a sandbox-clarification entry.

    const meta = parseLayerTwoMeta(entry.racer_output_raw);

    // A pending (unanswered) entry contributes its declared metadata to
    // "current shape" (dimension) but no structural effect yet.
    if (entry.composer_response === null) {
      if (meta.dimension) state.activeDimension = meta.dimension;
      continue;
    }

    // --- CORRECTION 3 — sandbox repair, spent on ANY answer, effective only on YES ---
    if (meta.sandbox_repair && meta.sandbox_repair_to) {
      state.sandboxRepairUsed = true;
      if (entry.composer_response === "YES") {
        state.activeSandbox = meta.sandbox_repair_to;
        state.repairContested = false;
      } else if (entry.composer_response === "AMBIGUOUS") {
        state.repairContested = true;
        // Neither sandbox changes — the departed-from sense stays contested,
        // never silently resolved either way.
      }
      // NO: activeSandbox stays as it was (the original), repair still spent.
    }

    if (meta.question_kind === "operationalization" && meta.parent_proposition) {
      // CORRECTION 6 — an operationalization's effect targets its PARENT,
      // not a proposition of its own: YES hard-supports/opens the parent, NO
      // hard-excludes/blocks it, IS-IS leaves it contested. At most one
      // operationalization is ever counted per proposition (enforced in
      // validateCandidateMove); this only records what happened.
      const parent = meta.parent_proposition;
      const priorCount = state.operationalizationCount.get(parent) ?? 0;
      state.operationalizationCount.set(parent, priorCount + 1);

      if (entry.composer_response === "AMBIGUOUS") {
        state.contestedPropositions.add(parent);
      } else if (entry.composer_response === "YES") {
        state.contestedPropositions.delete(parent);
        state.typicalOnlySupported.delete(parent);
        state.blockedPropositions.delete(parent);
      } else {
        // NO
        state.contestedPropositions.delete(parent);
        state.typicalOnlySupported.delete(parent);
        state.blockedPropositions.add(parent);
      }
    } else {
      // --- parent-closure bookkeeping for an ORDINARY (non-operationalization) move ---
      if (meta.proposition_id && meta.parent_proposition) {
        if (
          state.blockedPropositions.has(meta.parent_proposition) ||
          state.typicalOnlySupported.has(meta.parent_proposition) ||
          state.contestedPropositions.has(meta.parent_proposition)
        ) {
          // An illegal move that nonetheless reached here (e.g. replayed from
          // before this rule existed, or the validator was bypassed) inherits
          // its parent's disqualification rather than being trusted at face
          // value — a child of a blocked branch is blocked too.
          state.blockedPropositions.add(meta.proposition_id);
        }
      }

      if (entry.composer_response === "AMBIGUOUS") {
        if (meta.proposition_id) state.contestedPropositions.add(meta.proposition_id);
      } else if (meta.proposition_id) {
        if (meta.predicate_strength === "typical") {
          // CORRECTION 6 — only a typical YES is soft "support." A typical
          // NO is soft negative evidence, not support for anything, and
          // (like every typical answer) can never produce a hard effect —
          // it adds no enforceable state at all.
          if (entry.composer_response === "YES") {
            state.typicalOnlySupported.add(meta.proposition_id);
          }
        } else if (meta.predicate_strength === "stable" && entry.composer_response === "NO") {
          // CORRECTION 6 — a stable NO hard-excludes the proposition it
          // tested regardless of declared question_kind. Section 2's "hard
          // rejection of a parent blocks every descendant immediately" never
          // depended on the label a branch_gate happened to carry.
          state.blockedPropositions.add(meta.proposition_id);
        }
      }
    }

    // --- progress lease ---
    const effect = computeStructuralEffect(meta, entry.composer_response);
    const dimension = meta.dimension ?? state.activeDimension;

    if (dimension && dimension !== state.activeDimension) {
      state.consecutiveNonProgress = 0;
      state.pendingPremiseAudit = null;
    }
    state.activeDimension = dimension;

    if (effect === "none") {
      state.consecutiveNonProgress += 1;
      // CORRECTION 6 — pendingPremiseAudit tracks a SOFTLY-YES-SUPPORTED
      // proposition specifically (see typicalOnlySupported's own doc); a
      // typical NO never sets it, since there is no attractive branch there
      // to audit.
      if (
        state.consecutiveNonProgress >= 2 &&
        dimension &&
        meta.predicate_strength === "typical" &&
        entry.composer_response === "YES" &&
        meta.proposition_id
      ) {
        state.pendingPremiseAudit = meta.proposition_id;
      }
      if (state.consecutiveNonProgress >= 2 && dimension) {
        state.stalledDimensions.add(dimension);
      }
    } else {
      // Genuine progress resets the lease and clears the stall — including a
      // premise_audit/operationalization's own resolution, which is THE
      // mechanism (and, per CORRECTION 6, the ONLY mechanism) by which a
      // stalled dimension becomes eligible again.
      state.consecutiveNonProgress = 0;
      if (dimension) state.stalledDimensions.delete(dimension);
      state.pendingPremiseAudit = null;
    }

    state.questionsAsked += 1;
  }

  return state;
}

// ---------------------------------------------------------------------------
// Legality — checked BEFORE a candidate move is accepted. A violation throws
// in lib/prompts/racer.ts, exactly like the v2.8.4.3 no-concession check:
// the existing racer_unavailable technical-recovery path, never a fabricated
// outcome. See the module doc's "limit of deterministic enforcement" note —
// this function can only judge what the candidate actually declares.
// ---------------------------------------------------------------------------

export interface LayerTwoCandidate {
  question_text: string;
  dimension: string | null;
  question_kind: LayerTwoQuestionKind | null;
  proposition_id: string | null;
  parent_proposition: string | null;
  predicate_strength: PredicateStrength | null;
  sandbox_repair: boolean;
  sandbox_repair_reason: SandboxRepairReason | null;
  sandbox_repair_to: PhaseOneSandbox | null;
}

export type LayerTwoValidation = { ok: true } | { ok: false; reason: string };

/**
 * CORRECTION 1 — mandatory metadata. Called ONLY for a model-generated
 * ordinary "question" move (never for the deterministic gates, which are
 * code-generated and never pass through here, and never for "guess"/"clue",
 * which retain their pre-existing contract and never reach this function —
 * see lib/prompts/racer.ts's runRacerTurn). Before this correction, all five
 * fields were optional and a model could bypass every deterministic rule
 * simply by omitting them.
 */
function validateMandatoryMetadata(candidate: LayerTwoCandidate): LayerTwoValidation {
  if (!candidate.dimension || candidate.dimension.trim().length === 0) {
    return { ok: false, reason: "missing or empty dimension" };
  }
  if (!isQuestionKind(candidate.question_kind)) {
    return { ok: false, reason: "missing or invalid question_kind" };
  }
  if (!candidate.proposition_id || candidate.proposition_id.trim().length === 0) {
    return { ok: false, reason: "missing or empty proposition_id" };
  }
  if (candidate.predicate_strength !== "stable" && candidate.predicate_strength !== "typical") {
    return { ok: false, reason: "missing or invalid predicate_strength" };
  }
  if (typeof candidate.sandbox_repair !== "boolean") {
    return { ok: false, reason: "missing sandbox_repair boolean" };
  }
  // parent_proposition has no further requirement here: null is a fully
  // valid, common declaration (most propositions have no parent) — its
  // presence in the object (vs. `undefined`) is enforced by TypeScript
  // requiring the field on LayerTwoCandidate, and by the provider schema's
  // own `required` list in racer.ts.
  return { ok: true };
}

/** CORRECTION 3 — sandbox_repair's own internal consistency, checked before the general rules below. */
function validateSandboxRepairDeclaration(candidate: LayerTwoCandidate, state: LayerTwoState): LayerTwoValidation {
  if (candidate.sandbox_repair) {
    if (!candidate.sandbox_repair_reason) {
      return { ok: false, reason: "sandbox_repair is true but sandbox_repair_reason is missing" };
    }
    if (!candidate.sandbox_repair_to) {
      return { ok: false, reason: "sandbox_repair is true but sandbox_repair_to is missing" };
    }
    if (candidate.sandbox_repair_to === state.activeSandbox) {
      return {
        ok: false,
        reason: `sandbox_repair_to ("${candidate.sandbox_repair_to}") must differ from the active sandbox`,
      };
    }
    if (state.sandboxRepairUsed) {
      return { ok: false, reason: "the one permitted sandbox repair has already been used this game" };
    }
  } else {
    if (candidate.sandbox_repair_reason !== null) {
      return { ok: false, reason: "sandbox_repair_reason must be null when sandbox_repair is false" };
    }
    if (candidate.sandbox_repair_to !== null) {
      return { ok: false, reason: "sandbox_repair_to must be null when sandbox_repair is false" };
    }
  }
  return { ok: true };
}

export function validateCandidateMove(
  candidate: LayerTwoCandidate,
  state: LayerTwoState
): LayerTwoValidation {
  // CORRECTION 1 — reject an ordinary Layer Two question outright if it
  // omits mandatory metadata, BEFORE any of the rules below (which all
  // assume well-formed metadata) ever run.
  const metadataCheck = validateMandatoryMetadata(candidate);
  if (!metadataCheck.ok) return metadataCheck;

  const repairCheck = validateSandboxRepairDeclaration(candidate, state);
  if (!repairCheck.ok) return repairCheck;

  // Section 3 — a child proposition is illegal when its parent was
  // hard-excluded, supported only by typical evidence, or answered IS-IS
  // without successful operationalization. Exempt: the move that IS the
  // premise_audit or operationalization targeting exactly that parent —
  // those are how a parent gets upgraded or resolved in the first place.
  if (candidate.parent_proposition) {
    const parent = candidate.parent_proposition;
    const isRepairMove =
      candidate.question_kind === "premise_audit" || candidate.question_kind === "operationalization";
    if (!isRepairMove) {
      if (state.blockedPropositions.has(parent)) {
        return { ok: false, reason: `parent proposition "${parent}" was hard-excluded` };
      }
      if (state.typicalOnlySupported.has(parent)) {
        return {
          ok: false,
          reason: `parent proposition "${parent}" is supported only by typical evidence — a premise_audit is required before descent`,
        };
      }
      if (state.contestedPropositions.has(parent)) {
        return {
          ok: false,
          reason: `parent proposition "${parent}" was answered IS-IS and never successfully operationalized`,
        };
      }
    }
  }

  // V2.8.5 FINAL ENGINE-CONTRACT CORRECTION (finding 3) — the exemption
  // above (a premise_audit/operationalization may target a parent the
  // ordinary rules would otherwise block) is only earned by ACTUALLY being
  // a legitimate repair of that exact parent's state, never merely by
  // carrying one of these two question_kind labels. Without this, a model
  // could relabel any ordinary question as "operationalization" or
  // "premise_audit" against a fabricated or unrelated parent_proposition
  // and walk straight past every hard-parent-closure and stalled-dimension
  // rule below — the labels would be trusted, not verified.
  if (candidate.question_kind === "operationalization") {
    if (!candidate.parent_proposition) {
      return { ok: false, reason: "operationalization requires a non-null parent_proposition" };
    }
    if (!state.contestedPropositions.has(candidate.parent_proposition)) {
      return {
        ok: false,
        reason: `operationalization must target a currently contested (IS-IS) proposition — "${candidate.parent_proposition}" is not contested`,
      };
    }
  }
  if (candidate.question_kind === "premise_audit") {
    if (!candidate.parent_proposition) {
      return { ok: false, reason: "premise_audit requires a non-null parent_proposition" };
    }
    if (!state.typicalOnlySupported.has(candidate.parent_proposition)) {
      return {
        ok: false,
        reason: `premise_audit must target a proposition supported only by typical evidence — "${candidate.parent_proposition}" is not`,
      };
    }
    // When a specific premise audit is actually pending, it is what caused
    // (or matches) the most recent non-progress stall — a different
    // typically-supported proposition, even a genuinely typical-YES one, is
    // not the one this exemption exists for.
    if (state.pendingPremiseAudit && candidate.parent_proposition !== state.pendingPremiseAudit) {
      return {
        ok: false,
        reason: `a premise_audit is specifically pending for proposition "${state.pendingPremiseAudit}" — this audit must target exactly that proposition, not "${candidate.parent_proposition}"`,
      };
    }
  }

  // Section 5 — at most one operationalization per contested proposition.
  if (candidate.question_kind === "operationalization" && candidate.parent_proposition) {
    const count = state.operationalizationCount.get(candidate.parent_proposition) ?? 0;
    if (count >= 1) {
      return {
        ok: false,
        reason: `proposition "${candidate.parent_proposition}" already received its one permitted operationalization`,
      };
    }
  }

  // Section 2 — a stalled dimension must switch (or audit/operationalize the
  // exact contested item that stalled it) before any further ordinary
  // question in that same dimension. CORRECTION 6 — this IS the enforcement
  // side of "reactivation only through a genuine audit/operationalization";
  // nothing else may re-enter a stalled dimension. FINAL CORRECTION (finding
  // 3) — by the time execution reaches here, a candidate whose question_kind
  // is premise_audit/operationalization has ALREADY been required (above) to
  // target a genuinely typicalOnlySupported / contestedPropositions parent
  // (and, when one is pending, the EXACT pendingPremiseAudit proposition) —
  // so this exemption is earned by being a verified, correctly-targeted
  // repair of the applicable proposition, never merely by carrying one of
  // these two labels.
  if (
    candidate.dimension &&
    state.stalledDimensions.has(candidate.dimension) &&
    candidate.question_kind !== "premise_audit" &&
    candidate.question_kind !== "operationalization" &&
    candidate.question_kind !== "guess"
  ) {
    return {
      ok: false,
      reason: `dimension "${candidate.dimension}" is stalled after two non-progress questions — switch dimension, or audit/operationalize the contested proposition first`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Mandatory deterministic opening gates — Living and Place only (sections 10,
// 12). Generated by CODE, exactly like Phase One's own spine questions: zero
// model involvement, localized, scope-aware. CORRECTION 2 — each gate's own
// IS-IS now gets exactly one narrower deterministic operationalization
// (never treated the same as NO), matching section 5's general rule.
// Physical, Event and Abstract have no unconditional first gate and are left
// entirely to card guidance / adaptive routing.
// ---------------------------------------------------------------------------

export type LayerTwoSpecificity = "particular" | "kind" | "mixed" | null;

const LIVING_GATE: Record<GameLanguage, { kind: string; particular: string }> = {
  en: {
    kind: "Does the target name a kind of whole biological organism, rather than a part or product of one?",
    particular:
      "Is this specific target itself a whole biological organism, rather than a part or product of one?",
  },
  hu: {
    kind: "A célpont egy teljes biológiai élőlény fajtáját nevezi meg, nem pedig annak egy részét vagy termékét?",
    particular:
      "Ez a konkrét célpont maga is egy teljes biológiai élőlény, nem pedig annak egy része vagy terméke?",
  },
};

/** CORRECTION 2 — the Living gate's one permitted operationalization on IS-IS. */
const LIVING_GATE_OPERATIONALIZATION: Record<GameLanguage, string> = {
  en: "Narrowing that: does the target's identity, as intended, centrally depend on it being a complete living organism itself — not merely derived from, part of, or produced by one?",
  hu: "Pontosítva: a célpont azonossága lényegében attól függ, hogy maga egy teljes élőlény — nem pedig attól, hogy csak egy élőlényből származik, annak része, vagy terméke?",
};

const PLACE_GATE_EARTH: Record<GameLanguage, string> = {
  en: "Does the target correspond to Earth itself, or to a real physical location on or within Earth?",
  hu: "A célpont maga a Föld, vagy egy valós fizikai helyszín a Földön vagy a Földön belül?",
};

/** CORRECTION 2 — the Earth-membership gate's one permitted operationalization on IS-IS. */
const PLACE_GATE_EARTH_OPERATIONALIZATION: Record<GameLanguage, string> = {
  en: "Narrowing that: setting aside any figurative or symbolic reading, does the target's intended identity refer to a real place that is physically part of Earth?",
  hu: "Pontosítva: minden átvitt vagy jelképes értelmezéstől eltekintve, a célpont szándékolt jelentése egy olyan valós helyre utal, amely fizikailag a Föld része?",
};

const PLACE_GATE_ELSEWHERE: Record<GameLanguage, string> = {
  en: "Does it correspond to a physically real location elsewhere in the universe?",
  hu: "Egy fizikailag valós helyszínnek felel meg máshol a világegyetemben?",
};

/** The dimension/proposition_id labels the deterministic gates use, so the replay-derived state can recognize them by more than question text alone. */
export const GATE_PROPOSITIONS = {
  livingWholeOrganism: "living.whole_organism_gate",
  livingWholeOrganismOp: "living.whole_organism_gate.op1",
  placeEarth: "place.earth_gate",
  placeEarthOp: "place.earth_gate.op1",
  placeElsewhere: "place.elsewhere_gate",
} as const;

function gateEntryMeta(propositionId: string, dimension: string) {
  return {
    dimension,
    question_kind: "branch_gate" as const,
    proposition_id: propositionId,
    parent_proposition: null as string | null,
    predicate_strength: "stable" as const,
    sandbox_repair: false,
    sandbox_repair_reason: null as SandboxRepairReason | null,
    sandbox_repair_to: null as PhaseOneSandbox | null,
  };
}

function operationalizationEntryMeta(propositionId: string, parentProposition: string, dimension: string) {
  return {
    dimension,
    question_kind: "operationalization" as const,
    proposition_id: propositionId,
    parent_proposition: parentProposition as string | null,
    predicate_strength: "stable" as const,
    sandbox_repair: false,
    sandbox_repair_reason: null as SandboxRepairReason | null,
    sandbox_repair_to: null as PhaseOneSandbox | null,
  };
}

type GateOutcome = "yes" | "no" | "contested" | "pending";

interface GateResolution {
  outcome: GateOutcome;
  /** The next question to inject, or null when nothing further is needed for this gate. */
  nextQuestion: { questionText: string; meta: ReturnType<typeof gateEntryMeta> | ReturnType<typeof operationalizationEntryMeta> } | null;
}

/**
 * CORRECTION 2 — a binary gate with exactly one permitted operationalization
 * on IS-IS, shared by Living's whole-organism gate and Place's Earth-
 * membership gate. YES and NO resolve immediately and definitively; IS-IS
 * asks the one narrower question once, and a second IS-IS (on the
 * operationalization itself) leaves the gate CONTESTED forever — never
 * silently resolved to either side, and never a third reformulation.
 */
function resolveBinaryGateWithOneOperationalization(
  qaLog: readonly QuestionLogEntry[],
  gateProposition: string,
  gateDimension: string,
  gateQuestionText: string,
  opProposition: string,
  opQuestionText: string
): GateResolution {
  const gateEntry = findPropositionEntry(qaLog, gateProposition);
  if (!gateEntry) {
    return { outcome: "pending", nextQuestion: { questionText: gateQuestionText, meta: gateEntryMeta(gateProposition, gateDimension) } };
  }
  if (gateEntry.composer_response === null) return { outcome: "pending", nextQuestion: null };
  if (gateEntry.composer_response === "YES") return { outcome: "yes", nextQuestion: null };
  if (gateEntry.composer_response === "NO") return { outcome: "no", nextQuestion: null };

  // AMBIGUOUS on the gate itself — exactly one operationalization.
  const opEntry = findPropositionEntry(qaLog, opProposition);
  if (!opEntry) {
    return {
      outcome: "contested",
      nextQuestion: {
        questionText: opQuestionText,
        meta: operationalizationEntryMeta(opProposition, gateProposition, gateDimension),
      },
    };
  }
  if (opEntry.composer_response === null) return { outcome: "contested", nextQuestion: null };
  if (opEntry.composer_response === "YES") return { outcome: "yes", nextQuestion: null };
  if (opEntry.composer_response === "NO") return { outcome: "no", nextQuestion: null };
  // A second AMBIGUOUS, on the operationalization — contested forever, no third question.
  return { outcome: "contested", nextQuestion: null };
}

/**
 * Living's resolved route: "whole_organism" on gate/operationalization YES,
 * "part_product" on NO, "contested" while unresolved IS-IS, null before the
 * gate is even answered. Exported so lib/prompts/racer.ts can select the
 * correct card text instead of describing both routes unconditionally.
 */
export type LivingRoute = "whole_organism" | "part_product" | "contested" | null;

export function resolveLivingRoute(qaLog: readonly QuestionLogEntry[], specificity: LayerTwoSpecificity): LivingRoute {
  const gateText = specificity === "particular" ? LIVING_GATE.en.particular : LIVING_GATE.en.kind;
  // Language is irrelevant to route resolution (only proposition ids matter),
  // so "en" here is arbitrary — resolveBinaryGateWithOneOperationalization
  // never inspects the text itself except to build a not-yet-asked question.
  void gateText;
  const result = resolveBinaryGateWithOneOperationalization(
    qaLog,
    GATE_PROPOSITIONS.livingWholeOrganism,
    "living.whole_organism",
    "",
    GATE_PROPOSITIONS.livingWholeOrganismOp,
    ""
  );
  if (result.outcome === "yes") return "whole_organism";
  if (result.outcome === "no") return "part_product";
  if (result.outcome === "contested") return "contested";
  return null;
}

/** Place's resolved route, exported for the same reason as LivingRoute. */
export type PlaceRoute = "earth" | "off_earth" | "contested" | null;

export function resolvePlaceRoute(qaLog: readonly QuestionLogEntry[]): PlaceRoute {
  const earthResult = resolveBinaryGateWithOneOperationalization(
    qaLog,
    GATE_PROPOSITIONS.placeEarth,
    "place.earth_membership",
    "",
    GATE_PROPOSITIONS.placeEarthOp,
    ""
  );
  if (earthResult.outcome === "yes") return "earth";
  if (earthResult.outcome === "contested") return "contested";
  if (earthResult.outcome === "pending") return null;
  // "no" -- off-Earth membership itself has no operationalization in this
  // release; the elsewhere gate is asked next but the ROUTE is already off_earth.
  return "off_earth";
}

/**
 * The next mandatory deterministic gate for this sandbox, or null when none
 * applies (Physical/Event/Abstract, the gate(s) already fully resolved, or a
 * game that already reached the model before this gate existed). Mirrors
 * lib/phaseOne.ts's nextQuestionText contract: the caller injects this
 * WITHOUT calling the model, exactly like a Phase One spine question.
 *
 * `sandbox` is the ACTIVE sandbox to gate (originalSandbox, unless a
 * successful repair changed it — see lib/layerTwo.ts's own LayerTwoState
 * doc); `originalSandbox` is Phase One's own historical result, UNCHANGED
 * by any repair. The caller (the turn route) must derive Layer Two state
 * and pass its `activeSandbox` here, not the raw Phase One result, or a
 * repair into Living/Place would silently skip that sandbox's gate — see
 * the V2.8.5 FINAL ENGINE-CONTRACT CORRECTION's finding 2.
 */
export function nextMandatoryGate(
  qaLog: readonly QuestionLogEntry[],
  sandbox: PhaseOneSandbox,
  originalSandbox: PhaseOneSandbox,
  specificity: LayerTwoSpecificity,
  language: GameLanguage
): { questionText: string; meta: ReturnType<typeof gateEntryMeta> | ReturnType<typeof operationalizationEntryMeta> } | null {
  // COMPATIBILITY — "existing v2.8.4.3 games must remain replayable" and
  // "do not reinterpret historical Phase Two turns through new metadata they
  // never possessed." A game already mid-Phase-Two before this gate existed
  // must never have the gate retroactively inserted.
  //
  // V2.8.5 FINAL ENGINE-CONTRACT CORRECTION (finding 2) — this guard must
  // NOT apply when a successful sandbox repair is what just made `sandbox`
  // Living/Place: the repaired sandbox is brand new territory this game has
  // never faced a gate for, regardless of how many ordinary Layer Two
  // questions happened under its PREVIOUS (originalSandbox) sandbox. Only a
  // game whose gated sandbox equals its original, never-repaired sandbox
  // gets the legacy grandfather treatment.
  const wasRepaired = sandbox !== originalSandbox;
  if (!wasRepaired) {
    const alreadyReachedModel = qaLog.some((e) => e.turn_type === "question" && e.model_id !== null);
    if (alreadyReachedModel) return null;
  }

  if (sandbox === "living") {
    const gateText = specificity === "particular" ? LIVING_GATE[language].particular : LIVING_GATE[language].kind;
    const result = resolveBinaryGateWithOneOperationalization(
      qaLog,
      GATE_PROPOSITIONS.livingWholeOrganism,
      "living.whole_organism",
      gateText,
      GATE_PROPOSITIONS.livingWholeOrganismOp,
      LIVING_GATE_OPERATIONALIZATION[language]
    );
    return result.nextQuestion;
  }

  if (sandbox === "place") {
    const earthResult = resolveBinaryGateWithOneOperationalization(
      qaLog,
      GATE_PROPOSITIONS.placeEarth,
      "place.earth_membership",
      PLACE_GATE_EARTH[language],
      GATE_PROPOSITIONS.placeEarthOp,
      PLACE_GATE_EARTH_OPERATIONALIZATION[language]
    );
    if (earthResult.nextQuestion) return earthResult.nextQuestion;
    if (earthResult.outcome === "yes" || earthResult.outcome === "contested") return null;
    if (earthResult.outcome === "pending") return null;
    // "no" -- ask the elsewhere gate, exactly once, no operationalization of its own.
    const askedElsewhere = findPropositionEntry(qaLog, GATE_PROPOSITIONS.placeElsewhere);
    if (!askedElsewhere) {
      return {
        questionText: PLACE_GATE_ELSEWHERE[language],
        meta: gateEntryMeta(GATE_PROPOSITIONS.placeElsewhere, "place.elsewhere_membership"),
      };
    }
    return null;
  }

  return null;
}

export { isLayerTwoEntry };
