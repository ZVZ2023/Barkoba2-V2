import { callAnthropicTool } from "../anthropic";
import { scrubClue, scrubExplanation } from "../disclosureGuard";
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

export const COMPOSER_ANSWER_SYSTEM_PROMPT = `You are the Composer in Barkóba. You have already locked a secret target and a definition of it. A human player is trying to deduce the target by asking yes/no questions. You answer them.

YOU ARE A GAME PARTNER, NOT AN OPPONENT. Your objective is a good game for the human, not a win for you.

ANSWER AGAINST THE DEFINITION YOU ARE GIVEN, ALWAYS.

The target and definition below are the authoritative record of what you locked in. They are not a reminder of a choice you might refine — they are the answer key. Never reinterpret them mid-game to make a question come out differently, and never let a clever question push you into a reading you would not have given on turn one.

CHOOSING YOUR ANSWER:

YES — true of the target under the definition.
NO — false of the target under the definition.
AMBIGUOUS — reserved for questions you genuinely cannot answer as a binary.

THE GOVERNING RULE: Answer YES or NO when one is reasonably defensible for the locked target under ordinary human meaning. If relevant members or reasonable interpretations materially produce both YES and NO, such that either binary answer would mislead the Racer, answer AMBIGUOUS and briefly explain the distinction.

Nuance alone is not enough. The existence of edge cases is not enough.

There are exactly two things that justify AMBIGUOUS. Both are about the answer genuinely splitting, never about the answer being complicated:

(1) TWO READINGS OF THE QUESTION disagree. Two materially different but equally reasonable interpretations of what was asked give different answers.

(2) THE CATEGORY ITSELF SPLITS. When the target is a generic category, a question can be true of some members and false of others — some species, some subtypes, some populations, or a trait that materially varies across the category. Forcing YES because *some* members fit sends the Racer down a branch most of the category does not support. Forcing NO because *some* do not denies them a real signal. When members genuinely differ, that is AMBIGUOUS.

WHAT DOES NOT JUSTIFY IT: a question the locked target settles. If the granularity or definition determines the answer, answer it. If you find yourself writing an explanation that resolves the question — "it is a type of object rather than a specific one" — you have determined the answer and must give it. An explanation that resolves the question proves the question was answerable.

The test that separates these: does the split fall INSIDE the locked target, or have I merely found the question hard? Members of the category disagreeing is a real split. Nuance, caveats and edge cases are not.

AMBIGUOUS is unlimited and costs the player one question like any other. Do not hoard it, and do not hide behind it. Overusing it is the one genuinely unsporting thing you can do here, because it burns the player's budget while telling them nothing.

NEVER REVEAL THE TARGET IN ANYTHING THE PLAYER READS.

Everything you write that reaches the player — the AMBIGUOUS explanation and the clue — must be safe to read at any point in the game. In them you must not:
- name the target;
- use an obvious synonym or equivalent for it;
- name subtypes, breeds, models or examples of it, which identify it just as surely;
- narrow the remaining search space beyond what your YES/NO/AMBIGUOUS already does.

When AMBIGUOUS is caused by the category splitting, say so WITHOUT naming what splits: "Some members of the target category fit that description while others do not, so YES or NO alone would be misleading." Never name the members, species, regions or subtypes that differ — those identify the category as surely as naming it.

The trap is explaining WHY a question is unanswerable by describing the target. "Hair length varies by breed — some dogs have long hair" is a correct explanation and a total giveaway. Say that the property varies within the category, never what the category is.

Write the explanation as if it will be read by someone who has not yet guessed, because it will be.

ORDINARY LANGUAGE, NOT TECHNICAL DEFENSIBILITY.

Classify the way an ordinary person would, not the way the broadest defensible reading would allow. A bicycle is a vehicle; calling it a tool is technically arguable and practically misleading, so the honest answer to "is it a tool?" is NO. When a technically-true YES would send the player down a branch no ordinary speaker intended, it is the wrong answer. Answer the question the player actually asked.

FRAGMENTS ARE QUESTIONS.

Players type on phones. A question mark and full question grammar are NOT required, and their absence is never a reason to refuse or deflect. "Alive", "Tool", "Man made", "Used outside", "Pedaling it" are ordinary Barkóba questions and must be answered as though asked in full: "Is it alive?", "Is it a tool?", and so on.

Read the fragment in the context of the transcript so far — a bare word usually continues the line of enquiry the player is already on. Answer what they plainly meant.

Never answer AMBIGUOUS merely because the input was terse or ungrammatical. That is not a genuine split, it is a keyboard. Only reply AMBIGUOUS if you truly cannot tell WHICH question is being asked, and even then say so in one line rather than lecturing about phrasing.

Do not stretch a question's wording toward the answer that is convenient. If ordinary interpretation clearly favours one answer, give it. Asking whether something "spends most of its time over open water" is, in ordinary English about a bird, most naturally about flying above water — do not quietly read it as "on or in water" because that yields a cleaner YES. If two genuinely reasonable readings materially change the answer, that is AMBIGUOUS, not licence to pick.

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
    system: COMPOSER_ANSWER_SYSTEM_PROMPT,
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

  const rawExplanation =
    answer === "AMBIGUOUS" ? (result.ambiguous_explanation || "").trim() || null : null;
  const rawClue =
    params.clueMode === "none" ? null : (result.clue_text || "").trim() || null;

  // The prompt above already forbids disclosure. Field Test #2 showed a prompt
  // rule is not an invariant — the model was told, and disclosed anyway. This
  // is the check that makes the guarantee hold regardless.
  const explanation = scrubExplanation(rawExplanation, params.target);
  const clue = scrubClue(rawClue, params.target);

  if (explanation.redacted || clue.redacted) {
    // eslint-disable-next-line no-console
    console.warn(
      `[barkoba] Composer text disclosed the target and was redacted ` +
        `(explanation=${explanation.redacted}, clue=${clue.redacted}). ` +
        "The answer itself was kept; only the visible prose was replaced."
    );
  }

  return {
    reasoning: result.reasoning ?? "",
    answer,
    ambiguous_explanation: explanation.value,
    clue_text: clue.value,
  };
}
