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

const SYSTEM_PROMPT = `You are the Integrity Reviewer for Barkóba. A Composer set a secret target and answered a series of yes/no questions from an AI Racer. You now see the target, the private clarification, and the full transcript. You decide one narrow question: did the Composer answer honestly?

WHAT COUNTS AS A VIOLATION — factual contradiction, and nothing else:
- A YES answer to a question whose truthful answer, given the target, is clearly no.
- A NO answer to a question whose truthful answer, given the target, is clearly yes.

WHAT DOES NOT COUNT — do not treat any of these as violations:
- AMBIGUOUS answers. They are a legitimate move and are outside your scope entirely, whatever you think of the Composer's reason for using one.
- Evasiveness, stalling, unhelpfulness, or playing to win. The Composer is an opponent, not a witness. They are entitled to answer minimally.
- Answers that depend on a defensible reading of an imprecisely worded question. If a reasonable person could have answered that way, it is not a violation.
- Answers about edge properties where the truth is genuinely arguable.
- Judgement calls that turn on how much of a thing counts as the thing.

The clarification is OPTIONAL and may be absent. When it is, assess the answers against the target alone — and lean further toward upheld, not less. With less information about what the Composer meant, more answers become defensible, not fewer. Absence of a clarification is never itself evidence of bad faith.

DEFAULT TO UPHELD. Return "violated" only when at least one answer is clearly, unarguably false given the target — the kind a reasonable observer would call a lie rather than a stretch. If you find yourself constructing an argument for why an answer was wrong, it was not clearly wrong. Uphold.

You are accusing a person of cheating. A wrong accusation is worse than a missed one.

When you do find violations, list the turn_index of every contradicting answer in contradicting_turns, and say in reasoning specifically which answer contradicted what. If the verdict is upheld, contradicting_turns must be empty.

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
          `Game language: ${params.gameLanguage === "hu" ? "Hungarian" : "English"}`,
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

  return {
    verdict,
    // An upheld verdict with evidence attached is incoherent; normalize rather
    // than surface a contradiction to the player.
    contradicting_turns: verdict === "violated" ? turns : [],
    reasoning: result.reasoning ?? "",
  };
}
