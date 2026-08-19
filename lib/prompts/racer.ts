import { DEFAULT_RACER_PROVIDER, getAdapter } from "../providers";
import { env } from "../env";
import type { ModelProviderId, ToolCallResult } from "../providers/types";
import type {
  GuessIntentResolution,
  ModelProvenance,
  RacerPublicState,
  RacerTurnOutput,
} from "../types";

/**
 * V2.5 — the identity of the Racer's strategy, bumped BY HAND whenever
 * RACER_SYSTEM_PROMPT changes.
 *
 * WHY NOT DERIVE IT FROM commit_sha. The corpus already records app_version and
 * commit_sha, and while one prompt exists per deployment those locate the exact
 * source text and are a working proxy. They stop being one the moment two Racer
 * variants run at a single commit — which is the entire point of V2.5
 * benchmarking, so the proxy expires exactly when it starts to matter.
 *
 * WHY NOT HASH THE PROMPT. A hash changes on a typo fix and says nothing about
 * whether the strategy changed. A deliberate label is a claim someone made on
 * purpose, which is what a benchmark comparison needs to rest on.
 *
 * THE FAILURE MODE THIS CARRIES: a changed prompt with an unbumped constant
 * produces confidently mislabelled evidence, which is worse than no label.
 * Treat bumping this as part of editing the prompt, not as follow-up.
 *
 * V2.7 — `racer/2.7.0` IS A LOAD-BEARING DATABASE CLAIM, NOT A LABEL.
 *
 * It asserts one specific thing about every turn it is stamped on: that the
 * canonical CORE_RACER_RULES block below was present, verbatim, in the message
 * the model actually received. Corpus queries will be run against that claim,
 * so the claim has to be true by construction rather than by discipline.
 *
 * It is made true by assertGuidanceApplied(), which inspects the ASSEMBLED
 * message immediately before the call and throws if the block is missing. A
 * turn cannot therefore be stamped with this version unless the guidance was
 * genuinely there — the call fails first. That converts "someone remembered to
 * bump the constant" into a structural guarantee.
 *
 * THE CLAIM COVERS EVERY PATH THAT CAN AUTHOR THE QUESTION THE HUMAN SEES.
 * There are two: runRacerTurn(), and resolveGuessIntent() when it resolves
 * `continue_questioning` and returns a revised_question that REPLACES the
 * original. Both assemble the block and both are guarded. Covering only the
 * first would make this version true of a draft and false of the record.
 */
export const RACER_PROMPT_VERSION = "racer/2.7.0";

/**
 * V2.7 — THE CANONICAL TRAILING STRUCTURED-DELIBERATION BLOCK.
 *
 * This is the only experimental variable. The system prompt, transcript,
 * provider routing, model selection and call topology remain unchanged. The
 * block stays last before the instruction to act and is shared by both paths
 * that can author the player-facing question.
 *
 * THE TEXT IS CANONICAL. It is reproduced verbatim in docs/DESIGN-NOTES.md §43
 * against `racer/2.7.0`. Editing it without bumping the version breaks the
 * database claim above.
 */
export const CORE_RACER_RULES = `RACER GUIDANCE V2 — STRUCTURED DELIBERATION — APPLY EVERY TURN

Before producing each question, perform this process internally. Emit only one player-facing question after it.

1. RECONSTRUCT
Rebuild the current constraint state from the full transcript. Preserve all YES, NO and AMBIGUOUS evidence.

2. INFER
Derive implications that logically follow from established constraints. Do not treat only explicit answers as knowledge.

3. HYPOTHESIZE
Identify the major classes or candidate families still consistent with the evidence. Do not collapse prematurely onto one attractive candidate.

4. MAP DIMENSIONS
Identify the major independent dimensions capable of dividing the remaining hypothesis space. Possible dimensions include, when relevant: time / era; geography / geopolitical origin; purpose / function; physical form / type; scale / size; status / market position; production context; mechanism / technology; cultural / institutional context. These are examples only. Select dimensions appropriate to the current target class.

5. GENERATE OPTIONS
Internally generate several plausible next questions across useful dimensions.

6. COMPARE
Prefer the question expected to divide the surviving possibilities most efficiently.

Avoid country-by-country enumeration, candidate-by-candidate enumeration, repeating established information, asking a child-level question when a parent-level discriminator is available, and persisting in a hypothesis path after accumulated evidence materially weakens its parent hypothesis.

7. CONSISTENCY GATE
Before emitting the question, internally check: Does this contradict established evidence? Has this already been answered directly or by implication? Am I redundantly re-testing a settled branch? Is another dimension likely to split the remaining space better?

EVIDENCE-RESPONSE BEHAVIOR
YES: Exploit it. Narrow intelligently within the supported branch.
NO: Update the parent hypothesis, not merely the rejected child candidate. Repeated NO evidence within one branch increases pressure to abandon that branch.
AMBIGUOUS: Preserve the ambiguity and reconsider interpretation or dimension. Never silently convert AMBIGUOUS into YES or NO.

BEFORE ANY FINAL GUESS
Internally execute: CANDIDATE → CONSTRAINT CHECK → ALTERNATIVES → DISCRIMINATOR → GUESS.
Check: Does the candidate satisfy every established constraint? What other credible candidates still satisfy them? If more than one remains and questions remain, what question best separates them? Is the evidence strong enough to justify ending the search given the remaining question budget?

Do not guess merely because one candidate feels plausible.`;

/**
 * A Racer turn plus the provenance of the call that produced it.
 *
 * `output` is exactly what it was before and is what gets serialized into
 * racer_output_raw. Provenance rides ALONGSIDE it, never inside it: the V2.5-1
 * audit verified that every persisted raw_output in production carries exactly
 * four keys (action, question_text, guess_text, rationale), and raw_output is
 * defined as the participant's own structured output. A model id is a fact
 * about the call, not a move the Racer made.
 */
export interface RacerTurnResult {
  output: RacerTurnOutput;
  provenance: ModelProvenance;
  /**
   * Raw call facts, where the provider reports them. Unused by the turn loop —
   * present so a diagnostic harness can observe the real code path instead of
   * reimplementing it. See scripts/probeRacerLatency.ts.
   */
  diagnostics?: ToolCallResult<RacerTurnOutput>["diagnostics"];
}

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

Your opponent has locked in a secret target. You start completely blind: no category, no domain, no hint of any kind. Your only information is the transcript of your own questions and their answers.

Each turn you do exactly one of:
- ask ONE question that can be answered YES or NO,
- declare a GUESS naming the target,
- CONCEDE.

Your opponent answers YES, NO, or AMBIGUOUS. AMBIGUOUS means your question could not be answered truthfully as a binary — the framing was wrong, not the topic. When you get AMBIGUOUS, do not re-ask the same question; re-cut the same territory along a cleaner line.

How to play well:
- Early questions should split the space of possibilities close to in half. "Is it a physical object?" is worth more than "Is it a hammer?" on turn two.
- Track what each answer eliminates. Never ask something already entailed by an earlier answer.
- Narrow by category, then by property, then by identity. Move down that ladder only as the space collapses.
- Watch your remaining questions. If the space is still wide with few questions left, take bigger cuts.
- A question that names one specific candidate IS a guess. Do not disguise a guess as a question to get a free attempt — declare it as a guess. There is no penalty for guessing when you are ready, and an automated check will catch a disguised one anyway.
- FALSIFY BEFORE YOU COMMIT. While you still have questions left, a leading hypothesis is a reason to ask, not a reason to guess. Spend a question trying to break it: ask something that would come back NO if you are wrong. A hypothesis that survives an honest attempt to kill it is worth guessing; one you have merely not contradicted yet is not. You get exactly one guess, and an unspent question is worth far less than a wasted guess.
- Guess when your leading hypothesis has survived a deliberate attempt to falsify it, or when you are out of questions.
- Concede only if you are out of questions and have no candidate worth naming.

Your "rationale" is private working notes, at most two sentences. Your opponent never sees it. Be honest in it — it is not scored.

LANGUAGE OF PLAY
You will be told the language of this game. Write every question, guess, and rationale in that language, naturally, as a fluent speaker would — not as a translation. Leave proper nouns, brand names, and established technical terms in their original form rather than forcing them into the game language. The language tells you nothing about the target; do not treat it as a clue.

NEVER USE INTERNAL ROLE NAMES IN WHAT YOU WRITE
Never use the words "Composer", "Racer", "Validator" or "Adjudicator" in anything you write. They are engineering labels for parts of this system, not vocabulary a player should ever read. Keep them out of every question, every guess, and everything else visible.

When you need to refer to the other side in Hungarian, use natural language chosen for the sentence: "az ellenfeled", "a másik játékos", or simply address the player with "te". "Az ellenfeled testének egy része?" is right; "A Composer testének egy része?" is not Hungarian at all.

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

This exchange is internal. Your opponent never sees it and is not waiting on it.`;

function turnInputSchema(forceFinal: boolean, clueAvailable: boolean): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: forceFinal
          ? ["guess", "concede"]
          : clueAvailable
            ? ["question", "clue", "guess", "concede"]
            : ["question", "guess", "concede"],
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
          ? ` — Note: ${turn.ambiguous_explanation}`
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

function renderClues(state: RacerPublicState): string {
  if (state.clues.length === 0) return "Clues given so far: none.";
  const rows = state.clues.map((c) => `Clue (after turn ${c.turn_index}): ${c.clue}`);
  return ["Clues the Composer has given you — treat these as reliable:", ...rows].join("\n");
}

function renderBudget(state: RacerPublicState, forceFinal: boolean): string {
  if (forceFinal) {
    return `You have used all ${state.max_questions} questions. This is your final turn: guess or concede.`;
  }
  return `Questions used: ${state.question_count} of ${state.max_questions}. Remaining: ${state.questions_remaining}.`;
}

/**
 * Assemble the per-turn Racer message.
 *
 * PROVIDER-NEUTRAL BY CONSTRUCTION — note the signature: it takes no provider.
 * That is the parity guarantee, expressed in the type rather than promised in a
 * comment. There is exactly one assembly, so Claude and Grok cannot be handed
 * different strategy text; an adapter may move it between message roles, but it
 * has nothing to differentiate.
 *
 * Exported so tests can inspect what the model is actually given without
 * standing up a transport.
 */
export function buildRacerTurnMessage(
  state: RacerPublicState,
  options: { forceFinal: boolean; clueAvailable: boolean }
): string {
  const { forceFinal, clueAvailable } = options;

  return [
    renderLanguage(state),
    "",
    renderBudget(state, forceFinal),
    "",
    "Transcript so far:",
    renderTranscript(state),
    "",
    renderClues(state),
    clueAvailable
      ? `You may request a clue this turn: action "clue". You have ${state.clue_credits_available} clue request(s) available. It costs no question and no guess, and the Composer will answer it in words rather than yes/no.\n\nBeing allowed to ask is not a reason to ask. Spend one only when you judge that a clue would materially help — when the transcript has stopped narrowing, or you are choosing between hypotheses that your own questions cannot separate. If your next question would make good progress on its own, ask it instead. An unspent credit is not wasted; it keeps accumulating.`
      : "You cannot request a clue this turn.",
    "",
    // V2.7 — THE TRAILING STRATEGY BLOCK. Position remains last
    // before the instruction to act, so a growing transcript never pushes the
    // strategy away from the point of decision.
    //
    // Included on the final turn too. The final-guess gate governs that moment,
    // an unconditional block keeps the guarantee below unconditional as well —
    // a branch here would mean `racer/2.7.0` was true of some turns and not
    // others, which is precisely the ambiguity the version is meant to remove.
    CORE_RACER_RULES,
    "",
    forceFinal ? "Make your final move." : "Take your turn.",
  ].join("\n");
}

/**
 * Assemble the Guess-Intent message.
 *
 * PROVIDER-NEUTRAL, exactly like buildRacerTurnMessage, and for the same
 * reason: it takes no provider argument, so the two transports cannot be handed
 * different guidance on this path either.
 *
 * SINGLE-SOURCED. It reuses CORE_RACER_RULES rather than restating it. A second
 * literal would drift, and two divergent "canonical" blocks under one version
 * string would make the audit claim unfalsifiable.
 */
export function buildGuessIntentMessage(
  state: RacerPublicState,
  flaggedQuestion: string
): string {
  return [
    renderLanguage(state),
    "",
    renderBudget(state, false),
    "",
    "Transcript so far:",
    renderTranscript(state),
    "",
    `The question that was flagged: ${flaggedQuestion}`,
    "",
    // Trailing, as on the turn path. If this resolution produces a revised
    // question, that question is authored here and under this guidance.
    CORE_RACER_RULES,
    "",
    "Declare your intent.",
  ].join("\n");
}

/**
 * THE GUARANTEE BEHIND `racer/2.7.0`.
 *
 * `prompt_version` is written into corpus.game_turns and will be queried as
 * proof that a turn was played under the canonical guidance. A constant stamped
 * beside an assembly it does not actually inspect proves nothing — it would be
 * an assertion about the code, made by the code, checked by nobody.
 *
 * So the claim is verified against the assembled message itself, immediately
 * before the call. A turn cannot be stamped with this version unless the block
 * was genuinely present, because the call raises first.
 *
 * THROWS RATHER THAN WARNS, and rather than silently downgrading the stamp.
 * This can only fire on a code defect — the block is unconditional — and a
 * loud, recoverable turn failure (B4 handles it, with a human retry control) is
 * strictly better than a corpus quietly accumulating turns that claim guidance
 * they never received. Mislabelled evidence is worse than missing evidence.
 */
function assertGuidanceApplied(content: string): void {
  if (!content.includes(CORE_RACER_RULES)) {
    throw new Error(
      `racer: ${RACER_PROMPT_VERSION} claims the CORE RACER RULES block, but the ` +
        `assembled turn message does not contain it. Refusing to stamp provenance ` +
        `that would misdescribe this turn.`
    );
  }
}

/**
 * Which model this call runs on. Both fields are SERVER-RESOLVED — the provider
 * comes from the game record, the model id from the environment. No request may
 * state either, exactly as no request may state a Play Credit price.
 */
function racerModelFor(provider: ModelProviderId): string {
  return provider === "xai" ? env.xaiModelRacer() : env.modelRacer();
}

export async function runRacerTurn(
  state: RacerPublicState,
  options: {
    forceFinal: boolean;
    provider?: ModelProviderId;
    /**
     * Diagnostic seam ONLY, for scripts/probeRacerLatency.ts. Production never
     * passes it, so every Grok turn keeps running at the provider default. This
     * is deliberately NOT routing: nothing here decides what to send, it only
     * carries what a caller already decided.
     */
    reasoningEffort?: string;
  }
): Promise<RacerTurnResult> {
  const { forceFinal } = options;
  const provider = options.provider ?? DEFAULT_RACER_PROVIDER;
  // Eligibility only. The Racer is never told to take a clue, and the prompt
  // below says so explicitly — an available credit is an option, not an
  // instruction. No other part of its strategy is touched by this feature.
  const clueAvailable = !forceFinal && state.clue_credits_available > 0;

  // V2.5-B3 — the transport comes from the game record, resolved through the
  // registry. An unknown provider THROWS here; it never falls back.
  //
  // Everything below the call — the system prompt, the schema, the rendered
  // transcript, the question budget — is built here, once, provider-neutrally,
  // and handed over untouched. No adapter may rewrite any of it. Two providers
  // must receive the same task, or a comparison between them measures the
  // prompt and not the model.
  const adapter = getAdapter(provider);
  const requestedModel = racerModelFor(provider);

  // Assembled ONCE, provider-neutrally, and verified before the transport is
  // handed anything. Both halves matter: one assembly is what makes Claude and
  // Grok comparable, and the assertion is what makes the stamped
  // prompt_version a fact rather than a hope.
  const content = buildRacerTurnMessage(state, { forceFinal, clueAvailable });
  assertGuidanceApplied(content);

  const {
    output: result,
    resolvedModel,
    diagnostics,
  } = await adapter.callTool<RacerTurnOutput>({
    model: requestedModel,
    reasoningEffort: options.reasoningEffort,
    system: RACER_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    toolName: "submit_turn",
    toolDescription: "Submit your move for this turn.",
    inputSchema: turnInputSchema(forceFinal, clueAvailable),
    maxTokens: 512,
  });

  // The schema constrains the enum, but a model can still return a null
  // question_text alongside action="question". Normalize rather than trust.
  const action = forceFinal && result.action === "question" ? "guess" : result.action;

  // A model can pick "clue" even when the schema did not offer it. Refuse it
  // rather than mint a credit that was never earned.
  const safeAction = action === "clue" && !clueAvailable ? "question" : action;

  return {
    output: {
      action: safeAction,
      question_text: safeAction === "question" ? (result.question_text ?? null) : null,
      guess_text:
        safeAction === "guess" ? (result.guess_text ?? result.question_text ?? null) : null,
      rationale: result.rationale ?? "",
    },
    provenance: {
      // The adapter's own id, not a separate constant. There is exactly one
      // place a provider name is written down, so the transport that made the
      // call and the evidence recording who made it cannot drift apart.
      model_id: resolvedModel,
      model_provider: adapter.id,
      prompt_version: RACER_PROMPT_VERSION,
    },
    diagnostics,
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
  flaggedQuestion: string,
  provider: ModelProviderId = DEFAULT_RACER_PROVIDER
): Promise<GuessIntentResolution> {
  // Same seat, same provider as the turn it is resolving — the caller passes
  // the game's provider, not a default. A flagged question must not be re-read
  // by a different model than the one that wrote it, or the resolution would
  // describe an intent its author never had.
  // V2.7 — THE SAME CANONICAL BLOCK, AND THE SAME GUARD.
  //
  // This path can AUTHOR the question the human actually sees:
  // `continue_questioning` returns a revised_question that replaces the
  // original in question_text. Without this, `racer/2.7.0` would describe only
  // the first attempted question and not the one presented — a claim that is
  // true of a draft and false of the record. §32 measured 10 of ~20 turns
  // flagged in a single game, so the gap was material, not theoretical.
  //
  // The guidance is honestly applicable here rather than merely pasted in: a
  // revision is question authoring, and the candidate-enumeration prohibition
  // directly applies to the question whose form triggered the flag.
  const content = buildGuessIntentMessage(state, flaggedQuestion);
  assertGuidanceApplied(content);

  const { output: result } = await getAdapter(provider).callTool<GuessIntentResolution>({
    model: racerModelFor(provider),
    system: GUESS_INTENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
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
