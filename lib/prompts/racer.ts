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
 * `racer/X.Y.Z` IS A LOAD-BEARING DATABASE CLAIM, NOT A LABEL.
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
 *
 * RG #3 — `racer/3.0.0` REPLACES `racer/2.7.0`, NOT A REFINEMENT OF IT.
 *
 * RG v2 (structured deliberation, seven numbered stages) improved local
 * continuity but did not give the Racer an explicit model of what remains
 * unknown — see the RG #3 build brief's diagnosis: it either over-drills one
 * dimension (Grok, GAZ-13: 49/50 → Volga, wrong sibling within the right
 * family) or under-explores before committing (Claude, GAZ-13: 31/50 →
 * Porsche 911, premature conviction). RG v3 replaces the seven-stage
 * deliberation with an explicit uncertainty-management loop — KNOWN / UNKNOWN
 * / HYPOTHESES / NEXT QUESTION OPTIONS / SELECT / CHECK — per the brief's own
 * §20 minimum-implementation recommendation: one compact structured block in
 * the same single call, not a new backend system, not an additional model
 * call, not a domain ontology. §21 of that brief is explicit about what NOT
 * to build yet, and none of it is built here.
 *
 * THE REQUIRED §22 BENCHMARK (GAZ-13, 50 questions, both providers, compared
 * against the RG v2 baselines above) HAS NOT BEEN RUN AS OF THIS COMMIT — no
 * Anthropic or xAI credentials were available in the build session. See
 * docs/DESIGN-NOTES.md §45 for the tracked follow-up. Do not treat this
 * version as field-validated until that comparison exists.
 *
 * `racer/3.1.0` — TWO TARGETED ADDITIONS, NOT A REWRITE.
 *
 * racer/3.0.0's first live field test (GAZ-13/Chaika, Grok, 49/50 — a real
 * win) surfaced two specific remaining gaps, not a wrong architecture: (1)
 * geography/nationality was still enumerated country-by-country rather than
 * partitioned by a broader region first, despite SELECT's existing
 * "partition before you enumerate" guidance — descriptive preference proved
 * too weak, so CHECK gained a Hierarchy gate that can reject and regenerate
 * a sibling-level question outright; (2) Claude guessed "Volga" immediately
 * after confirming the broader category "Russian/Soviet luxury automobile"
 * without checking whether a neighboring specific candidate was equally
 * consistent — BEFORE ANY FINAL GUESS gained two inserted sentences making
 * explicit that confirming a category does not eliminate a specific rival
 * inside it, and that the compared alternative must be named specifically.
 * Every existing sentence in racer/3.0.0's text is unchanged; both are pure
 * additions. Still no GAZ-13-specific vocabulary — the two new gate items
 * are worded exactly as domain-generally as the rest of the block, per the
 * brief's own §17 constraint, restated for this pass.
 *
 * Also not yet field-validated beyond the one Grok run above — same
 * no-credentials constraint as racer/3.0.0. See docs/DESIGN-NOTES.md §47.
 *
 * `racer/3.2.0` — TWO MORE TARGETED ADDITIONS, STILL NOT A REWRITE.
 *
 * racer/3.1.0's field test (Hungarian sheepdog breed) showed the Hierarchy
 * gate and the strengthened validation gate both working, and surfaced two
 * further specific gaps: (1) once a dimension was confirmed by a YES, the
 * Racer kept re-probing that same neighborhood — a sibling of the confirmed
 * value, an edge case of it, a more precise variant of it — instead of
 * treating it as resolved and moving to a different unresolved dimension;
 * EVIDENCE-RESPONSE BEHAVIOR's existing YES guidance already says this in
 * prose ("not license to spray further candidates within the branch you
 * just confirmed") but, like SELECT's pre-3.1.0 partition preference, prose
 * alone was not enough — so CHECK gained a Resolved-branch gate that can
 * reject and regenerate the question outright, the same escalation
 * Hierarchy already used for the equivalent geography gap; (2) once
 * HYPOTHESES had narrowed to two or three very similar candidates, generic
 * descriptive questions kept being asked instead of the one property that
 * actually separates that specific pair — so CHECK also gained a
 * Close-candidate-specificity gate requiring the selected question to name
 * the discriminator between THOSE remaining candidates, not a broad
 * attribute that could be true of either. Every existing sentence in
 * racer/3.1.0's text is unchanged; both are pure additions, and both are
 * CHECK-stage gates rather than softer SELECT-stage preferences, matching
 * how Hierarchy was built. Still no benchmark-specific vocabulary — no dog
 * breed, coat, ear, or Hungary/Romania/Czech Republic wording appears below;
 * the two new gate items are worded exactly as domain-generally as the rest
 * of the block.
 *
 * Also not yet field-validated beyond that one run — same no-credentials
 * constraint as every version above. See docs/DESIGN-NOTES.md §49.
 *
 * `racer/4.0.0` — A COMPRESSION AND RESTRUCTURE, NOT AN ADDITIVE PASS.
 *
 * Every prior RG #3 pass (3.0.0 → 3.2.0) added gates onto a growing ~800-word
 * block. Four field tests across that lineage — GAZ-13/Grok (won messily:
 * right family, wrong sibling, sibling enumeration before partition),
 * GAZ-13/Claude (premature conviction before the alternative was ruled out),
 * and two from the Hungarian-sheepdog run (a close-candidate pair decided by
 * a generic property instead of the one that actually separated them, and a
 * confirmed dimension re-probed instead of treated as resolved) — were each
 * individually fixed by an added gate, and each fix held. The length itself
 * became the next risk: a long, checklist-heavy block invites the model to
 * satisfy each rule locally while losing the single coherent stance the
 * rules exist to produce, and crowds out exactly the "zoom out and reopen
 * the parent frame" judgment none of the individual gates can substitute
 * for.
 *
 * `racer/4.0.0` REPLACES the nine-stage v3 text with a six-stage loop — KNOWN
 * / UNKNOWN / HYPOTHESES / SELECT / RED FLAGS / BEFORE ANY FINAL GUESS — at
 * roughly half the length. NEXT QUESTION OPTIONS and the separate
 * EVIDENCE-RESPONSE BEHAVIOR / DIMINISHING RETURNS sections are folded into
 * SELECT and RED FLAGS rather than kept as standing text; CHECK's five
 * paragraph-length gates become six one-line RED FLAGS. The two/three-related
 * NOs reopen-the-parent-frame instruction — the single biggest remaining
 * defect the v3.2.0 field test still showed — moves out of the old
 * EVIDENCE-RESPONSE BEHAVIOR appendix and into SELECT itself, ahead of RED
 * FLAGS. A new pressure test — "would a reasonably informed human still be
 * seriously considering that alternative" — is added to BEFORE ANY FINAL
 * GUESS as a cheap, general check against overconfidence, independent of any
 * specific discriminator having been identified.
 *
 * Every one of the four field-test fixes was verified still present in the
 * compressed text, phrase by phrase, before this version was cut — see
 * docs/DESIGN-NOTES.md §50 for the full four-way cross-check. This is a
 * restructure of wording, not a change of policy: nothing the v3.2.0 gates
 * enforced is dropped, only reworded and, in three cases, merged with an
 * adjacent rule. Still no benchmark-specific vocabulary of any kind.
 *
 * NOT YET FIELD-VALIDATED. No live game has been played against this text —
 * same no-credentials constraint as every version above. The compression
 * hypothesis itself (shorter reads better under repeated injection) is
 * untested until Zsolt plays it.
 *
 * `racer/4.1.0` — ONE BOUNDED D9 FIX, NOT A D4 FIX TOO.
 *
 * racer/4.0.0's first field evidence (M3 baseline, docs/m3-baseline-evaluation.md,
 * two controlled fixtures) surfaced two recurring failures at perfect 2/2
 * recurrence: D4 (redundant question) and D9 (poor branch recovery). Both
 * were candidates for this pass. M4 deliberately targets D9 ONLY — one
 * recurring material failure, one bounded intervention, so a measured effect
 * can be attributed to one cause. D4 is carried forward as a
 * regression/secondary-observation dimension in M4's benchmark, not as a
 * second target; see docs/m4-experiment-spec.md §1.
 *
 * THE D9 DIAGNOSIS. SELECT already stated the recovery rule in racer/4.0.0:
 * "After two or three related NOs on the same branch, stop... and ask
 * whether the parent frame itself is wrong." The M3 evidence shows this rule
 * was violated, not missing — D-1 ran 8 consecutive same-branch NOs
 * (t7-t14) and D-2 ran as many as 12 (t26-t37) before either game stepped
 * back. This is the same failure shape RG #3's own history already
 * documents once (racer/3.0.0 -> 3.1.0, docs/DESIGN-NOTES.md §47):
 * descriptive preference proved too weak for a countable pattern, and was
 * fixed there by turning it into an explicit, numbered gate rather than a
 * softer preference.
 *
 * THE FIX. SELECT's vague "two or three" threshold becomes an exact,
 * countable "three." The Racer is now required to make its own branch-NO
 * count and recovery move explicit in `rationale` once the boundary is
 * reached, rather than holding it as unobserved internal state — the exact
 * gap the M3 evidence exposed (a model that silently tracks a branch will
 * silently fail to act on it; one required to name the branch and its count
 * out loud has nowhere to quietly keep enumerating). No new schema field, no
 * new architecture: this reuses the existing `rationale` output exactly as
 * racer/3.1.0's Hierarchy gate and racer/3.2.0's Resolved-branch gate reused
 * the existing structured-output loop rather than adding a new call.
 *
 * WHAT DID NOT CHANGE. KNOWN, UNKNOWN, HYPOTHESES, RED FLAGS (including its
 * own redundancy bullet, which is D4's territory), and BEFORE ANY FINAL
 * GUESS are byte-identical to racer/4.0.0. RACER_SYSTEM_PROMPT and both
 * schemas are untouched — the experimental variable stays isolated to one
 * paragraph, matching every prior RG #3/#4 pass. No new anti-redundancy text
 * was added anywhere in this version.
 *
 * Full pre-registered hypothesis, exact diff, fixture identities, and
 * PASS/REVISE/REJECT criteria: docs/m4-experiment-spec.md, frozen before any
 * racer/4.1.0 transcript was produced or inspected.
 *
 * NOT YET FIELD-VALIDATED as of this commit — same no-credentials constraint
 * as every version above. See docs/m4-evaluation.md for execution status.
 */
export const RACER_PROMPT_VERSION = "racer/4.1.0";

/**
 * RG #4 — THE CANONICAL TRAILING UNCERTAINTY-MANAGEMENT BLOCK.
 *
 * This is the only experimental variable. The system prompt, transcript,
 * provider routing, model selection and call topology remain unchanged. The
 * block stays last before the instruction to act and is shared by both paths
 * that can author the player-facing question.
 *
 * THE TEXT IS CANONICAL. `racer/4.0.0`'s text is reproduced verbatim in
 * docs/DESIGN-NOTES.md §50; the current `racer/4.1.0` text below (one changed
 * SELECT paragraph, everything else byte-identical to §50's text) is
 * reproduced in docs/DESIGN-NOTES.md §52. Editing it without bumping the
 * version breaks the database claim above.
 *
 * ~400 WORDS, DOWN FROM ~800. See the racer/4.0.0 history note above for why:
 * length itself had become the risk, not any missing rule.
 *
 * DELIBERATELY DOMAIN-GENERIC, CARRIED FORWARD FROM RG #3. No vehicle,
 * geography, era, breed, or manufacturer vocabulary appears below on
 * purpose — a benchmark target exists to test whether the Racer discovers
 * the relevant dimensions on its own, not whether this text names them for
 * it.
 */
export const CORE_RACER_RULES = `RACER GUIDANCE V4 — UNCERTAINTY-MANAGEMENT LOOP — APPLY EVERY TURN

Before every turn, hold this state internally. Emit only the resulting question or guess.

KNOWN
Every hard YES, NO, and AMBIGUOUS answer so far. These are filters, not suggestions — nothing later may contradict one. AMBIGUOUS is informative failure, not a soft answer: it means the last question conflated two things a truthful answerer could not separate. Isolate one of them next; never re-ask a paraphrase of it.

UNKNOWN
The open dimensions that actually matter for this target's domain — discovered from the target itself, not a fixed checklist. Which one, if answered, would most shrink what remains possible?

HYPOTHESES
The leading family or families still consistent with KNOWN, plus the single strongest credible alternative. Keep this small and live, never a single premature favorite.

SELECT
Prefer the question that most usefully divides current HYPOTHESES over one that only confirms the leader. A broad split across an unresolved dimension beats naming siblings one at a time. After three related NOs on one branch, the next question must not be a fourth sibling there — name the branch and NO-count in rationale, then test the parent frame or pivot dimensions.

RED FLAGS — reject and regenerate if the question:
- Contradicts anything in KNOWN
- Re-probes a dimension already settled by a YES or a NO — a sibling within it, an edge case, or a more precise variant of the same confirmed value
- Names one specific sibling while a broader grouping one level up still has multiple live alternatives
- Is a disguised identity question — naming a candidate is a GUESS, not a question
- Investigates spelling, letters, or name structure instead of meaning and properties
- Targets two or three very similar remaining candidates with something generic or descriptive rather than the one property that specifically separates them

BEFORE ANY FINAL GUESS
Name the leader and the strongest remaining alternative — specifically, not a vague sense that others remain. Which facts support the leader and not equally the alternative? Have I asked the single discriminator that would most separate them? Would a reasonably informed human, given everything established so far, still be seriously considering that alternative — if yes, I am not ready to guess. Does the leader violate any fact in KNOWN? If an important discriminator remains unasked and budget allows, ask it instead of guessing.`;

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
    // RG #3 — THE TRAILING STRATEGY BLOCK. Position remains last
    // before the instruction to act, so a growing transcript never pushes the
    // strategy away from the point of decision.
    //
    // Included on the final turn too. The final-guess gate governs that moment,
    // an unconditional block keeps the guarantee below unconditional as well —
    // a branch here would mean RACER_PROMPT_VERSION was true of some turns and
    // not others, which is precisely the ambiguity the version is meant to remove.
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
 * THE GUARANTEE BEHIND `RACER_PROMPT_VERSION`.
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
  // RG #3 — THE SAME CANONICAL BLOCK, AND THE SAME GUARD.
  //
  // This path can AUTHOR the question the human actually sees:
  // `continue_questioning` returns a revised_question that replaces the
  // original in question_text. Without this, RACER_PROMPT_VERSION would
  // describe only the first attempted question and not the one presented — a
  // claim that is true of a draft and false of the record. §32 measured 10 of
  // ~20 turns flagged in a single game, so the gap was material, not
  // theoretical.
  //
  // The guidance is honestly applicable here rather than merely pasted in: a
  // revision is question authoring, and the partition-before-enumeration
  // discipline directly applies to the question whose form triggered the flag.
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
