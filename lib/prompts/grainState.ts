import type { RacerTranscriptTurn } from "../types";

// ---------------------------------------------------------------------------
// V2.8.x — REQUIRED-TARGET-GRAIN STATE EXPERIMENT.
//
// STATUS: EXPERIMENTAL CANDIDATE. NOT PROMOTED. NOT PART OF racer/4.0.0.
//
// See docs/v2.8-grok-baseline/grain-state-spec.md for the pre-registered
// hypothesis, exact probe text, and PASS/REJECT/STATE-NEVER-ESTABLISHED
// criteria this module was built to test.
//
// PURE, DETERMINISTIC, NO LLM CALL ANYWHERE IN THIS FILE. This is the load-
// bearing difference from the rejected candidate-validation gate: every
// function here is a total function of already-existing transcript text,
// testable with a plain call, and incapable of "reasoning" its way to a
// wrong answer the way a second model call could. Where the text genuinely
// does not carry a deterministic signal (see requiredGrainCheck's
// generic_type/exact_identity rows), this module says so explicitly rather
// than guessing — see the spec's §3 table for why.
// ---------------------------------------------------------------------------

export type RequiredTargetGrain = "generic_type" | "named_referent" | "exact_identity" | "unset";

export type GrainCheckDecision = "allow" | "block" | "not_deterministically_decidable" | "no_check_unset";

export interface GrainStateResult {
  grain: RequiredTargetGrain;
  established_at_turn: number | null;
  probe: "A" | "B" | null;
  probe_question: string | null;
  probe_answer: "YES" | "NO" | null;
}

export interface GrainCheckResult {
  decision: GrainCheckDecision;
  grain_ok: boolean | null;
  required_grain: RequiredTargetGrain;
  candidate: string;
  reasoning: string;
}

// --- Probe A: kind-vs-particular --------------------------------------------

const PROBE_A_KIND: RegExp[] = [
  /\bis (?:it|the target) (?:a )?(?:general|generic) (?:type|kind|category)(?:,| |\?)/i,
  /\bwould any (?:example|instance|member) of (?:its|the|that) (?:kind|category|type) count\b/i,
];

const PROBE_A_PARTICULAR: RegExp[] = [
  /\bis (?:it|the target) one (?:specific|particular|singular|individual) (?:thing|instance|example|item)\b/i,
  /\bis (?:it|the target) a specific,? one[- ]of[- ]a[- ]kind\b/i,
  /\bis (?:it|the target) (?:a )?unique,? one[- ]of[- ]a[- ]kind\b/i,
];

// --- Probe B: named vs unnamed specific -------------------------------------

const PROBE_B_NAMED: RegExp[] = [
  /\bdoes (?:it|the target) have a (?:proper|well[- ]known|specific|formal) name\b/i,
  /\bis (?:it|the target) (?:commonly |widely |generally )?known by (?:a specific |its own )?name\b/i,
  /\bwould (?:most|many) people recognize (?:it|the target) by name\b/i,
  /\bdoes (?:it|the target) have an? official (?:title|designation|name)\b/i,
];

type Lean = "kind" | "particular" | "named" | "unnamed" | null;

function classifyProbeA(question: string): "kind" | "particular" | null {
  if (PROBE_A_KIND.some((re) => re.test(question))) return "kind";
  if (PROBE_A_PARTICULAR.some((re) => re.test(question))) return "particular";
  return null;
}

function classifyProbeB(question: string): "named" | null {
  if (PROBE_B_NAMED.some((re) => re.test(question))) return "named";
  return null;
}

function resolveLean(kindOrParticular: "kind" | "particular", answer: "YES" | "NO"): "kind" | "particular" {
  // YES on a "kind" framing means generic; NO inverts to particular, and
  // vice versa for the "particular" framing.
  if (kindOrParticular === "kind") return answer === "YES" ? "kind" : "particular";
  return answer === "YES" ? "particular" : "kind";
}

function resolveNamedLean(answer: "YES" | "NO"): "named" | "unnamed" {
  return answer === "YES" ? "named" : "unnamed";
}

/**
 * Scan a transcript, in order, for the FIRST turn where a probe matches AND
 * receives a clean YES/NO. Once found, the state locks — later turns never
 * overwrite it. Returns `unset` if no probe ever matches with a clean answer.
 *
 * Probe B is only meaningful once Probe A has resolved "particular" — but
 * both probes are scanned in a single pass, turn by turn, so whichever
 * genuinely resolves the state FIRST in play order is what locks, exactly
 * matching the spec's "established earlier in the game" framing.
 */
export function deriveRequiredGrain(transcript: readonly RacerTranscriptTurn[]): GrainStateResult {
  let probeAResult: { lean: "kind" | "particular"; turn: number; question: string; answer: "YES" | "NO" } | null =
    null;

  for (const turn of transcript) {
    if (turn.answer !== "YES" && turn.answer !== "NO") continue; // AMBIGUOUS or unanswered: skip, never resolves a probe

    if (!probeAResult) {
      const aClass = classifyProbeA(turn.question);
      if (aClass) {
        const lean = resolveLean(aClass, turn.answer);
        if (lean === "kind") {
          // Probe A alone is sufficient and locks immediately: a "kind" lean
          // has no sub-classification to refine.
          return {
            grain: "generic_type",
            established_at_turn: turn.turn_index,
            probe: "A",
            probe_question: turn.question,
            probe_answer: turn.answer,
          };
        }
        // "particular" lean: hold and keep scanning for a Probe B match,
        // either later in this loop or on a subsequent turn.
        probeAResult = { lean, turn: turn.turn_index, question: turn.question, answer: turn.answer };
        continue;
      }
    }

    if (probeAResult) {
      const bClass = classifyProbeB(turn.question);
      if (bClass) {
        const namedLean = resolveNamedLean(turn.answer);
        return {
          grain: namedLean === "named" ? "named_referent" : "exact_identity",
          established_at_turn: turn.turn_index,
          probe: "B",
          probe_question: turn.question,
          probe_answer: turn.answer,
        };
      }
    }
  }

  if (probeAResult) {
    // Probe A resolved "particular" but Probe B never fired: per the spec,
    // the sub-classification is genuinely unestablished, not defaulted.
    return {
      grain: "unset",
      established_at_turn: null,
      probe: "A",
      probe_question: probeAResult.question,
      probe_answer: probeAResult.answer,
    };
  }

  return { grain: "unset", established_at_turn: null, probe: null, probe_question: null, probe_answer: null };
}

// --- B3: final-guess use -----------------------------------------------------

/**
 * Capitalised tokens that are predicates, not names — the same closed class
 * lib/guessDetector.ts's CAPITALIZED_PREDICATE_STOPWORDS uses, duplicated
 * here rather than imported so this experimental module has no runtime
 * dependency on the production guess-detector (isolation: a change to one
 * must never silently change the other's behavior).
 */
const CAPITALIZED_PREDICATE_STOPWORDS = new Set([
  "American", "British", "English", "Irish", "Scottish", "Welsh", "French",
  "German", "Italian", "Spanish", "Portuguese", "Dutch", "Belgian", "Swiss",
  "Austrian", "Hungarian", "Polish", "Czech", "Slovak", "Romanian", "Serbian",
  "Croatian", "Greek", "Turkish", "Russian", "Ukrainian", "Swedish",
  "Norwegian", "Danish", "Finnish", "Chinese", "Japanese", "Korean", "Indian",
  "Pakistani", "Iranian", "Iraqi", "Israeli", "Egyptian", "Nigerian",
  "Ethiopian", "Australian", "Canadian", "Mexican", "Brazilian", "Argentine",
  "Argentinian", "Cuban", "Vietnamese", "Thai", "Indonesian", "Filipino",
  "European", "Asian", "African", "Scandinavian", "Mediterranean", "Nordic",
  "Baltic", "Balkan", "Western", "Eastern", "Northern", "Southern",
  "Christian", "Catholic", "Protestant", "Orthodox", "Jewish", "Muslim",
  "Islamic", "Hindu", "Buddhist", "Celtic", "Slavic", "Germanic",
]);

/**
 * Does this bare candidate text (a guess_text value, NOT a question) contain
 * a capitalized proper-noun-shaped span? Applied directly to the candidate
 * rather than requiring a question frame, unlike guessDetector's
 * namesABareCandidate — a guess is already a bare noun phrase, not a
 * sentence, so no frame exists to require.
 */
function hasProperNounSpan(candidate: string): boolean {
  const tokens = candidate.trim().split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    const token = raw.replace(/[.,!?;:'"()]+$/g, "").replace(/^[.,!?;:'"()]+/g, "");
    if (!token) continue;
    if (/\d/.test(token)) return true; // a digit settles it, same rule as guessDetector
    const first = token[0];
    if (!first) continue;
    const isCapitalized = first === first.toUpperCase() && first !== first.toLowerCase();
    if (!isCapitalized) continue;
    if (CAPITALIZED_PREDICATE_STOPWORDS.has(token)) continue;
    return true;
  }
  return false;
}

/**
 * Compare a proposed candidate against the already-derived required grain.
 * NEVER reinvents the classification — reads `requiredGrain` as given.
 */
export function checkCandidateGrain(candidate: string, requiredGrain: RequiredTargetGrain): GrainCheckResult {
  if (requiredGrain === "unset") {
    return {
      decision: "no_check_unset",
      grain_ok: null,
      required_grain: requiredGrain,
      candidate,
      reasoning: "required_target_grain was never established from play evidence; no comparison is possible.",
    };
  }

  if (requiredGrain === "named_referent") {
    const ok = hasProperNounSpan(candidate);
    return {
      decision: ok ? "allow" : "block",
      grain_ok: ok,
      required_grain: requiredGrain,
      candidate,
      reasoning: ok
        ? "Candidate contains a capitalized proper-noun-shaped span, consistent with a named referent."
        : "Candidate is a bare lowercase common-noun phrase; a named_referent target requires a proper name, which this candidate lacks.",
    };
  }

  // generic_type and exact_identity: no deterministic textual signal
  // separates a correctly-grained answer from an overly broad one (both are
  // ordinary lowercase noun phrases) — recorded honestly rather than guessed.
  return {
    decision: "not_deterministically_decidable",
    grain_ok: null,
    required_grain: requiredGrain,
    candidate,
    reasoning:
      `required_target_grain is "${requiredGrain}", for which no textual signal in this module ` +
      "distinguishes a correctly-grained candidate from an overly broad one without semantic " +
      "judgment, which this experiment does not use.",
  };
}
