/* eslint-disable no-console */
import { runRacerTurn } from "../lib/prompts/racer";
import type { RacerPublicState } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.5 STEP 0 — Grok Racer latency and tool-contract probe.
//
// Answers three questions without a game, a deploy, or a corpus write:
//
//   1. Does grok-4.20-0309-non-reasoning honour Barkóba's forced-tool contract?
//   2. How slow is it, really, next to grok-4.6?
//   3. Is grok-4.6 at reasoning_effort "low" materially faster than the default?
//
// and SCREENS a fourth — are the questions obviously malformed — without
// claiming anything about strategic quality, which one question from a frozen
// position cannot show.
//
// ---------------------------------------------------------------------------
// WHY THIS CALLS runRacerTurn INSTEAD OF BUILDING ITS OWN REQUEST
// ---------------------------------------------------------------------------
//
// The control is that this harness IMPORTS rather than RESTATES. Every
// configuration below goes through the real RACER_SYSTEM_PROMPT, the real
// turnInputSchema, the real xAI adapter and the real response parsing. A probe
// that rebuilt the request would measure a copy of Barkóba, and the one thing
// worth knowing here is what BARKÓBA's own call costs.
//
// The only per-configuration differences are the model id and the reasoning
// effort. Prompt, schema, transcript and budget are byte-identical throughout.
// That is the experiment.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT DO
// ---------------------------------------------------------------------------
//
// It plays no game, writes nothing to Redis or the corpus, and changes no
// production behaviour. Nothing in the turn loop passes reasoningEffort, so
// every real Grok turn still runs at the provider default.
//
//   Run:  npx tsx scripts/probeRacerLatency.ts
//   Needs: XAI_API_KEY in the environment.
// ---------------------------------------------------------------------------

const RUNS_PER_CONFIG = 3;

interface Config {
  label: string;
  model: string;
  effort?: string;
  /** Candidate A must clear the contract before its latency means anything. */
  contractGate?: boolean;
}

const CONFIGS: Config[] = [
  { label: "1. grok-4.6 / effort unset (PRODUCTION CONTROL)", model: "grok-4.6" },
  { label: "2. grok-4.6 / low", model: "grok-4.6", effort: "low" },
  {
    label: "3. grok-4.20-0309-non-reasoning (CANDIDATE A)",
    model: "grok-4.20-0309-non-reasoning",
    contractGate: true,
  },
  { label: "4. grok-4.3 / none (RESERVE)", model: "grok-4.3", effort: "none" },
];

/**
 * THE FROZEN POSITION. Identical for every call, which is what makes the
 * comparison a comparison.
 *
 * A realistic mid-scout Barkóba state: six answered questions, two YES and four
 * NO, the space narrowed to "man-made, not alive, too big for a hand, no
 * electronics, not a building". Deliberately BELOW any plausible escalation
 * threshold — this is the position a fast scout would actually be asked to play.
 */
const FROZEN_STATE: RacerPublicState = {
  question_count: 6,
  max_questions: 20,
  questions_remaining: 14,
  game_language: "hu",
  clues: [],
  clue_credits_available: 0,
  transcript: [
    {
      turn_index: 1,
      question: "A cél valóságos, vagy valaha valóságosan létezett — tehát nem kitalált?",
      answer: "YES",
      ambiguous_explanation: null,
    },
    { turn_index: 2, question: "Élőlény?", answer: "NO", ambiguous_explanation: null },
    { turn_index: 3, question: "Ember alkotta?", answer: "YES", ambiguous_explanation: null },
    { turn_index: 4, question: "Elfér egy kézben?", answer: "NO", ambiguous_explanation: null },
    {
      turn_index: 5,
      question: "Van benne elektronika?",
      answer: "NO",
      ambiguous_explanation: null,
    },
    {
      turn_index: 6,
      question: "Épület vagy építmény?",
      answer: "NO",
      ambiguous_explanation: null,
    },
  ],
};

interface Result {
  config: string;
  run: number;
  ok: boolean;
  ms: number;
  resolvedModel: string | null;
  action: string | null;
  text: string | null;
  rationale: string | null;
  finishReason: string | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  error: string | null;
  /** Contract: a usable turn, in the shape the engine requires. */
  contractOk: boolean;
  formFlags: string[];
}

/**
 * The forced-tool contract, exactly as the engine needs it — not as the API
 * defines it. A 200 that yields no usable move is a contract failure.
 */
function checkContract(action: string | null, text: string | null, rationale: string | null) {
  if (action === null) return { ok: false, why: "no action returned" };
  if (!["question", "guess", "concede", "clue"].includes(action)) {
    return { ok: false, why: `action outside the enum: ${action}` };
  }
  if (action === "question" && !text) return { ok: false, why: "question with no text" };
  if (action === "guess" && !text) return { ok: false, why: "guess with no text" };
  if (typeof rationale !== "string") return { ok: false, why: "rationale missing" };
  return { ok: true, why: "" };
}

/**
 * OBVIOUS form problems only. Flags are for a human to read, never a verdict —
 * the brief is explicit that no strategic quality claim comes out of this probe.
 */
function screenForm(action: string | null, text: string | null): string[] {
  const flags: string[] = [];
  if (action !== "question" || !text) return flags;

  // Hungarian: the game language is "hu" and the prompt says so. Accented
  // characters are a crude but serviceable tell.
  if (!/[áéíóöőúüű]/i.test(text)) flags.push("MAYBE-NOT-HUNGARIAN");
  // Compound questions force IS-IS by construction — the §24 benchmark.
  if (/\bvagy\b/i.test(text) && /,/.test(text)) flags.push("MAYBE-COMPOUND");
  if ((text.match(/\?/g) ?? []).length > 1) flags.push("MULTIPLE-QUESTION-MARKS");
  // A question naming one specific candidate is a guess in disguise; the live
  // Guess Detector would flag it.
  if (/^\s*(ez|az)\s+egy\b/i.test(text)) flags.push("MAYBE-SPECIFIC-CANDIDATE");
  return flags;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

async function probe(config: Config, run: number): Promise<Result> {
  // env.xaiModelRacer() reads process.env at call time, so this selects the
  // model without touching any game code path.
  process.env.XAI_MODEL_RACER = config.model;

  const base = {
    config: config.label,
    run,
    resolvedModel: null,
    action: null,
    text: null,
    rationale: null,
    finishReason: null,
    completionTokens: null,
    reasoningTokens: null,
  };

  const started = performance.now();
  try {
    const result = await runRacerTurn(FROZEN_STATE, {
      forceFinal: false,
      provider: "xai",
      reasoningEffort: config.effort,
    });
    const ms = Math.round(performance.now() - started);

    const action = result.output.action;
    const text = result.output.question_text ?? result.output.guess_text ?? null;
    const rationale = result.output.rationale ?? null;
    const contract = checkContract(action, text, rationale);

    return {
      ...base,
      ok: true,
      ms,
      resolvedModel: result.provenance.model_id,
      action,
      text,
      rationale,
      finishReason: result.diagnostics?.finishReason ?? null,
      completionTokens: result.diagnostics?.completionTokens ?? null,
      reasoningTokens: result.diagnostics?.reasoningTokens ?? null,
      error: contract.ok ? null : `CONTRACT: ${contract.why}`,
      contractOk: contract.ok,
      formFlags: screenForm(action, text),
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      ms: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
      contractOk: false,
      formFlags: [],
    };
  }
}

async function main(): Promise<void> {
  if (!process.env.XAI_API_KEY) {
    console.error("XAI_API_KEY is not set. Nothing was called.");
    process.exit(1);
  }

  console.log("\nBarkóba — Grok Racer probe");
  console.log(`Frozen position: ${FROZEN_STATE.transcript.length} answered questions, `
    + `${FROZEN_STATE.question_count}/${FROZEN_STATE.max_questions} used, language `
    + `${FROZEN_STATE.game_language}. Identical for every call.`);
  console.log(`${CONFIGS.length} configurations x ${RUNS_PER_CONFIG} runs\n`);

  const all: Result[] = [];

  for (const config of CONFIGS) {
    console.log(`\n--- ${config.label}`);
    console.log(`    model=${config.model} effort=${config.effort ?? "(unset)"}`);

    for (let run = 1; run <= RUNS_PER_CONFIG; run += 1) {
      const r = await probe(config, run);
      all.push(r);

      if (!r.ok) {
        console.log(`  run ${run}: FAILED after ${r.ms}ms — ${r.error}`);
        continue;
      }
      console.log(
        `  run ${run}: ${(r.ms / 1000).toFixed(1)}s  action=${r.action}` +
          `  contract=${r.contractOk ? "OK" : "FAIL"}` +
          (r.finishReason ? `  finish=${r.finishReason}` : "") +
          (r.completionTokens !== null ? `  out_tokens=${r.completionTokens}` : "") +
          (r.reasoningTokens !== null ? `  reasoning_tokens=${r.reasoningTokens}` : "")
      );
      console.log(`         resolved=${r.resolvedModel}`);
      console.log(`         Q: ${r.text ?? "(none)"}`);
      console.log(`         R: ${r.rationale ?? "(none)"}`);
      if (r.formFlags.length > 0) console.log(`         FLAGS: ${r.formFlags.join(", ")}`);
      if (r.error) console.log(`         ${r.error}`);
    }
  }

  console.log("\n\n=== SUMMARY ===\n");
  console.log(
    "configuration".padEnd(46) +
      "ok".padEnd(6) +
      "contract".padEnd(10) +
      "median".padEnd(9) +
      "min".padEnd(8) +
      "max"
  );

  for (const config of CONFIGS) {
    const rs = all.filter((r) => r.config === config.label);
    const good = rs.filter((r) => r.ok);
    const times = good.map((r) => r.ms);
    const contract = rs.filter((r) => r.contractOk).length;

    console.log(
      config.label.slice(0, 45).padEnd(46) +
        `${good.length}/${rs.length}`.padEnd(6) +
        `${contract}/${rs.length}`.padEnd(10) +
        (times.length ? `${(median(times) / 1000).toFixed(1)}s`.padEnd(9) : "—".padEnd(9)) +
        (times.length ? `${(Math.min(...times) / 1000).toFixed(1)}s`.padEnd(8) : "—".padEnd(8)) +
        (times.length ? `${(Math.max(...times) / 1000).toFixed(1)}s` : "—")
    );
  }

  const gated = CONFIGS.filter((c) => c.contractGate);
  for (const config of gated) {
    const rs = all.filter((r) => r.config === config.label);
    const pass = rs.filter((r) => r.contractOk).length;
    console.log(
      `\nCONTRACT GATE — ${config.model}: ${pass}/${rs.length}.` +
        (pass === rs.length
          ? " Contract satisfied; latency numbers are meaningful."
          : " NOT 3/3 — this candidate is dead. Barkóba must not be adapted to fit it.")
    );
  }

  console.log(
    "\nMedian <=15s was proposed as a provisional usability reference, not a" +
      "\nthreshold. These are the numbers; the decision is yours.\n"
  );
}

void main();
