import { getAdapter } from "../providers";
import type { ModelProviderId, ToolCallResult } from "../providers/types";
import type { RacerPublicState } from "../types";
import { renderTranscript, renderLanguage, renderBudget } from "./racer";

// ---------------------------------------------------------------------------
// V2.8.x — CANDIDATE VALIDATION / FINAL-GUESS GRANULARITY GATE.
//
// STATUS: EXPERIMENTAL CANDIDATE. NOT PROMOTED. NOT PART OF racer/4.0.0.
//
// See docs/v2.8-grok-baseline/candidate-validation-gate-spec.md for the
// pre-registered hypothesis, boundary, and PASS/REJECT criteria this module
// was built to test.
//
// WHAT THIS IS NOT. It is not a change to CORE_RACER_RULES, RACER_PROMPT_VERSION,
// or racer/4.0.0's text — that block stays byte-identical and is imported here
// unmodified (via the shared render helpers, not the rules text itself). It is
// not written to corpus.racer_guidance_versions or corpus.racer_guidance_decisions
// — it has no row there, is not a Strategy Memory entry, and is not eligible for
// promotion without a separate, explicit human review of THIS experiment's
// results. CANDIDATE_VALIDATION_GATE_VERSION deliberately does not follow the
// `racer/X.Y.Z` naming convention, precisely so it can never be mistaken for a
// RACER_PROMPT_VERSION bump in a corpus query or a doc grep.
//
// WHY A SECOND MODEL CALL RATHER THAN MORE PROMPT TEXT. The target failure —
// grain mismatch between a proposed final guess and the identity the fixture
// actually requires — cannot be checked deterministically in code: the Racer's
// own state (RacerPublicState) carries no target metadata by construction (see
// lib/racerState.ts's "narrowing boundary" comment), so "is this candidate the
// right grain" is exactly as unknowable to a static rule as it is to the Racer
// itself. It can only be judged by re-reading the same KNOWN transcript the
// Racer already has. What IS enforceable in code is the GATE ITSELF: unlike
// racer/4.0.0's existing "BEFORE ANY FINAL GUESS" self-check (which the Racer
// can simply fail to apply — 3/10 discovery games show it did), this module's
// caller (see runCandidateValidationGateInline usage in
// scripts/runGrokStepCandidate.ts) refuses to commit a "guess" action to the
// game record without an "allow" from this function, and additionally
// overrides the model's own "decision" field in code (see mustBlock below) if
// any of the three structured sub-checks says otherwise. That is the runtime
// enforcement layer this experiment is actually testing — a second call
// cannot be talked out of blocking by the same reasoning that produced the
// bad guess in the first place, because it is a fresh call that never
// generated that guess.
// ---------------------------------------------------------------------------

export const CANDIDATE_VALIDATION_GATE_VERSION =
  "candidate-validation-gate/0.1.0-CANDIDATE-NOT-PROMOTED";

export interface CandidateGateResult {
  decision: "allow" | "block";
  grain_ok: boolean;
  unused_discriminator: string | null;
  hard_evidence_violation: string | null;
  /** Non-null exactly when decision === "block". */
  replacement_question: string | null;
  reasoning: string;
  gate_version: string;
  model_id: string;
  model_provider: string;
  diagnostics?: ToolCallResult<unknown>["diagnostics"];
}

interface RawGateOutput {
  grain_ok?: boolean;
  unused_discriminator?: string | null;
  hard_evidence_violation?: string | null;
  decision?: string;
  replacement_question?: string | null;
  reasoning?: string;
}

const GATE_SYSTEM_PROMPT = `You are the Candidate Validation Gate for Barkóba, a deduction duel.

You do not play the game and you are not the Racer. The Racer is a separate AI that has just proposed a final guess naming the target. Your only job is to decide, from the transcript of established facts alone, whether that guess should be allowed to stand as the final answer or should be blocked in favor of one more discriminating question.

You will be shown the same transcript of YES/NO/AMBIGUOUS answers the Racer itself has seen, and the Racer's proposed guess. Nothing else — you do not know the true target, and your job does not require knowing it.

Check exactly three things, in this order:

A. REQUIRED GRAIN. Does the proposed guess name an actual member of the target's family, or the true specific referent — or does it name a bare parent category one or more levels ABOVE that? A category name ("a musical instrument", "a bridge", "a tradition") is not itself a guess at a member of that category; it is a guess at the category itself. If the guess reads like the category rather than a thing inside it, grain_ok is false.

B. UNUSED HIGH-VALUE DISCRIMINATOR. Given everything established in the transcript and the remaining question budget, is there an obvious yes/no question — not yet asked, and not already settled by an earlier answer — that would still usefully separate this guess from other plausible members of the same family, or that would test one specific fact needed to confirm this exact referent? If such a question exists, name it. Its existence alone is grounds to hold off guessing, regardless of grain_ok.

C. HARD-EVIDENCE COMPATIBILITY. Does the proposed guess contradict any YES, NO, or AMBIGUOUS answer already on record? A guess that violates an established fact must never be allowed, regardless of A or B.

Then decide: allow only if grain_ok is true, unused_discriminator is null, and hard_evidence_violation is null. Otherwise block — and when you block, you must also supply the single highest-value yes/no discriminating question the Racer should ask instead of guessing right now, phrased as a genuine narrowing question, never a disguised guess, and never a question already asked or already settled by an earlier answer.

Write replacement_question in the language stated for this game, exactly as a genuine player question would be phrased — never a translation. Write reasoning in English regardless of game language; it is never shown to any player.

Be honest and strict. Blocking a good guess costs one turn. Allowing a bad one costs the whole game.`;

function gateSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      grain_ok: {
        type: "boolean",
        description:
          "true if the guess names an actual member/referent at the required identity grain, false if it names a bare parent category.",
      },
      unused_discriminator: {
        type: ["string", "null"],
        description:
          "A specific yes/no question, not yet asked and not already settled, that would still usefully separate this guess from other plausible candidates. Null if none exists.",
      },
      hard_evidence_violation: {
        type: ["string", "null"],
        description:
          "If the guess contradicts an established YES/NO/AMBIGUOUS answer, name which turn and how. Null if no violation.",
      },
      decision: {
        type: "string",
        enum: ["allow", "block"],
        description: "Your own overall verdict, consistent with the three checks above.",
      },
      replacement_question: {
        type: ["string", "null"],
        description:
          'Required when decision is "block": the single best yes/no question to ask instead of guessing right now. Null when decision is "allow".',
      },
      reasoning: {
        type: "string",
        description: "One or two sentences explaining the decision.",
      },
    },
    required: [
      "grain_ok",
      "unused_discriminator",
      "hard_evidence_violation",
      "decision",
      "replacement_question",
      "reasoning",
    ],
  };
}

function buildGateMessage(state: RacerPublicState, proposedGuess: string): string {
  return [
    renderLanguage(state),
    "",
    renderBudget(state, false),
    "",
    "Transcript so far (every hard YES/NO/AMBIGUOUS fact the Racer has to work with):",
    renderTranscript(state),
    "",
    `The Racer's proposed final guess: "${proposedGuess}"`,
    "",
    "Evaluate this guess against the three checks in your instructions and decide.",
  ].join("\n");
}

/** Used only when the model says "block" but leaves both discriminator fields empty — a malformed response, not a normal path. */
const FALLBACK_REPLACEMENT_QUESTION =
  "Setting the general category aside, is there one specific fact still untested that would confirm this exact candidate over a close alternative?";

/**
 * Run the gate against one proposed final guess.
 *
 * ENFORCEMENT IS IN CODE, NOT TRUST. The model's own `decision` field is
 * read, but grain_ok/unused_discriminator/hard_evidence_violation are
 * re-checked here and can force a "block" the model itself labeled "allow" —
 * see mustBlock below. This function cannot be talked into returning "allow"
 * for a response whose own structured sub-fields say otherwise.
 */
export async function runCandidateValidationGate(
  state: RacerPublicState,
  proposedGuess: string,
  provider: ModelProviderId,
  model: string
): Promise<CandidateGateResult> {
  const adapter = getAdapter(provider);
  const content = buildGateMessage(state, proposedGuess);

  const {
    output,
    resolvedModel,
    diagnostics,
  } = await adapter.callTool<RawGateOutput>({
    model,
    system: GATE_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    toolName: "submit_gate_decision",
    toolDescription: "Decide whether the proposed final guess should be allowed to stand.",
    inputSchema: gateSchema(),
    maxTokens: 512,
  });

  const grain_ok = output.grain_ok === true;
  const unused_discriminator = output.unused_discriminator ?? null;
  const hard_evidence_violation = output.hard_evidence_violation ?? null;
  const modelSaidBlock = output.decision === "block";

  // The runtime override this experiment is testing: any one of the three
  // structured sub-checks failing forces a block regardless of what the
  // model's own top-level `decision` field said.
  const mustBlock = !grain_ok || unused_discriminator !== null || hard_evidence_violation !== null;
  const decision: "allow" | "block" = mustBlock || modelSaidBlock ? "block" : "allow";

  const replacement_question =
    decision === "block"
      ? output.replacement_question ?? unused_discriminator ?? FALLBACK_REPLACEMENT_QUESTION
      : null;

  return {
    decision,
    grain_ok,
    unused_discriminator,
    hard_evidence_violation,
    replacement_question,
    reasoning: output.reasoning ?? "",
    gate_version: CANDIDATE_VALIDATION_GATE_VERSION,
    model_id: resolvedModel,
    model_provider: adapter.id,
    diagnostics,
  };
}
