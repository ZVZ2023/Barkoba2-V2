import { callAnthropicTool } from "../anthropic";
import { env } from "../env";
import type { GameLanguage, QuestionEditResult } from "../types";

// ---------------------------------------------------------------------------
// Same-intent check for an edited question.
//
// Exists for one narrow reason: mobile autocorrect. "Do the wheels have
// spokes?" arriving as "The weeks have spikes?" is not a reasoning failure and
// should not cost the player a question. Anything beyond repairing that is a
// new question and must be paid for.
//
// The bar is deliberately strict and the failure is deliberately asymmetric:
// wrongly REJECTING an edit costs one question, wrongly ACCEPTING one gives a
// free extra question every turn. When unsure, reject.
//
// Runs on the cheap model. It is a two-sentence comparison, not a judgment
// about the game.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You decide whether an edited question asks the same thing as the original.

A player typed a question on a phone and it came out wrong — autocorrect, a typo, a slip of grammar. They have corrected it. Your only job is to decide whether the correction repairs how the question was WRITTEN, or changes what it ASKS.

SAME INTENT (accept) — the proposition is unchanged:
- Spelling, punctuation, capitalisation.
- Autocorrect damage: "The weeks have spikes?" -> "Do the wheels have spokes?"
- Grammar repair, or rephrasing that asks the same thing more clearly.
- Adding a missing word that was obviously intended.

DIFFERENT INTENT (reject) — the question now probes something else:
- A different property, category, or candidate.
- Narrowing or broadening what is being asked.
- "Does it have spokes?" -> "Is it a mountain bike?" is a new strategic question.

The test: would a truthful answerer, knowing the secret, be able to give a different answer to the two versions? If yes, the intent changed.

WHEN GENUINELY UNSURE, ANSWER FALSE. A wrongly rejected edit costs the player one question. A wrongly accepted edit hands out a free question on every turn, which breaks the budget the whole game rests on.

Judge only the two texts. You do not know the secret and must not speculate about it.`;

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reasoning: {
      type: "string",
      description: "One sentence: what changed, and whether it changes what is being asked.",
    },
    same_intent: {
      type: "boolean",
      description: "True only if the edit repairs the writing without changing the question.",
    },
  },
  required: ["reasoning", "same_intent"],
};

export async function judgeQuestionEdit(params: {
  original: string;
  edited: string;
  gameLanguage: GameLanguage;
}): Promise<QuestionEditResult> {
  const result = await callAnthropicTool<QuestionEditResult>({
    model: env.modelRacer(),
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `Language: ${params.gameLanguage === "hu" ? "Hungarian" : "English"}`,
          "",
          `ORIGINAL: ${params.original}`,
          `EDITED:   ${params.edited}`,
          "",
          "Same intent, or a new question?",
        ].join("\n"),
      },
    ],
    toolName: "judge_question_edit",
    toolDescription: "Decide whether the edit preserves the question's intent.",
    inputSchema: INPUT_SCHEMA,
    maxTokens: 256,
    temperature: 0,
  });

  return {
    reasoning: result.reasoning ?? "",
    same_intent: result.same_intent === true,
  };
}
