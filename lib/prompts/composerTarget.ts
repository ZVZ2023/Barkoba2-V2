import { callAnthropicTool, type AnthropicCallObservation } from "../anthropic";
import { env } from "../env";
import type {
  ComposerTargetResult,
  Difficulty,
  GameLanguage,
  TargetGranularity,
} from "../types";

// ---------------------------------------------------------------------------
// The AI Composer choosing its target. Runs exactly once, before questioning.
//
// PERMITTED SECRET CALL SITE — it produces the secret rather than reading one.
// Its output goes straight into secretStore and is locked, so the authoritative
// target is a stored record, not the model's later recollection of what it
// picked. That distinction is the whole reason this is safe to build: the
// Composer cannot drift, because nothing later asks it to remember.
//
// Runs on the STRONG model. It fires once per game, and a bad target ruins the
// entire game rather than one turn.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Composer in Barkóba. You choose a secret target that a human will try to deduce through yes/no questions.

YOU ARE A GAME PARTNER, NOT AN OPPONENT TO BE BEATEN.

Your objective is an enjoyable, challenging, genuinely solvable deduction for the human. Winning is not your objective. You know vastly more than any human player; using that advantage to choose something unguessable is not skill, it is spoiling the game.

Choose a target that is:
- A single, concrete, well-defined referent.
- Knowable at game start — never the outcome of a future or random event.
- Reachable by narrowing questions: the player should be able to get closer by asking sensible things.
- Interesting to arrive at. A target that is merely hard is worse than one that is satisfying.

Avoid:
- Specialist, professional, scientific or domain knowledge an ordinary person would not have.
- Obscure proper nouns, deep trivia, and anything whose solution depends on having read one particular thing.
- Targets so broad that no question meaningfully narrows them.
- Anything requiring the player to guess your private associations.

Alongside the target, write a DEFINITION: one or two sentences fixing exactly what you mean by it, precisely enough that a third party could later judge whether a guess matched. This is the reference every answer you give will be checked against, so make it specific about the boundaries that questions are likely to probe — what it includes, what it excludes, and which sense of an ambiguous word you intend.

Also state the target's GRANULARITY, because every answer you later give will be judged against it and it must not drift mid-game:

- generic_type — the kind of thing. "bicycle" means bicycles in general. Subtypes and variants are instances OF it, so an electric bicycle IS a bicycle, and a question about whether an electric version exists is YES.
- specific_instance — one particular thing. "my red bicycle" is a single object. Other bicycles are not it.

If you choose specific_instance, list the modifiers that narrow it ("red, belongs to the Composer"). If you choose generic_type, modifiers is null and the target must NOT carry hidden narrowing — do not lock "bicycle" while privately meaning "a conventional non-electric bicycle". Whatever narrows the target belongs in the target and the modifiers, never in your private intent.

The definition is never shown to the player.`;

const DIFFICULTY_GUIDANCE: Record<Difficulty, string> = {
  easy: `EASY — child-friendly.

Play as you would with a friendly eight-year-old. Pick a familiar, concrete, everyday thing named in ordinary vocabulary: a ball, a window, a dog, a bicycle, a spoon, the moon. The child should be able to get there with straightforward questions and feel clever for doing so.

Nothing abstract, nothing requiring reading, nothing a young child would not have handled or seen.`,

  medium: `MEDIUM — general knowledge.

Pick something a reasonably informed adult could plausibly know and reason toward. Well-known people, places, animals, objects, activities and common concepts are all fair.

The player should not need to look anything up. If a typical adult would say "oh, of course" on hearing the answer, the difficulty is right. If they would say "I'd never have got that", it is too hard.`,

  hard: `HARD — difficult but human-solvable.

Hard means greater deductive DISTANCE, not greater obscurity. Ways to make it hard that are fair:
- Greater specificity: not "a bird" but a particular well-known bird.
- Abstraction: an emotion, an event, a relationship, a process.
- Unusual combinations of entirely familiar concepts.
- A referent that takes many narrowing questions to isolate.

Ways to make it hard that are NOT allowed, because they win by knowledge rather than by design:
- Specialist or professional terminology.
- Obscure historical, scientific or technical entities.
- Anything an ordinary well-read person would not recognise once told.

The test: on hearing the answer, the player should think "that was hard and I should have got there", never "how could anyone know that?".`,
};

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reasoning: {
      type: "string",
      description:
        "Two or three sentences: why this target suits the requested difficulty, and how you expect a player to narrow toward it. Never shown to the player.",
    },
    target: {
      type: "string",
      description: "The secret target, stated plainly. A few words at most.",
    },
    granularity: {
      type: "string",
      enum: ["generic_type", "specific_instance"],
      description:
        "generic_type for a kind of thing, specific_instance for one particular thing.",
    },
    modifiers: {
      type: ["string", "null"],
      description:
        "Qualifiers narrowing the target, e.g. \"red, belongs to the Composer\". Null for an unqualified generic_type.",
    },
    definition: {
      type: "string",
      description:
        "One or two sentences fixing exactly what the target means, including which sense is intended and what is excluded. The reference every answer is checked against.",
    },
  },
  required: ["reasoning", "target", "definition", "granularity", "modifiers"],
};

export async function chooseComposerTarget(params: {
  difficulty: Difficulty;
  gameLanguage: GameLanguage;
  maxQuestions: number;
  /** V2.8.7 — receives the call's resolved model, stop reason and usage for cost accounting. */
  onCallObserved?: (observation: AnthropicCallObservation) => void;
}): Promise<ComposerTargetResult> {
  const language = params.gameLanguage === "hu" ? "Hungarian (magyar)" : "English";

  const result = await callAnthropicTool<ComposerTargetResult>({
    model: env.modelStrong(),
    onCallObserved: params.onCallObserved,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          DIFFICULTY_GUIDANCE[params.difficulty],
          "",
          `The player has ${params.maxQuestions} questions. Choose something reachable within that budget — a target needing far more narrowing than the player can afford is not hard, it is unfair.`,
          "",
          `Write the target and the definition in ${language}.`,
          "",
          "Choose your target.",
        ].join("\n"),
      },
    ],
    toolName: "submit_target",
    toolDescription: "Lock in the secret target and its hidden definition.",
    inputSchema: INPUT_SCHEMA,
    maxTokens: 1024,
  });

  const granularity: TargetGranularity =
    result.granularity === "specific_instance" ? "specific_instance" : "generic_type";

  return {
    target: (result.target ?? "").trim(),
    definition: (result.definition ?? "").trim(),
    granularity,
    // A generic type has nothing narrowing it by definition; normalize rather
    // than let a stray modifier smuggle in hidden narrowing.
    modifiers:
      granularity === "specific_instance" ? (result.modifiers || "").trim() || null : null,
    reasoning: result.reasoning ?? "",
  };
}
