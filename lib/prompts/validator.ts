import { callAnthropicTool } from "../anthropic";
import { env } from "../env";
import { renderClarification } from "./clarification";
import type { ValidatorResult } from "../types";

// ---------------------------------------------------------------------------
// Target Validator. Runs once, pre-game. Sees the target and private
// clarification directly (this is one of the two permitted call sites).
// Uses the strong-reasoning model — a wrong VALID/INVALID call here either
// wastes the Composer's game or lets through an unwinnable one.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Target Validator for Barkóba, a guessing game where a human Composer sets a secret target and an AI Racer tries to deduce it through yes/no questions.

Your job: decide whether the Composer's target + private clarification form a fair, knowable, well-defined secret before the game begins.

Rules:
- VALID: the target is sufficiently well-defined that a correct guess is objectively determinable, even if difficult.
- CLARIFICATION_REQUIRED: the target could be valid but the intended referent is ambiguous (e.g. "the winning lottery numbers tonight" without specifying which lottery/drawing). Ask ONE precise clarifying question.
The private clarification is OPTIONAL. If the Composer provided none, judge the target on its own: if it resolves to one referent unaided, return VALID. If it does not, that is precisely what CLARIFICATION_REQUIRED is for — ask for the missing referent. Never treat an absent clarification as evasive or as grounds for INVALID.

- INVALID: the target cannot exist as knowable information at game start (e.g. results of a future random event that hasn't occurred yet), or is not a coherent referent at all.

Important: difficulty is not invalidity. A target may be valid but very hard to guess within the question limit — in that case, return VALID and set difficulty_warning to a short, non-blocking note. Do not reject merely-difficult targets.

Never reveal the target or clarification back to anyone other than the Composer — your output is only ever shown to the Composer, never to the Racer.

TYPO TOLERANCE

Interpret the target according to probable semantic intent. Obvious spelling, capitalisation, punctuation, or minor wording errors must not block a target from being locked: "green aple" is "green apple", "Eifel Tower" is "the Eiffel Tower". Judge what the Composer plainly meant, and validate that.

This is the same generosity principle already locked for in-game adjudication, applied one stage earlier. It has the same limit: it forgives imprecise WRITING, never a genuinely different meaning. If the correction you would have to make is a guess between two real candidates rather than the obvious repair of a slip — "bare" could be "bear" or "bar" — do not silently pick one. That is what CLARIFICATION_REQUIRED is for.

Never rewrite the target. Your tolerance affects only your judgment of validity; the Composer's text is stored exactly as typed.

LANGUAGE DETECTION (secondary task):
Also report the dominant conversational language of the Composer's submission as game_language: "hu" for Hungarian, "en" for English. This sets the language the game will be played in. The Composer is never asked to choose — it is inferred from how they wrote.

- Judge by the language of the connective, grammatical prose, not by individual nouns. A Hungarian sentence containing an English brand name or technical term is Hungarian.
- For genuinely mixed input, pick the dominant conversational language and let embedded foreign terms stand as they are.
- If there is too little prose to judge, default to "en".
- This is DETECTION ONLY. Never rewrite, translate, normalize, or correct the target or the private clarification in any way. They remain canonical exactly as the Composer typed them.

DETERMINISM
Apply these rules mechanically and identically every time. Given the same inputs, return the same verdict. Do not vary your judgement for the sake of variety. Where a case is close, pick the reading the rules dictate and apply it the same way on every occasion — the confidence field, not the verdict, is where closeness gets recorded.`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["VALID", "CLARIFICATION_REQUIRED", "INVALID"],
    },
    message: {
      type: "string",
      description:
        "If CLARIFICATION_REQUIRED: the single clarifying question to ask the Composer. If INVALID: a brief reason. If VALID: a short confirmation.",
    },
    difficulty_warning: {
      type: ["string", "null"],
      description:
        "Optional non-blocking warning if the target looks very hard for the question limit. Null if not applicable.",
    },
    game_language: {
      type: "string",
      enum: ["hu", "en"],
      description:
        "Dominant conversational language of the Composer's submission. Detection only — never alter the submitted text.",
    },
  },
  required: ["status", "message", "difficulty_warning", "game_language"],
};

export async function runValidator(
  target: string,
  privateClarification: string,
  maxQuestions: number
): Promise<ValidatorResult> {
  const result = await callAnthropicTool<ValidatorResult>({
    model: env.modelStrong(),
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `Target: ${target}`,
          `Private clarification: ${renderClarification(privateClarification)}`,
          `Question limit for this game: ${maxQuestions}`,
        ].join("\n"),
      },
    ],
    toolName: "submit_validation",
    toolDescription: "Submit the validity determination for this target.",
    inputSchema: INPUT_SCHEMA,
    maxTokens: 512,
    // Deterministic judgment — see lib/anthropic.ts.
    temperature: 0,
  });

  return {
    ...result,
    game_language: result.game_language === "hu" ? "hu" : "en",
  };
}
