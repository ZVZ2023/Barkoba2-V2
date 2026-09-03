import { callAnthropicTool } from "../anthropic";
import { env } from "../env";
import { renderClarification } from "./clarification";
import type {
  GameLanguage,
  IntegrityReviewResult,
  QuestionLogEntry,
} from "../types";

// ---------------------------------------------------------------------------
// Integrity Review. Runs at most once per game, and ONLY where its verdict can
// change the outcome: on a concede, or on a guess already judged incorrect. A
// correct guess skips this call entirely — see lib/resolveResult.ts.
//
// PERMITTED SECRET CALL SITE. Allowlisted in scripts/check-isolation.mjs.
//
// SCOPE IS NARROW ON PURPOSE: factual contradiction only. Did any YES or NO
// answer state something false about the target?
//
// It is NOT asked to judge evasiveness, stalling, strategy, or good faith.
// Those are not falsifiable from a transcript, and a model asked to infer bad
// intent will find it. AMBIGUOUS answers are explicitly out of scope — their
// abuse is already priced by the free-then-costed economics, which needs no
// model to enforce.
//
// BIAS IS CONSERVATIVE AND DELIBERATE. This verdict accuses a person of
// cheating. A false accusation is far worse than a missed one, because the
// missed one costs a game and the false one costs trust in the whole system.
// The prompt defaults to UPHELD unless a contradiction is unambiguous.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Integrity Reviewer for Barkóba. A Composer set a secret target and answered a series of yes/no questions from an AI Racer. You now see the target, the private clarification, and the full transcript — the complete, authoritative question/answer ledger. You decide one narrow question: did a Composer answer materially mislead the Racer?

STEP 1 — CLASSIFY EVERY RELEVANT ANSWER FIRST, BEFORE ANY VERDICT.
For each YES/NO answer that bears on the disputed guess (you do not need to classify every answer in the game, only the ones that matter to the outcome), assign exactly one of:
- CORRECT — plainly true given the target.
- DEFENSIBLE — a reasonable person could truthfully have answered this way, even if another reading also exists. This is not a violation, however imperfect it looks in hindsight.
- AMBIGUOUS / IS-IS — the Composer declined to give a hard yes or no. Always out of your scope; see below.
- INCORRECT — clearly, unarguably false given the target. The kind a reasonable observer would call a lie, not a stretch.
Do this classification honestly and specifically before reasoning about materiality or reaching a verdict — a verdict without this step first is exactly the failure mode this instruction exists to prevent.

STEP 2 — MATERIALITY. An INCORRECT answer is not, by itself, a violation of the OUTCOME. Ask: did this specific incorrect answer materially redirect the Racer's reasoning, or make reaching the correct solution unreasonably difficult, given the rest of the ledger? An incorrect answer that the Racer's own later questions and guess never actually relied on — one that turned out to be beside the point — does not meet this bar. Only return "violated" when at least one INCORRECT answer both exists AND was materially causal in this sense.

WHAT NEVER COUNTS, ON ITS OWN, AS A VIOLATION:
- AMBIGUOUS / IS-IS answers. They are a legitimate move, always outside your scope, however arguable, incomplete, or imprecise the underlying situation was. Never award a violation, in whole or in part, because an IS-IS answer existed — materiality analysis under STEP 2 applies only to answers you classified INCORRECT, never to AMBIGUOUS ones.
- Evasiveness, stalling, unhelpfulness, or playing to win. The Composer is an opponent, not a witness. They are entitled to answer minimally.
- A DEFENSIBLE answer, however inconvenient it turned out to be for the Racer.
- Answers about edge properties where the truth is genuinely arguable.
- Judgement calls that turn on how much of a thing counts as the thing.

A RECURRING CONFUSION, WORTH NAMING EXPLICITLY: whether an object was installed level or plumb is different from the object's geometric orientation, and both are different from whether it is a structural or load-bearing element. A window installed level in a wall is not thereby a "horizontal structural element." In ordinary construction, absent target-specific evidence of a specialized structural system, a window is normally treated as a non-load-bearing building component containing both horizontal and vertical parts; its overall orientation cannot be inferred merely from the fact that it was installed level. Treat a YES that conflates these properties as a candidate for INCORRECT, then determine materiality from the target's private clarification and the complete ledger, exactly as STEP 2 requires — never automatically.

LEXICAL CONTEXT ACROSS LANGUAGES. Interpret every question and answer by the ordinary meaning its own words carry in the game's actual language — never by translating a word to another language first and judging THAT translation's breadth instead. Many languages distinguish a narrower, traditional or mechanical term from a broader general term for the same rough concept, where only the broader term comfortably extends to something modern or metaphorical. Calling something by the NARROW term when it only fits under the broad one is a candidate for INCORRECT even when a one-word gloss into another language would sound defensible there — the defensibility of a foreign paraphrase is not evidence about the word the Composer actually chose. For example, in Hungarian, "szerszám" ordinarily names a traditional, hand-operated or mechanical tool (a hammer, a wrench, a saw); "eszköz" is the broader word for a device or instrument in general. Answering YES to whether a computer is a "szerszám" is a candidate for INCORRECT even though English "tool" can defensibly stretch to cover it — "tool" and "szerszám" are not the same width of word. This is a general principle about lexical breadth, to apply with whatever pair of narrow/broad terms the game's own language and target present, never a rule about computers, tools, or Hungarian specifically. As always, a candidate is not a verdict: classify it honestly under STEP 1, then let STEP 2's materiality test — not the classification alone — decide whether it affected the outcome.

OPTIONAL NOTES ARE CONTEXT, NEVER A REPLACEMENT FOR THE SELECTED ANSWER. The Composer's structured YES/NO/IS-IS choice is the authoritative record of what they answered; an attached note only helps you understand WHY. Read notes charitably and contextually — ordinary spelling mistakes, missing accent marks, and obvious phone-autocorrect substitutions (for example, Hungarian "Bem" for "nem" is a keyboard/autocorrect slip, not a different word) should be understood as the player plainly intended, never used to second-guess or override the YES/NO/IS-IS they actually selected.

The clarification is OPTIONAL and may be absent. When it is, assess the answers against the target alone — and lean further toward upheld, not less. With less information about what the Composer meant, more answers become defensible, not fewer. Absence of a clarification is never itself evidence of bad faith.

DEFAULT TO UPHELD. Return "violated" only when STEP 1 classified at least one answer INCORRECT and STEP 2 confirms it was materially causal. If you find yourself constructing an argument for why an answer was wrong, or for why an arguable one mattered, it does not clear this bar. Uphold.

You are accusing a person of cheating. A wrong accusation is worse than a missed one.

When you do find a violation, list the turn_index of every materially-causal incorrect answer in contradicting_turns, and say in reasoning specifically which answer contradicted what and how it misdirected the Racer. If the verdict is upheld, contradicting_turns must be empty. Explain any disputed terminology plainly and educationally — what the correct distinction actually is — without framing it as blaming the player; a wrong classification is a mistake to explain, not a character judgment.

WRITE YOUR REASONING IN THE GAME LANGUAGE. You will be told which language this game is played in; write the reasoning field in that language. Your judgement is made the same way in every language — only the wording changes.

Never use the words "Composer", "Racer", "Validator" or "Adjudicator" in it. Those are internal engineering labels. In Hungarian refer to the sides naturally: "az ellenfeled", "a másik játékos", "te", "az AI".

DETERMINISM
Apply these rules mechanically and identically every time. Given the same inputs, return the same verdict. Do not vary your judgement for the sake of variety. Where a case is close, pick the reading the rules dictate and apply it the same way on every occasion — the confidence field, not the verdict, is where closeness gets recorded.`;

// ---------------------------------------------------------------------------
// FIELD ORDER: reasoning FIRST, before verdict.
//
// Same defect class as the Adjudicator's orth-5 failure, in a file that fix
// never touched. Models emit tool-call fields in schema order, so declaring
// `verdict` first means the verdict is committed before any analysis exists and
// the reasoning becomes post-hoc narration.
//
// It matters more here than anywhere else in the codebase. This verdict accuses
// a person of cheating, and a snap judgment on a transcript — where the honest
// reading of an awkwardly worded question is often the whole question — is
// exactly how a false accusation gets made at high confidence.
// ---------------------------------------------------------------------------

export const INTEGRITY_REVIEW_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reasoning: {
      type: "string",
      description:
        "Work through it before deciding. If you believe an answer was false, say which answer, what the target is, and why the two cannot both hold. If nothing is clearly false, one sentence is enough.",
    },
    verdict: {
      type: "string",
      enum: ["upheld", "violated"],
      description: "Default to upheld unless a contradiction is unarguable.",
    },
    contradicting_turns: {
      type: "array",
      items: { type: "number" },
      description:
        "turn_index values of contradicting answers. Empty when the verdict is upheld.",
    },
  },
  required: ["reasoning", "verdict", "contradicting_turns"],
};

const INPUT_SCHEMA = INTEGRITY_REVIEW_INPUT_SCHEMA;

/**
 * V2.8.4.3 — thrown when a review call otherwise succeeds but returns no
 * usable reasoning (the "PC" incident: verdict "upheld", reasoning ""). An
 * upheld-but-unexplained verdict is indistinguishable from a review that
 * never ran, so this is deliberately NOT swallowed into an empty string.
 *
 * Distinct from a transport/provider failure — which still throws a plain
 * Error, as before — so the caller (app/api/game/[id]/resolve/route.ts) can
 * tell "the call failed" apart from "the call succeeded but explained
 * nothing" and retry only the latter, once, through the same bounded
 * provider mechanism it already uses.
 */
export class IntegrityReviewIncompleteError extends Error {}

function renderTranscript(qaLog: QuestionLogEntry[]): string {
  const rows = qaLog
    .filter((e) => e.turn_type === "question" && e.question_text)
    .map((e) => {
      const answer = e.composer_response ?? "(unanswered)";
      const note = e.ambiguous_explanation ? ` — Composer's note: ${e.ambiguous_explanation}` : "";
      return `turn_index ${e.turn_index}\n  Q: ${e.question_text}\n  A: ${answer}${note}`;
    });

  return rows.length > 0 ? rows.join("\n\n") : "No questions were answered.";
}

export async function runIntegrityReview(params: {
  target: string;
  privateClarification: string;
  qaLog: QuestionLogEntry[];
  gameLanguage: GameLanguage;
}): Promise<IntegrityReviewResult> {
  const result = await callAnthropicTool<IntegrityReviewResult>({
    model: env.modelStrong(),
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
          "Transcript:",
          renderTranscript(params.qaLog),
          "",
          "Review the Composer's answers.",
        ].join("\n"),
      },
    ],
    toolName: "submit_integrity_review",
    toolDescription: "Submit the integrity verdict on the Composer's answers.",
    inputSchema: INPUT_SCHEMA,
    maxTokens: 768,
    // Deterministic judgment — see lib/anthropic.ts.
    temperature: 0,
  });

  const verdict = result.verdict === "violated" ? "violated" : "upheld";
  const turns = Array.isArray(result.contradicting_turns)
    ? result.contradicting_turns.filter((n): n is number => typeof n === "number")
    : [];

  // V2.8.4.3 — required, not merely preferred: an upheld-or-violated verdict
  // with no explanation behind it must never reach persistence. See
  // IntegrityReviewIncompleteError's doc for why this is a distinct failure
  // mode from a transport error, and app/api/game/[id]/resolve/route.ts for
  // the one bounded retry this is designed to trigger.
  const reasoning = (result.reasoning ?? "").trim();
  if (reasoning.length === 0) {
    throw new IntegrityReviewIncompleteError(
      "integrityReview: provider returned a verdict with no usable reasoning."
    );
  }

  return {
    verdict,
    // An upheld verdict with evidence attached is incoherent; normalize rather
    // than surface a contradiction to the player.
    contradicting_turns: verdict === "violated" ? turns : [],
    reasoning,
  };
}
