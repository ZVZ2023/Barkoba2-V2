import type { PhaseOneSandbox } from "./phaseOne";
import type { GameLanguage, QuestionLogEntry } from "./types";

// ---------------------------------------------------------------------------
// V2.8.5 — the "+1" corridor (section 14). V2.8.5 ENGINE-CONTRACT CORRECTION
// — this file was rewritten to fix two defects found on independent review:
//
// DEFECT (decision order): the original corridor asked Living, Physical,
// Place, Event, Abstract IN THAT ORDER and resolved on the FIRST YES, only
// asking "is it Mixed?" after all five came back NO/IS-IS. An honest
// Physical+Place target would answer YES to Physical and could never reach
// Mixed at all. CORRECTED ORDER: ask whether more than one sense is
// essential FIRST; only then run the single-sense or two-sense selection.
//
// DEFECT (IS-IS treated as NO): the original loop advanced identically on
// "NO or AMBIGUOUS", silently treating an unresolved IS-IS as though the
// Setter had actively excluded that sense. CORRECTED: IS-IS never excludes
// and never silently advances. The only place IS-IS gets a second, narrower
// chance is the single decision this corridor calls "critical" — whether the
// target is Mixed at all — via exactly one deterministic operationalization.
// IS-IS anywhere else in the corridor (an ordinary per-sense question during
// either selection loop) ends the corridor in the truthful reframe/restart
// state; it is never resolved by guessing which way the Setter meant it.
//
// WHY THIS IS SAFE TO REPRESENT WITHOUT A MIGRATION. Reuses the exact same
// deterministic-replay mechanism Phase One's own spine already uses:
// fixed-text questions, answered YES/NO/AMBIGUOUS through the ordinary
// /turn endpoint, replayed from qa_log on every call. Each entry's
// racer_output_raw carries `{ meta: "sandbox_clarification" }`, which
// app/api/game/[id]/turn/route.ts checks before incrementing question_count,
// and lib/racerState.ts checks before building the Racer's transcript. No
// new turn_type, no new column, no CHECK-constraint conflict with
// corpus.game_turns — the entry is an ordinary turn_type "question" row.
// ---------------------------------------------------------------------------

export type ClarificationSense = "living" | "physical" | "place" | "event" | "abstract";

const SENSE_ORDER: readonly ClarificationSense[] = ["living", "physical", "place", "event", "abstract"];

const MIXED_GATE: Record<GameLanguage, string> = {
  en: "Privately, for you only: is more than one major sense essential to the target you intended — not merely true of it in passing, but genuinely necessary to what you mean?",
  hu: "Csak neked, privátan: a célpontod szándékolt jelentéséhez lényegében több fő jelentés is szükséges — nem csupán mellékesen igaz rá, hanem valóban elengedhetetlen ahhoz, amit gondoltál?",
};

/** The Mixed gate's one permitted operationalization, on IS-IS. */
const MIXED_GATE_OPERATIONALIZATION: Record<GameLanguage, string> = {
  en: "Narrowing that: would choosing only ONE of these senses materially misrepresent the intended target?",
  hu: "Pontosítva: ha csak EGY jelentést választanál a kettő közül, az érdemben félrevezető lenne a szándékolt célponthoz képest?",
};

const SENSE_QUESTIONS_SINGLE: Record<GameLanguage, Record<ClarificationSense, string>> = {
  en: {
    living: "Privately, for you only: does \"Living/biological\" capture the single sense you intended?",
    physical: "Privately, for you only: does \"Physical thing/material\" capture the single sense you intended?",
    place: "Privately, for you only: does \"Place/location\" capture the single sense you intended?",
    event: "Privately, for you only: does \"Event/occurrence\" capture the single sense you intended?",
    abstract: "Privately, for you only: does \"Abstract/conceptual\" capture the single sense you intended?",
  },
  hu: {
    living: "Csak neked, privátan: az \"Élő/biológiai\" az az egyetlen jelentés, amire gondoltál?",
    physical: "Csak neked, privátan: a \"Fizikai dolog/anyag\" az az egyetlen jelentés, amire gondoltál?",
    place: "Csak neked, privátan: a \"Hely/helyszín\" az az egyetlen jelentés, amire gondoltál?",
    event: "Csak neked, privátan: az \"Esemény/történés\" az az egyetlen jelentés, amire gondoltál?",
    // CORRECTION 4 — "informatikai" means computing/IT, not "abstract"; fixed
    // to "fogalmi" (conceptual), used consistently wherever Abstract appears
    // in this corridor.
    abstract: "Csak neked, privátan: az \"Elvont/fogalmi\" az az egyetlen jelentés, amire gondoltál?",
  },
};

const SENSE_QUESTIONS_MIXED_PICK: Record<GameLanguage, Record<ClarificationSense, string>> = {
  en: {
    living: "Privately: is \"Living/biological\" one of the two essential senses?",
    physical: "Privately: is \"Physical thing/material\" one of the two essential senses?",
    place: "Privately: is \"Place/location\" one of the two essential senses?",
    event: "Privately: is \"Event/occurrence\" one of the two essential senses?",
    abstract: "Privately: is \"Abstract/conceptual\" one of the two essential senses?",
  },
  hu: {
    living: "Privátan: az \"Élő/biológiai\" a két lényeges jelentés egyike?",
    physical: "Privátan: a \"Fizikai dolog/anyag\" a két lényeges jelentés egyike?",
    place: "Privátan: a \"Hely/helyszín\" a két lényeges jelentés egyike?",
    event: "Privátan: az \"Esemény/történés\" a két lényeges jelentés egyike?",
    abstract: "Privátan: az \"Elvont/fogalmi\" a két lényeges jelentés egyike?",
  },
};

/** The recognizable marker every clarification entry's racer_output_raw carries. See the module doc. */
const META_MARKER = "sandbox_clarification";

export function isSandboxClarificationEntry(entry: Pick<QuestionLogEntry, "racer_output_raw">): boolean {
  try {
    const parsed = JSON.parse(entry.racer_output_raw) as Record<string, unknown>;
    return parsed.meta === META_MARKER;
  } catch {
    return false;
  }
}

/**
 * The racer_output_raw payload for a new clarification entry. The caller
 * (app/api/game/[id]/turn/route.ts) builds the entry itself via its own
 * newLogEntry() helper, exactly like Phase One's deterministic questions do,
 * and only needs this marker payload plus the question text.
 */
export function sandboxClarificationRawOutput(questionText: string): string {
  return JSON.stringify({
    meta: META_MARKER,
    action: "question",
    question_text: questionText,
    guess_text: null,
    rationale: META_MARKER,
  });
}

export type SandboxClarificationState =
  | { complete: false; nextQuestionText: string; failed: false }
  | {
      complete: true;
      resolvedSandbox: PhaseOneSandbox;
      mixedSenses: [ClarificationSense, ClarificationSense] | null;
      failed: false;
    }
  | { complete: true; resolvedSandbox: null; mixedSenses: null; failed: true };

function findEntry(entries: readonly QuestionLogEntry[], questionText: string): QuestionLogEntry | undefined {
  return entries.find((e) => e.question_text === questionText);
}

const FAILED: SandboxClarificationState = { complete: true, resolvedSandbox: null, mixedSenses: null, failed: true };

/**
 * Run the shared per-sense elimination loop (used identically by the
 * single-sense and two-sense selection stages, which differ only in how many
 * YES answers they stop at). IS-IS on any of these ordinary per-sense
 * questions is NOT given its own operationalization — the one deterministic
 * clarification this corridor grants is reserved for the Mixed/single-sense
 * decision itself (see the module doc) — so an IS-IS here ends the corridor
 * in the truthful reframe/restart state immediately, rather than excluding
 * the sense or silently moving on.
 */
function runSenseSelection(
  entries: readonly QuestionLogEntry[],
  questionsBySense: Record<GameLanguage, Record<ClarificationSense, string>>,
  language: GameLanguage,
  picksNeeded: 1 | 2
): { complete: false; nextQuestionText: string } | { complete: true; picked: ClarificationSense[] } | { complete: true; failed: true } {
  const text = questionsBySense[language];
  const picked: ClarificationSense[] = [];

  for (const sense of SENSE_ORDER) {
    if (picked.length === picksNeeded) break;
    const entry = findEntry(entries, text[sense]);
    if (!entry) return { complete: false, nextQuestionText: text[sense] };
    if (entry.composer_response === null) return { complete: false, nextQuestionText: text[sense] };
    if (entry.composer_response === "AMBIGUOUS") {
      // IS-IS never excludes and never silently advances — it ends the
      // corridor rather than pretending the Setter meant NO.
      return { complete: true, failed: true };
    }
    if (entry.composer_response === "YES") picked.push(sense);
    // NO: excludes this sense, continue to the next.
  }

  if (picked.length === picksNeeded) return { complete: true, picked };
  // Ran out of senses (all remaining were NO) without reaching the required
  // pick count — no coherent contract.
  return { complete: true, failed: true };
}

/**
 * Replay the clarification sub-log (the qa_log entries this module itself
 * wrote) and derive where the +1 corridor currently stands. Pure and
 * deterministic, exactly like lib/phaseOne.ts's own derive function.
 *
 * CORRECTED ORDER (see module doc): the Mixed gate is asked FIRST, with its
 * own one-shot IS-IS operationalization; only then does either the
 * single-sense or two-sense selection loop run, and IS-IS anywhere in either
 * loop ends the corridor rather than being read as exclusion.
 */
export function deriveSandboxClarificationState(
  qaLog: readonly QuestionLogEntry[],
  language: GameLanguage
): SandboxClarificationState {
  const entries = qaLog.filter((e) => isSandboxClarificationEntry(e));
  const mixedGateText = MIXED_GATE[language];
  const mixedOpText = MIXED_GATE_OPERATIONALIZATION[language];

  const gateEntry = findEntry(entries, mixedGateText);
  if (!gateEntry) return { complete: false, nextQuestionText: mixedGateText, failed: false };
  if (gateEntry.composer_response === null) return { complete: false, nextQuestionText: mixedGateText, failed: false };

  let isMixed: boolean;
  if (gateEntry.composer_response === "YES") {
    isMixed = true;
  } else if (gateEntry.composer_response === "NO") {
    isMixed = false;
  } else {
    // AMBIGUOUS on the Mixed gate — exactly one narrower operationalization.
    const opEntry = findEntry(entries, mixedOpText);
    if (!opEntry) return { complete: false, nextQuestionText: mixedOpText, failed: false };
    if (opEntry.composer_response === null) return { complete: false, nextQuestionText: mixedOpText, failed: false };
    if (opEntry.composer_response === "YES") {
      isMixed = true; // choosing only one WOULD misrepresent it -> genuinely mixed
    } else if (opEntry.composer_response === "NO") {
      isMixed = false;
    } else {
      // A second AMBIGUOUS — the corridor cannot establish a coherent
      // contract. Never guessed either way; never a third reformulation.
      return FAILED;
    }
  }

  if (!isMixed) {
    const result = runSenseSelection(entries, SENSE_QUESTIONS_SINGLE, language, 1);
    if (!result.complete) return { complete: false, nextQuestionText: result.nextQuestionText, failed: false };
    if ("failed" in result) return FAILED;
    return { complete: true, resolvedSandbox: result.picked[0] as PhaseOneSandbox, mixedSenses: null, failed: false };
  }

  const result = runSenseSelection(entries, SENSE_QUESTIONS_MIXED_PICK, language, 2);
  if (!result.complete) return { complete: false, nextQuestionText: result.nextQuestionText, failed: false };
  if ("failed" in result) return FAILED;
  const [first, second] = result.picked;
  return {
    complete: true,
    // "Mixed" has no direct PhaseOneSandbox slot of its own — the primary
    // (first-picked) sense is what Layer Two routes on; the pair is carried
    // separately for card guidance to reference. See the report's documented
    // simplification.
    resolvedSandbox: first as PhaseOneSandbox,
    mixedSenses: [first, second] as [ClarificationSense, ClarificationSense],
    failed: false,
  };
}
