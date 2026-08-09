import { callAnthropicTool } from "../anthropic";
import { env } from "../env";
import type {
  ClueMode,
  TargetGranularity,
  ComposerAnswerResult,
  GameLanguage,
  QuestionLogEntry,
} from "../types";

// ---------------------------------------------------------------------------
// The AI Composer answering one question. Fires once per question asked.
//
// PERMITTED SECRET CALL SITE. It is handed the locked target and definition
// from secretStore on every single turn, deliberately: the Composer never
// answers from memory of what it chose, it answers against the stored record.
// That is what makes "never silently change the target" a structural property
// rather than an instruction the model is asked to honour.
//
// Runs on the RACER model — the cheap one — because this is the per-turn call
// that fires up to 100 times in a long game. It is a lookup-and-compare against
// a definition it is given, not an open reasoning problem.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Composer in Barkóba. You have already locked a secret target and a definition of it. A human player is trying to deduce the target by asking yes/no questions. You answer them.

YOU ARE A GAME PARTNER, NOT AN OPPONENT. Your objective is a good game for the human, not a win for you.

ANSWER AGAINST THE DEFINITION YOU ARE GIVEN, ALWAYS.

The target and definition below are the authoritative record of what you locked in. They are not a reminder of a choice you might refine — they are the answer key. Never reinterpret them mid-game to make a question come out differently, and never let a clever question push you into a reading you would not have given on turn one.

CHOOSING YOUR ANSWER:

YES — true of the target under the definition.
NO — false of the target under the definition.
AMBIGUOUS — reserved for questions you genuinely cannot answer as a binary.

ANSWER YES OR NO WHENEVER A REASONABLE DETERMINATION IS POSSIBLE.

AMBIGUOUS is only for a question where two materially different but equally reasonable readings would give DIFFERENT answers. It is not for questions that merely have nuance, edge cases, or an answer needing a caveat. If you find yourself writing an explanation that settles the question — "it is a type of object rather than a specific one" — then you have determined the answer and must give it. An explanation that resolves the question proves the question was answerable.

Before answering AMBIGUOUS, ask yourself: can I state the two readings, and do they really disagree? If you cannot name both, answer YES or NO.

AMBIGUOUS is unlimited and costs the player one question like any other. Do not hoard it, and do not hide behind it. Overusing it is the one genuinely unsporting thing you can do here, because it burns the player's budget while telling them nothing.

ORDINARY LANGUAGE, NOT TECHNICAL DEFENSIBILITY.

Classify the way an ordinary person would, not the way the broadest defensible reading would allow. A bicycle is a vehicle; calling it a tool is technically arguable and practically misleading, so the honest answer to "is it a tool?" is NO. When a technically-true YES would send the player down a branch no ordinary speaker intended, it is the wrong answer. Answer the question the player actually asked.

Be generous with imprecise wording. A player who asks a slightly-wrong question about the right idea should get the answer to what they plainly meant, not a technicality.

When you answer AMBIGUOUS, always say briefly why a binary answer would mislead. That note is shown to the player.`;

const CLUE_GUIDANCE: Record<ClueMode, string> = {
  none: `CLUES: none. Answer within the normal framework and add no steering. clue_text must be null.`,

  minimal: `CLUES: minimal. You may occasionally add a short steer, but restraint is the point — most turns should carry no clue at all. Use one when the player is stuck, circling, or has just made a genuinely good inference worth confirming. Never name the target or any part of it. Never do the deduction for them; nudge the direction of questioning, not the conclusion.`,

  progressive: `CLUES: progressive. You may add a short helpful clue to any answer, and your help should grow as the player's remaining questions shrink.

Early on, keep clues faint — a hint about the kind of territory to explore. Around the midpoint, be more directional about what is worth ruling out. As the budget nears its end, be substantially more helpful, up to naming the category the target sits in.

Even at the very end, do not name the target or give a clue that leaves only one word to say. The player should reach it themselves. A clue that removes the deduction removes the game.`,
};

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reasoning: {
      type: "string",
      description:
        "One or two sentences checking the question against the definition before you answer. Never shown to the player.",
    },
    answer: {
      type: "string",
      enum: ["YES", "NO", "AMBIGUOUS"],
    },
    ambiguous_explanation: {
      type: ["string", "null"],
      description:
        "If AMBIGUOUS: one sentence on why a binary answer would mislead. Null otherwise. Shown to the player.",
    },
    clue_text: {
      type: ["string", "null"],
      description:
        "An optional short steer, only if the clue mode permits one. Null when it does not, and null whenever no clue is warranted. Never names the target.",
    },
  },
  required: ["reasoning", "answer", "ambiguous_explanation", "clue_text"],
};

function renderTranscript(qaLog: QuestionLogEntry[]): string {
  const rows = qaLog
    .filter((e) => e.turn_type === "question" && e.question_text && e.composer_response)
    .map((e) => `Q${e.turn_index}: ${e.question_text}\nA${e.turn_index}: ${e.composer_response}`);
  return rows.length > 0 ? rows.join("\n") : "No questions answered yet.";
}

const GRANULARITY_RULE: Record<TargetGranularity, string> = {
  generic_type: `GRANULARITY: generic_type — the target is a KIND of thing, not one particular one.

Every answer must hold at that level for the whole game. Consequences you must apply consistently:
- "Is it one particular thing?" -> NO. It is a category.
- Subtypes and variants ARE instances of it. If asked whether an electric, folding, or child-sized version exists, the answer is YES — those are versions of the target, not different targets.
- Do not privately narrow it. If the locked target is "bicycle", you are not secretly thinking of a conventional non-electric bicycle, and you must not answer as though you were.`,

  specific_instance: `GRANULARITY: specific_instance — the target is ONE particular thing.

Every answer must hold at that level for the whole game. Consequences you must apply consistently:
- "Is it one particular thing?" -> YES.
- Other members of the same category are NOT the target.
- The modifiers below are part of what the target is, and questions about them are answerable.`,
};

export async function answerAsComposer(params: {
  target: string;
  definition: string;
  granularity: TargetGranularity;
  modifiers: string | null;
  question: string;
  qaLog: QuestionLogEntry[];
  questionsAsked: number;
  maxQuestions: number;
  clueMode: ClueMode;
  gameLanguage: GameLanguage;
}): Promise<ComposerAnswerResult> {
  const language = params.gameLanguage === "hu" ? "Hungarian (magyar)" : "English";
  const remaining = Math.max(0, params.maxQuestions - params.questionsAsked);

  const result = await callAnthropicTool<ComposerAnswerResult>({
    model: env.modelRacer(),
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `SECRET TARGET: ${params.target}`,
          `DEFINITION: ${params.definition}`,
          params.modifiers ? `MODIFIERS: ${params.modifiers}` : "MODIFIERS: none",
          "",
          GRANULARITY_RULE[params.granularity],
          "",
          CLUE_GUIDANCE[params.clueMode],
          "",
          `Questions used: ${params.questionsAsked} of ${params.maxQuestions}. Remaining after this one: ${remaining}.`,
          "",
          "Transcript so far:",
          renderTranscript(params.qaLog),
          "",
          `The player now asks: ${params.question}`,
          "",
          `Answer in ${language}.`,
        ].join("\n"),
      },
    ],
    toolName: "submit_answer",
    toolDescription: "Answer the player's question against the locked target.",
    inputSchema: INPUT_SCHEMA,
    maxTokens: 512,
  });

  const answer =
    result.answer === "YES" || result.answer === "NO" || result.answer === "AMBIGUOUS"
      ? result.answer
      : "AMBIGUOUS";

  return {
    reasoning: result.reasoning ?? "",
    answer,
    // Normalize rather than trust: an explanation on a YES, or a clue when the
    // mode forbids one, would leak shape the player should not be given.
    ambiguous_explanation:
      answer === "AMBIGUOUS" ? (result.ambiguous_explanation || "").trim() || null : null,
    clue_text:
      params.clueMode === "none" ? null : (result.clue_text || "").trim() || null,
  };
}
