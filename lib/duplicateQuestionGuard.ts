import { checkQuestionPolicy } from "./questionPolicy";
import type { QuestionLogEntry } from "./types";

// ---------------------------------------------------------------------------
// V2.8.x — exact-duplicate question pre-emission guard.
//
// Forensic review of three real human-vs-AI games played 2026-09-01 found the
// Racer re-asking the IDENTICAL question text later in the same game three
// times in one game alone (Marcali: turns 17/27, 19/21, 29/33 — the exact
// Hungarian strings are pinned in test/duplicateQuestionGuard.test.ts). This
// module is the narrowest possible fix for that one pattern: deterministic,
// no LLM call, no semantic/embedding comparison. It blocks only an EXACT
// repeat, after whitespace and case normalization, of a question already
// asked and answered earlier in the same game's main branch.
//
// Deliberately NOT here — each would need a different, more complex
// mechanism and more evidence than three games provides, and bundling them
// into this guard was explicitly ruled out:
//   - near-duplicate / paraphrase detection ("near a county seat" vs. "near a
//     Somogy county seat" — different questions, must NOT match here)
//   - logical-redundancy detection (a question whose answer is already
//     implied by a broader confirmed fact)
//   - contradiction-with-established-evidence detection (naming a candidate
//     that conflicts with an earlier answer, e.g. asking about a town already
//     ruled out by a broader NO)
// -----------------------------------------------------------------------

/**
 * Whitespace-collapse and case-fold ONLY. Diacritics, accents, and every
 * other character are preserved exactly — a Hungarian "á" is never folded to
 * "a", and there is no stemming or transliteration. This is what keeps a
 * genuinely different question from ever being mistaken for a duplicate.
 */
export function normalizeQuestionForDuplicateCheck(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The main branch's questions already asked AND answered, in transcript
 * order. Filtering on `composer_response !== null` is defensive rather than
 * load-bearing: by the time the turn route reaches the guard, any prior
 * pending question has already been answered (or none existed) — see Step 1
 * of app/api/game/[id]/turn/route.ts. `game.qa_log` is itself the main
 * branch; rewound/abandoned turns live in a structurally separate field the
 * Racer never sees, so no branch filtering is needed here.
 */
export function priorAskedQuestions(
  qaLog: readonly Pick<QuestionLogEntry, "turn_type" | "question_text" | "composer_response">[]
): string[] {
  return qaLog
    .filter(
      (entry) =>
        entry.turn_type === "question" &&
        entry.question_text !== null &&
        entry.composer_response !== null
    )
    .map((entry) => entry.question_text as string);
}

/**
 * True only if `candidate` exactly matches (after normalization) one of
 * `priorQuestions`. A near-duplicate — different wording, a narrower or
 * broader scope, a different named candidate — must NOT match; that is out
 * of scope by design, not an oversight (see module doc above).
 */
export function isDuplicateQuestion(
  candidate: string,
  priorQuestions: readonly string[]
): boolean {
  const normalizedCandidate = normalizeQuestionForDuplicateCheck(candidate);
  return priorQuestions.some(
    (prior) => normalizeQuestionForDuplicateCheck(prior) === normalizedCandidate
  );
}

// ---------------------------------------------------------------------------
// The pre-emission retry loop itself.
//
// Deliberately framework- and provider-agnostic (no NextResponse, no
// RacerTurnOutput import) so it is unit-testable with a plain mock producer —
// see test/duplicateQuestionGuard.test.ts — while app/api/game/[id]/turn/
// route.ts calls this SAME function against the real Racer pipeline. There is
// exactly one implementation of the loop; the test exercises the real thing,
// not a re-description of it.
// ---------------------------------------------------------------------------

/** What one attempt at producing a candidate turn can report back. */
export type QuestionGuardAttempt<T, F> =
  | { ok: true; candidate: T }
  | { ok: false; failure: F };

export type QuestionGuardResult<T, F> =
  | { status: "accepted"; candidate: T; attemptsMade: number; blockedQuestions: string[] }
  | { status: "attempt_failed"; failure: F; attemptsMade: number; blockedQuestions: string[] }
  | { status: "exhausted"; attemptsMade: number; blockedQuestions: string[] };

/**
 * The generic bounded-retry core shared by every "reject and regenerate"
 * guard in this module. `isRejected` decides, given ONLY the candidate's
 * question text, whether it must never reach emission. Extracted so a new
 * rejection reason (see runWithDuplicateAndPolicyQuestionGuard below) reuses
 * this exact loop rather than a second, hand-copied one — there is one
 * retry-loop implementation, not one per rejection reason.
 */
async function runWithRejectionGuard<T, F>(
  maxAttempts: number,
  produceCandidate: () => Promise<QuestionGuardAttempt<T, F>>,
  extractQuestion: (candidate: T) => { action: string; question_text: string | null },
  isRejected: (questionText: string) => boolean
): Promise<QuestionGuardResult<T, F>> {
  const blockedQuestions: string[] = [];

  for (let attemptsMade = 1; attemptsMade <= maxAttempts; attemptsMade += 1) {
    const attempt = await produceCandidate();
    if (!attempt.ok) {
      return { status: "attempt_failed", failure: attempt.failure, attemptsMade, blockedQuestions };
    }

    const { action, question_text } = extractQuestion(attempt.candidate);
    const rejected = action === "question" && !!question_text && isRejected(question_text);

    if (!rejected) {
      return { status: "accepted", candidate: attempt.candidate, attemptsMade, blockedQuestions };
    }

    blockedQuestions.push(question_text as string);
  }

  return { status: "exhausted", attemptsMade: maxAttempts, blockedQuestions };
}

/**
 * Call `produceCandidate` up to `maxAttempts` times. A candidate whose
 * question (per `extractQuestion`) is an exact normalized duplicate of
 * `priorQuestions` is rejected and a fresh candidate is requested — the
 * duplicate is never returned to the caller, i.e. never reaches emission.
 *
 * If an attempt itself fails (`ok: false` — e.g. a spend-ceiling or transport
 * error, unrelated to duplication), the loop stops immediately without
 * retrying and reports `attempt_failed`; that failure mode already has its
 * own safe handling upstream and must not be confused with duplicate
 * exhaustion. If every attempt up to `maxAttempts` produces a duplicate
 * question, the loop reports `exhausted` — the caller decides what "never
 * emit a duplicate" means when regeneration itself keeps failing (see
 * route.ts: it reuses the existing racer_unavailable non-emission path).
 */
export async function runWithDuplicateQuestionGuard<T, F>(
  priorQuestions: readonly string[],
  maxAttempts: number,
  produceCandidate: () => Promise<QuestionGuardAttempt<T, F>>,
  extractQuestion: (candidate: T) => { action: string; question_text: string | null }
): Promise<QuestionGuardResult<T, F>> {
  return runWithRejectionGuard(maxAttempts, produceCandidate, extractQuestion, (questionText) =>
    isDuplicateQuestion(questionText, priorQuestions)
  );
}

// ---------------------------------------------------------------------------
// V2.8.7.4 — DEFECT 3: the universal no-spelling rule, enforced on the AI
// Racer's OWN generated questions too (the only direction where a human
// never gets a chance to type — and therefore never gets a chance to
// self-correct — so mechanical enforcement here has to be the whole
// safety net, not a backstop behind a human's own judgment).
//
// Combined with the exact-duplicate check in ONE retry loop rather than two
// nested ones: both are cheap, deterministic, in-memory checks against a
// single candidate's text, so checking both per attempt costs nothing extra
// and avoids compounding retry budgets (two independent maxAttempts=3 loops
// could otherwise cost up to 9 model calls where this costs at most 3).
// ---------------------------------------------------------------------------

/**
 * The SAME contract as runWithDuplicateQuestionGuard, but a candidate is also
 * rejected when lib/questionPolicy.ts's checkQuestionPolicy finds it probes
 * the target's written/spoken name. `blockedQuestions` does not distinguish
 * WHY a given candidate was blocked (duplicate vs. policy) — callers that
 * need that distinction (e.g. for telemetry) should recompute it themselves,
 * exactly as app/api/game/[id]/turn/route.ts already does for the plain
 * duplicate check via isDuplicateQuestion.
 */
export async function runWithDuplicateAndPolicyQuestionGuard<T, F>(
  priorQuestions: readonly string[],
  maxAttempts: number,
  produceCandidate: () => Promise<QuestionGuardAttempt<T, F>>,
  extractQuestion: (candidate: T) => { action: string; question_text: string | null }
): Promise<QuestionGuardResult<T, F>> {
  return runWithRejectionGuard(
    maxAttempts,
    produceCandidate,
    extractQuestion,
    (questionText) =>
      isDuplicateQuestion(questionText, priorQuestions) || !checkQuestionPolicy(questionText).allowed
  );
}
