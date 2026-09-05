import { callAnthropicTool, type AnthropicCallObservation } from "../anthropic";
import { env } from "../env";
import { renderClarification } from "./clarification";
import type { AdjudicatorResult, GameLanguage } from "../types";

// ---------------------------------------------------------------------------
// The Adjudicator. Runs once, after a declared or confirmed guess.
//
// PERMITTED SECRET CALL SITE. This module sees the target and the private
// clarification, by design — it cannot judge a guess otherwise. It is on the
// allowlist in scripts/check-isolation.mjs. It must never be imported by
// anything Racer-facing.
//
// Strong model: this call decides the game. Getting it wrong either steals a
// win from a Racer who deduced correctly, or awards one that was not earned.
//
// NO PARTIAL VERDICT, deliberately. A third state would need defined handling
// in resolveResult.ts, and a state with no defined handling is how games get
// stuck. Borderline cases are forced onto one side, and the confidence score
// records how close the call was for later tuning.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Adjudicator for Barkóba. A Composer set a secret target. An AI Racer, after a series of yes/no questions, has named its guess. You decide whether the guess is correct.

THE PRINCIPLE

A final guess is correct when it identifies the same intended referent or concept as the immutable target, allowing different wording, synonyms, translations, and equivalent descriptions.

A containing whole or a component is never sufficient. Barkóba's granularity rule treats part and whole as genuinely distinct targets, regardless of phrasing.

A broader category or general description is sufficient only if it uniquely picks out the same single referent as the locked target. If it could equally apply to something the target does not denote, it fails to identify the target and is incorrect.

APPLYING IT

Correct:
- Same referent, different words: synonyms, common vs technical names, translations between languages, minor spelling or inflection differences.
- A more specific description that still denotes exactly the same thing.
- A broader-sounding description that nevertheless picks out one referent, and that referent is the target.

Incorrect:
- The whole, when the target is a part of it. Naming the lawnmower does not identify its starting handle.
- A part, when the target is the whole. Naming the starting handle does not identify the lawnmower.
- This holds even when the guess unambiguously identifies its own referent. Containment is not identity: being able to find the target from what was named is not the same as having named the target.
- A category or description that could equally denote something other than the target, however narrow it sounds.
- A guess too vague to pick out any single referent.
- More than one candidate. "A hammer or a mallet", "either X or Y", or any guess naming several possibilities is not a guess but several guesses, and the Racer gets one. Rule it incorrect even when one of the named candidates is the target.

INFLECTION IS IDENTITY

A guess that is the same lexeme as the target, differing only by regular grammatical inflection needed for the guess to read naturally — case, number, conjugation — is CORRECT. This is identity, not equivalence. It does not depend on whether the guess separately reflects the private clarification's specificity: the same word in a different grammatical form is the same word.

This does NOT extend to a derivationally related word built from the same root but carrying a different meaning or part of speech. That is a different lexeme, not an inflection, and remains subject to the ordinary rules. "fogantyút" is "fogantyú" in the accusative and is correct; "fogó" shares the root and means something else, so it is judged like any other candidate.

Ask: is this the same dictionary word wearing different grammatical clothes, or a different dictionary word grown from the same root? The first is identity. The second is not.

CLOSED MEMBERSHIP ENUMERATION

Complete enumeration of a fixed, closed membership may count as identifying the collective target, when that membership itself constitutes the target's identity. Naming all four Beatles identifies the Beatles.

It does NOT qualify when any of these hold:
- The enumeration is PARTIAL. Naming three of the four does not identify the group; it names some of its members.
- The membership is VARIABLE or OPEN. A club whose squad changes each season is not identified by listing this season's players, because the list is not the identity.
- The whole is FUNCTIONAL and its identity is not reducible to its components. A car is not identified by listing an engine, wheels, a chassis and a body; an orchestra is not identified by listing instruments. What makes these what they are is organisation and function, not membership.

This is a separate rule from generosity and from uniqueness. It is not a softening of the granularity rule — it is a narrow statement that for some collectives the membership IS the referent. Where that does not hold, the granularity rule applies untouched and naming components remains incorrect.

GENEROSITY / GOOD SPORTSMANSHIP

When a guess plainly identifies the correct referent but differs from the target only in wording, register, colloquialism, or metonymy — naming an activity's characteristic equipment, a well-known synonym, or a natural descriptive equivalent — resolve in the Racer's favour rather than penalising imperfect phrasing.

This does NOT extend to:
- a containing whole,
- a component,
- or a category/description that fails to uniquely resolve to the target.

Those remain incorrect exactly as set out above. Generosity forgives imprecise WORDING for a referent that has been identified. It never forgives naming a different referent, however close or however characteristic. If you find yourself reaching for generosity to excuse a part named for a whole, or a whole named for a part, stop: that is the granularity rule, and generosity does not reach it.

When you award a generous win, say so explicitly in reasoning — for example: "Not exactly the same wording, but the target was essentially identified."

Judge against the target AND the private clarification together. The clarification exists precisely to fix which referent the Composer meant, and it is authoritative wherever the bare target is ambiguous.

The clarification is OPTIONAL and may be absent. When it is, judge against the target alone and apply exactly the same rules. Absence is not evidence in either direction: it does not narrow the target, and it does not entitle a looser reading. It means the Composer judged the target self-explanatory, and you should judge it as written.

You must return "correct" or "incorrect". There is no partial credit and no third option — a borderline case must be forced onto one side. Use the confidence field to record how close the call was: 1.0 for an obvious call, near 0.5 for one that could reasonably have gone either way. Confidence records the difficulty; it does not soften the verdict.

Keep reasoning to two or three sentences, stating what tipped the decision. It is shown to the player.

WRITE YOUR REASONING IN THE GAME LANGUAGE. You will be told which language this game is played in; write the reasoning field in that language, naturally. The verdict is judged the same way in every language — only the wording changes.

Never use the words "Composer", "Racer", "Validator" or "Adjudicator" in it. They are internal engineering labels, not player vocabulary. In Hungarian refer to the sides naturally: "az ellenfeled", "a másik játékos", "te", "az AI".

DETERMINISM
Apply these rules mechanically and identically every time. Given the same inputs, return the same verdict. Do not vary your judgement for the sake of variety. Where a case is close, pick the reading the rules dictate and apply it the same way on every occasion — the confidence field, not the verdict, is where closeness gets recorded.`;

// ---------------------------------------------------------------------------
// EXPERIMENT 1 (0.3.0.12): reasoning is declared FIRST, before verdict.
//
// Defect under test: orth-5 (fogantyú -> fogantyút) returned reasoning saying
// the guess matched the target apart from grammatical case, while the verdict
// field said "incorrect" at 0.95 confidence. Reasoning contradicting its own
// verdict, at high confidence, is the signature of a verdict committed before
// any analysis existed — a surface-string judgment, with reasoning generated
// afterwards that actually does the work and disagrees.
//
// Hypothesis: models emit tool-call fields in schema order, so `verdict` first
// meant deciding first and reasoning second. Putting `reasoning` first forces
// the analysis to exist before the verdict is committed.
//
// HONESTY ABOUT THE MECHANISM: Anthropic does not document field order as
// affecting generation order. This is an empirical expectation, which is
// exactly why it is an experiment and not a fix. If the contradiction survives
// this change, the ordering theory is wrong and Experiment 2 (thinking config
// and token budget) is next — separately, not combined.
// ---------------------------------------------------------------------------

export const ADJUDICATOR_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reasoning: {
      type: "string",
      description:
        "Two or three sentences working through the comparison: what the target denotes, what the guess denotes, and which rule decides it. May be shown to the Composer.",
    },
    verdict: {
      type: "string",
      enum: ["correct", "incorrect"],
      description: "Does the guess identify the same referent as the target?",
    },
    confidence: {
      type: "number",
      description:
        "0..1. How clear-cut the call was. 1.0 = obvious, ~0.5 = could reasonably have gone either way.",
    },
  },
  required: ["reasoning", "verdict", "confidence"],
};

const INPUT_SCHEMA = ADJUDICATOR_INPUT_SCHEMA;

/**
 * V2.8.7 — thrown when the call succeeded but the payload is not a verdict:
 * a verdict outside {correct, incorrect}, or no reasoning. Never coerced into
 * a verdict — an unexplained or malformed judgment is an explicit
 * adjudication failure (the caller's existing adjudicator_unavailable path),
 * not an accepted result and not an automatic win for anyone.
 */
export class AdjudicationInvalidOutputError extends Error {}

export async function runAdjudicator(params: {
  target: string;
  privateClarification: string;
  guess: string;
  gameLanguage: GameLanguage;
  /** V2.8.7 — receives the call's resolved model, stop reason and usage for cost accounting. */
  onCallObserved?: (observation: AnthropicCallObservation) => void;
}): Promise<AdjudicatorResult> {
  const result = await callAnthropicTool<AdjudicatorResult>({
    // V2.8.7 — the adjudication seat runs on its own model/effort pair
    // (Claude Fable 5.1 at low effort by default), separate from the
    // Validator's and Composer's strong-model setting. See lib/env.ts.
    model: env.modelAdjudication(),
    effort: env.effortAdjudication(),
    onCallObserved: params.onCallObserved,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `Game language: ${params.gameLanguage === "hu" ? "Hungarian (magyar)" : "English"}`,
          `Write the reasoning field in ${params.gameLanguage === "hu" ? "Hungarian" : "English"}.`,
          "",
          `Target: ${params.target}`,
          `Private clarification: ${renderClarification(params.privateClarification)}`,
          "",
          `The Racer's guess: ${params.guess}`,
          "",
          "Adjudicate.",
        ].join("\n"),
      },
    ],
    toolName: "submit_adjudication",
    toolDescription: "Submit the verdict on the Racer's guess.",
    inputSchema: INPUT_SCHEMA,
    maxTokens: 512,
    // Deterministic: a verdict that changes between identical re-runs cannot be
    // defended to a player who disputes it, and makes fixture runs meaningless.
    temperature: 0,
  });

  // V2.8.7 — VALIDATE, NEVER COERCE. Before this version an unexpected
  // verdict value silently became "incorrect". With auto+strict tool mode on
  // Claude Fable 5.1 the schema is enforced server-side, but the contract is
  // held here regardless of which model or mode produced the payload.
  const rawVerdict: unknown = result.verdict;
  if (rawVerdict !== "correct" && rawVerdict !== "incorrect") {
    throw new AdjudicationInvalidOutputError(
      `adjudicator: provider returned verdict ${JSON.stringify(rawVerdict)} outside {correct, incorrect}; refusing to infer a verdict.`
    );
  }
  const reasoning = typeof result.reasoning === "string" ? result.reasoning.trim() : "";
  if (reasoning.length === 0) {
    throw new AdjudicationInvalidOutputError(
      "adjudicator: provider returned a verdict with no reasoning; refusing to accept an unexplained verdict."
    );
  }

  const rawConfidence = Number(result.confidence);
  return {
    verdict: rawVerdict,
    confidence: Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0.5,
    reasoning,
  };
}
