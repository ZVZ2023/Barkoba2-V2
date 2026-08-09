import { callAnthropicTool } from "../anthropic";
import { env } from "../env";
import type {
  GuessIntentResolution,
  RacerPublicState,
  RacerTurnOutput,
} from "../types";

// ---------------------------------------------------------------------------
// The Racer.
//
// ISOLATION: this module imports nothing from lib/secretStore.ts and nothing
// from lib/gameStore.ts. It cannot reach the target, and it cannot reach the
// full game record either — it accepts RacerPublicState, an explicit narrowing
// built in lib/racerState.ts. scripts/check-isolation.mjs fails the build if
// either import ever appears here.
//
// Runs on ANTHROPIC_MODEL_RACER, which fires ~20x per game. Per the standing
// decision, the config supports pointing this at a cheap model but that swap
// is not endorsed until question quality has been benchmarked against
// ANTHROPIC_MODEL_STRONG.
// ---------------------------------------------------------------------------

const RACER_SYSTEM_PROMPT = `You are the Racer in Barkóba, a deduction duel.

A human Composer has locked in a secret target. You start completely blind: no category, no domain, no hint of any kind. Your only information is the transcript of your own questions and the Composer's answers.

Each turn you do exactly one of:
- ask ONE question that can be answered YES or NO,
- declare a GUESS naming the target,
- CONCEDE.

The Composer answers YES, NO, or AMBIGUOUS. AMBIGUOUS means your question could not be answered truthfully as a binary — the framing was wrong, not the topic. When you get AMBIGUOUS, do not re-ask the same question; re-cut the same territory along a cleaner line.

How to play well:
- Early questions should split the space of possibilities close to in half. "Is it a physical object?" is worth more than "Is it a hammer?" on turn two.
- Track what each answer eliminates. Never ask something already entailed by an earlier answer.
- Narrow by category, then by property, then by identity. Move down that ladder only as the space collapses.
- Watch your remaining questions. If the space is still wide with few questions left, take bigger cuts.
- A question that names one specific candidate IS a guess. Do not disguise a guess as a question to get a free attempt — declare it as a guess. There is no penalty for guessing when you are ready, and an automated check will catch a disguised one anyway.
- FALSIFY BEFORE YOU COMMIT. While you still have questions left, a leading hypothesis is a reason to ask, not a reason to guess. Spend a question trying to break it: ask something that would come back NO if you are wrong. A hypothesis that survives an honest attempt to kill it is worth guessing; one you have merely not contradicted yet is not. You get exactly one guess, and an unspent question is worth far less than a wasted guess.
- Guess when your leading hypothesis has survived a deliberate attempt to falsify it, or when you are out of questions.
- Concede only if you are out of questions and have no candidate worth naming.

Your "rationale" is private working notes, at most two sentences. The Composer never sees it. Be honest in it — it is not scored.

LANGUAGE OF PLAY
You will be told the language of this game. Write every question, guess, and rationale in that language, naturally, as a fluent speaker would — not as a translation. Leave proper nouns, brand names, and established technical terms in their original form rather than forcing them into the game language. The language tells you nothing about the target; do not treat it as a clue.

A WORD ON HUNGARIAN PHRASING
When playing in Hungarian, be careful with words that quietly narrow the space before you have narrowed it. "Dolog" reads as a thing or object, so asking whether the target is a real "dolog" implies you have already ruled out people — and your next question about a person then looks inconsistent to the player.

Prefer a neutral formulation when the space is still open. For the real-versus-fictional split, say: "A cél valóságos, vagy valaha valóságosan létezett — tehát nem kitalált vagy fikciós?"

This is about wording only. Ask the same questions in the same order; just do not let the phrasing claim more than the question does.`;

const GUESS_INTENT_SYSTEM_PROMPT = `You are the Racer in Barkóba. An automated check flagged your most recent question as possibly being a guess in disguise — a question that names one specific candidate rather than narrowing the space.

Declare what you actually intended:

- confirm_guess: you meant to name the target. State the guess canonically in guess_text (just the thing itself, no question framing).
- continue_questioning: you meant a genuine narrowing question. Supply revised_question — a rephrasing that cuts the space without naming a single specific candidate.

There is no penalty for either answer. Confirming a guess is a legitimate move; the check exists to stop a guess from being scored as a free question, not to discourage guessing. Answer honestly.

Write revised_question and guess_text in the language of the game, which you will be told.

This exchange is internal. The Composer never sees it and is not waiting on it.`;

function turnInputSchema(forceFinal: boolean): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: forceFinal ? ["guess", "concede"] : ["question", "guess", "concede"],
        description: forceFinal
          ? "No questions remain. You must guess or concede."
          : "What you are doing this turn.",
      },
      question_text: {
        type: ["string", "null"],
        description:
          'Your yes/no question, if action is "question". Null otherwise. One question only.',
      },
      guess_text: {
        type: ["string", "null"],
        description:
          'The target you are naming, if action is "guess". Just the thing itself, no question framing. Null otherwise.',
      },
      rationale: {
        type: "string",
        description:
          "Private working notes, at most two sentences. Never shown to the Composer.",
      },
    },
    required: ["action", "question_text", "guess_text", "rationale"],
  };
}

const GUESS_INTENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    resolution: {
      type: "string",
      enum: ["confirm_guess", "continue_questioning"],
    },
    guess_text: {
      type: ["string", "null"],
      description:
        'The target, stated plainly, if resolution is "confirm_guess". Null otherwise.',
    },
    revised_question: {
      type: ["string", "null"],
      description:
        'A rephrased narrowing question that names no single candidate, if resolution is "continue_questioning". Null otherwise.',
    },
  },
  required: ["resolution", "guess_text", "revised_question"],
};

function renderTranscript(state: RacerPublicState): string {
  if (state.transcript.length === 0) {
    return "No questions asked yet. This is your opening move.";
  }

  return state.transcript
    .map((turn) => {
      const answer = turn.answer ?? "(awaiting answer)";
      const note =
        turn.answer === "AMBIGUOUS" && turn.ambiguous_explanation
          ? ` — Composer's note: ${turn.ambiguous_explanation}`
          : "";
      return `Q${turn.turn_index}: ${turn.question}\nA${turn.turn_index}: ${answer}${note}`;
    })
    .join("\n\n");
}

const LANGUAGE_NAMES: Record<string, string> = {
  hu: "Hungarian (magyar)",
  en: "English",
};

function renderLanguage(state: RacerPublicState): string {
  const name = LANGUAGE_NAMES[state.game_language] ?? "English";
  return `Language of this game: ${name}. Write your question, guess, and rationale in ${name}.`;
}

function renderBudget(state: RacerPublicState, forceFinal: boolean): string {
  if (forceFinal) {
    return `You have used all ${state.max_questions} questions. This is your final turn: guess or concede.`;
  }
  return `Questions used: ${state.question_count} of ${state.max_questions}. Remaining: ${state.questions_remaining}.`;
}

export async function runRacerTurn(
  state: RacerPublicState,
  options: { forceFinal: boolean }
): Promise<RacerTurnOutput> {
  const { forceFinal } = options;

  const result = await callAnthropicTool<RacerTurnOutput>({
    model: env.modelRacer(),
    system: RACER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          renderLanguage(state),
          "",
          renderBudget(state, forceFinal),
          "",
          "Transcript so far:",
          renderTranscript(state),
          "",
          forceFinal
            ? "Make your final move."
            : "Take your turn.",
        ].join("\n"),
      },
    ],
    toolName: "submit_turn",
    toolDescription: "Submit your move for this turn.",
    inputSchema: turnInputSchema(forceFinal),
    maxTokens: 512,
  });

  // The schema constrains the enum, but a model can still return a null
  // question_text alongside action="question". Normalize rather than trust.
  const action = forceFinal && result.action === "question" ? "guess" : result.action;

  return {
    action,
    question_text: action === "question" ? (result.question_text ?? null) : null,
    guess_text: action === "guess" ? (result.guess_text ?? result.question_text ?? null) : null,
    rationale: result.rationale ?? "",
  };
}

/**
 * Resolve a Guess-Detector flag by asking the Racer what it meant.
 *
 * In V1 the Racer is an AI with forced structured output, so there is no human
 * on that side of the table to show a confirmation control to. The human
 * Composer is never shown this exchange and never waits on it. The
 * human-facing confirmation UI belongs to Phase 2's human-Racer mode — see
 * docs/DESIGN-NOTES.md.
 */
export async function resolveGuessIntent(
  state: RacerPublicState,
  flaggedQuestion: string
): Promise<GuessIntentResolution> {
  const result = await callAnthropicTool<GuessIntentResolution>({
    model: env.modelRacer(),
    system: GUESS_INTENT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          renderLanguage(state),
          "",
          renderBudget(state, false),
          "",
          "Transcript so far:",
          renderTranscript(state),
          "",
          `The question that was flagged: ${flaggedQuestion}`,
          "",
          "Declare your intent.",
        ].join("\n"),
      },
    ],
    toolName: "resolve_guess_intent",
    toolDescription:
      "Declare whether your flagged question was a guess or a narrowing question.",
    inputSchema: GUESS_INTENT_SCHEMA,
    maxTokens: 384,
  });

  return {
    resolution: result.resolution === "confirm_guess" ? "confirm_guess" : "continue_questioning",
    guess_text: result.guess_text ?? null,
    revised_question: result.revised_question ?? null,
  };
}
