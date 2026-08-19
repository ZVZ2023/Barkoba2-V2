import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CORE_RACER_RULES,
  RACER_PROMPT_VERSION,
  buildGuessIntentMessage,
  buildRacerTurnMessage,
  resolveGuessIntent,
  runRacerTurn,
} from "../lib/prompts/racer";
import { anthropicAdapter } from "../lib/providers/anthropic";
import { xaiAdapter } from "../lib/providers/xai";
import type { ToolCallRequest, ToolCallResult } from "../lib/providers/types";
import { QUESTION_BUDGETS } from "../lib/questionBudget";
import { toRacerPublicState } from "../lib/racerState";
import type { ComposerAnswer, GameRecord, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// RG V2 — the canonical trailing structured-deliberation block.
//
// WHAT THESE TESTS DO NOT ATTEMPT: to show that the Racer plays better. That is
// a field-play question and no unit test can answer it. What is provable here
// is everything the evidence record depends on — that the block reaches the
// model, that it reaches both providers identically, that it never touches the
// human's answer or the visible transcript, and that `racer/2.7.0` cannot be
// stamped on a turn that did not carry it.
// ---------------------------------------------------------------------------

function entry(o: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(), turn_index: 1, turn_type: "question", racer_output_raw: "",
    question_text: "Is the target a physical object?", guess_text: null,
    composer_response: null, ambiguous_explanation: null,
    guess_detector_flagged: false, guess_detector_method: null,
    guess_intent_outcome: null, clue_text: null, original_question_text: null,
    edit_status: null, edit_reason: null, ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(),
    model_id: null, model_provider: null, prompt_version: null,
    answered_at: null, pre_revision_question_text: null,
    quality_score: null, information_gain: null, strategy_classification: null,
    integrity_flag: null, confidence: null, latency_ms: null,
    ...o,
  };
}

function game(log: QuestionLogEntry[]): GameRecord {
  return {
    game_id: randomUUID(), player_id: null,
    composer_player_id: null, racer_player_id: null, join_code: null,
    phase: "questioning", created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(), max_questions: 20, game_language: "en",
    private_target: false, composer_kind: "human", racer_kind: "ai",
    racer_provider: null, difficulty: null, clue_mode: null,
    question_count: log.length, ambiguous_count: 0, qa_log: log,
    final_action: null, final_guess_text: null, result: null,
    integrity_notes: null, integrity_flagged_turns: null, adjudication_notes: null,
    adjudicator_verdict: null, integrity_verdict: null, adjudication_confidence: null,
    revealed_target: null, revealed_definition: null, revealed_granularity: null,
    revealed_modifiers: null, revealed_locked_at: null,
    corrections: [], abandoned_branches: [], clarification_prompt: null,
    benchmark_case_id: null, benchmark_run_id: null,
  };
}

/** A game whose most recent question has just been answered `answer`. */
function answeredWith(answer: ComposerAnswer, explanation: string | null = null) {
  return toRacerPublicState(
    game([
      entry({
        turn_index: 1,
        composer_response: answer,
        ambiguous_explanation: explanation,
        answered_at: new Date().toISOString(),
      }),
    ])
  );
}

// ---------------------------------------------------------------------------
// Presence, and position.
// ---------------------------------------------------------------------------

test("the block is present after a human answer, verbatim", () => {
  const content = buildRacerTurnMessage(answeredWith("YES"), {
    forceFinal: false,
    clueAvailable: false,
  });
  assert.ok(content.includes(CORE_RACER_RULES));
});

test("POSITION IS THE INTERVENTION: the block is last, immediately before the instruction", () => {
  // The whole mechanism, asserted. The Racer is stateless and already receives
  // the full system prompt every turn, so this change is about WHERE the
  // strategy sits relative to a growing transcript — not about repetition.
  const content = buildRacerTurnMessage(answeredWith("NO"), {
    forceFinal: false,
    clueAvailable: false,
  });
  assert.ok(
    content.endsWith(`${CORE_RACER_RULES}\n\nTake your turn.`),
    `block must be the last thing before the instruction; tail was:\n${content.slice(-400)}`
  );
});

test("the block survives a long transcript — it does not get pushed up by history", () => {
  const long = Array.from({ length: 19 }, (_, i) =>
    entry({
      turn_index: i + 1,
      question_text: `Question number ${i + 1}?`,
      composer_response: i % 2 === 0 ? "YES" : "NO",
    })
  );
  const content = buildRacerTurnMessage(toRacerPublicState(game(long)), {
    forceFinal: false,
    clueAvailable: false,
  });
  assert.ok(content.endsWith(`${CORE_RACER_RULES}\n\nTake your turn.`));
});

test("the block is present on the final turn too", () => {
  // The final-guess gate governs this moment, and an unconditional block is what
  // keeps racer/2.7.0 true of EVERY stamped turn rather than most of them.
  const content = buildRacerTurnMessage(answeredWith("YES"), {
    forceFinal: true,
    clueAvailable: false,
  });
  assert.ok(content.endsWith(`${CORE_RACER_RULES}\n\nMake your final move.`));
});

for (const answer of ["YES", "NO", "AMBIGUOUS"] as ComposerAnswer[]) {
  test(`the block is present after a ${answer} answer`, () => {
    const state = answeredWith(
      answer,
      answer === "AMBIGUOUS" ? "It depends which sense of the word you mean." : null
    );
    const content = buildRacerTurnMessage(state, { forceFinal: false, clueAvailable: false });
    assert.ok(content.includes(CORE_RACER_RULES));
    // The answer itself still reaches the model, unaltered and separately.
    assert.ok(content.includes(`A1: ${answer}`));
  });
}

test("an AMBIGUOUS explanation is still carried, and is not displaced by the block", () => {
  const content = buildRacerTurnMessage(
    answeredWith("AMBIGUOUS", "Both readings are defensible."),
    { forceFinal: false, clueAvailable: false }
  );
  assert.ok(content.includes("Note: Both readings are defensible."));
  assert.ok(content.includes(CORE_RACER_RULES));
});

test("RG V2 contains the complete ordered deliberation contract", () => {
  const stages = [
    "1. RECONSTRUCT",
    "2. INFER",
    "3. HYPOTHESIZE",
    "4. MAP DIMENSIONS",
    "5. GENERATE OPTIONS",
    "6. COMPARE",
    "7. CONSISTENCY GATE",
  ];
  let previous = -1;
  for (const stage of stages) {
    const at = CORE_RACER_RULES.indexOf(stage);
    assert.ok(at > previous, `${stage} must occur once and in order`);
    previous = at;
  }
  assert.match(
    CORE_RACER_RULES,
    /CANDIDATE → CONSTRAINT CHECK → ALTERNATIVES → DISCRIMINATOR → GUESS/
  );
  assert.match(CORE_RACER_RULES, /Emit only one player-facing question/);
});

function promptFor(log: QuestionLogEntry[]): string {
  return buildRacerTurnMessage(toRacerPublicState(game(log)), {
    forceFinal: false,
    clueAvailable: false,
  });
}

test("a European automobile state carries a dimension-first alternative to country enumeration", () => {
  const content = promptFor([
    entry({ turn_index: 1, question_text: "Is it a physical object?", composer_response: "YES" }),
    entry({ turn_index: 2, question_text: "Is it a vehicle?", composer_response: "YES" }),
    entry({ turn_index: 3, question_text: "Is it an automobile?", composer_response: "YES" }),
    entry({ turn_index: 4, question_text: "Is it European?", composer_response: "YES" }),
  ]);
  assert.match(content, /Q4: Is it European\?\nA4: YES/);
  assert.match(content, /MAP DIMENSIONS/);
  assert.match(content, /Avoid country-by-country enumeration/);
  assert.match(content, /time \/ era; geography \/ geopolitical origin; purpose \/ function/);
});

test("strong positive evidence is paired with intelligent narrowing guidance", () => {
  const content = promptFor([
    entry({
      turn_index: 1,
      question_text: "Was it made for competitive motorsport?",
      composer_response: "YES",
    }),
  ]);
  assert.match(content, /A1: YES/);
  assert.match(content, /YES: Exploit it\. Narrow intelligently within the supported branch\./);
});

test("repeated negative evidence is paired with parent-level reconsideration", () => {
  const content = promptFor([
    entry({ turn_index: 1, question_text: "Is it German?", composer_response: "NO" }),
    entry({ turn_index: 2, question_text: "Is it French?", composer_response: "NO" }),
  ]);
  assert.match(content, /A1: NO/);
  assert.match(content, /A2: NO/);
  assert.match(content, /Update the parent hypothesis, not merely the rejected child candidate/);
  assert.match(
    content,
    /Repeated NO evidence within one branch increases pressure to abandon that branch/
  );
});

test("pre-1970 evidence is reconstructed with era available as a meaningful dimension", () => {
  const content = promptFor([
    entry({
      turn_index: 1,
      question_text: "Was it first produced before 1970?",
      composer_response: "YES",
    }),
  ]);
  assert.match(content, /Q1: Was it first produced before 1970\?\nA1: YES/);
  assert.match(content, /time \/ era/);
  assert.match(content, /Derive implications that logically follow from established constraints/);
});

test("a plausible candidate with alternatives remaining receives the pre-guess gate", () => {
  const content = promptFor([
    entry({
      turn_index: 1,
      question_text: "Is it an Italian sports car?",
      composer_response: "YES",
    }),
  ]);
  assert.match(content, /What other credible candidates still satisfy them\?/);
  assert.match(
    content,
    /If more than one remains and questions remain, what question best separates them\?/
  );
  assert.match(content, /Do not guess merely because one candidate feels plausible/);
});

// ---------------------------------------------------------------------------
// No contamination of the human's answer or the visible transcript.
// ---------------------------------------------------------------------------

test("the stored human answer is untouched", () => {
  const log = [entry({ turn_index: 1, composer_response: "NO" })];
  const g = game(log);
  const before = JSON.stringify(g.qa_log);

  buildRacerTurnMessage(toRacerPublicState(g), { forceFinal: false, clueAvailable: false });

  assert.equal(JSON.stringify(g.qa_log), before, "assembly must not mutate game state");
  assert.equal(g.qa_log[0]?.composer_response, "NO");
  assert.equal(
    g.qa_log[0]?.question_text?.includes("RACER GUIDANCE V2"),
    false,
    "the reminder must never be persisted as part of a turn"
  );
});

test("the visible transcript contains no trace of the block", () => {
  // The player-facing projections. Neither is built from the Racer message, and
  // this pins that they cannot become so.
  const g = game([entry({ turn_index: 1, composer_response: "YES" })]);
  const racerState = toRacerPublicState(g);

  for (const turn of racerState.transcript) {
    assert.equal(turn.question.includes("RACER GUIDANCE V2"), false);
    assert.equal((turn.ambiguous_explanation ?? "").includes("RACER GUIDANCE V2"), false);
  }
  assert.equal(JSON.stringify(g).includes("RACER GUIDANCE V2"), false);
});

test("the reminder is not addressed as though the human said it", () => {
  const content = buildRacerTurnMessage(answeredWith("NO"), {
    forceFinal: false,
    clueAvailable: false,
  });
  // The transcript block ends before the clue line; the rules sit after both,
  // as standing instruction rather than as anything attributed to a player.
  const transcriptEnd = content.indexOf("Clues given so far");
  const rulesAt = content.indexOf(CORE_RACER_RULES);
  assert.ok(transcriptEnd > 0 && rulesAt > transcriptEnd, "rules must follow the transcript");
});

// ---------------------------------------------------------------------------
// Provider parity — captured at the adapter boundary.
// ---------------------------------------------------------------------------

/**
 * Capture what each transport is actually handed.
 *
 * Replacing `callTool` on the adapter objects is what makes this a real
 * end-to-end assertion rather than a restatement of the assembly. It exercises
 * runRacerTurn, the registry and the guard — everything up to the wire.
 */
async function captureRequest(provider: "anthropic" | "xai"): Promise<ToolCallRequest> {
  const adapter = provider === "anthropic" ? anthropicAdapter : xaiAdapter;
  const original = adapter.callTool;
  let captured: ToolCallRequest | null = null;

  adapter.callTool = (async (request: ToolCallRequest) => {
    captured = request;
    return {
      output: { action: "question", question_text: "stub?", guess_text: null, rationale: "" },
      resolvedModel: `${provider}-stub`,
    } as ToolCallResult<unknown>;
  }) as typeof adapter.callTool;

  try {
    await runRacerTurn(answeredWith("NO"), { forceFinal: false, provider });
  } finally {
    adapter.callTool = original;
  }

  assert.ok(captured, "the adapter was never called");
  return captured as unknown as ToolCallRequest;
}

test("Claude and Grok receive byte-identical strategy text before transport", async () => {
  const [claude, grok] = await Promise.all([
    captureRequest("anthropic"),
    captureRequest("xai"),
  ]);

  assert.equal(claude.system, grok.system, "system prompt must not differ by provider");
  assert.deepEqual(
    claude.messages,
    grok.messages,
    "the assembled turn message must not differ by provider"
  );
  for (const req of [claude, grok]) {
    assert.ok(req.messages[0]?.content.includes(CORE_RACER_RULES));
  }
});

test("no provider module authors, suppresses or rewrites the strategy text", () => {
  // Adapters transport a prompt; they never write one. If any fragment of the
  // canonical block appears in a transport, a provider-specific strategy
  // advantage has been created.
  for (const file of [
    "lib/providers/anthropic.ts",
    "lib/providers/xai.ts",
    "lib/providers/index.ts",
    "lib/providers/types.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.equal(
      /RACER GUIDANCE V2|CORE_RACER_RULES/.test(src),
      false,
      `${file} must not contain strategy text`
    );
  }
});

// ---------------------------------------------------------------------------
// Provenance — the database claim.
// ---------------------------------------------------------------------------

test("the Racer guidance version is racer/2.7.0", () => {
  assert.equal(RACER_PROMPT_VERSION, "racer/2.7.0");
  assert.notEqual(RACER_PROMPT_VERSION, "racer/2.6.0", "the old version must not be reused");
});

test("a stamped turn carries the version AND the guidance, and model identity is unchanged", async () => {
  const captured = await captureRequest("xai");
  assert.ok(captured.messages[0]?.content.includes(CORE_RACER_RULES));

  const adapter = xaiAdapter;
  const original = adapter.callTool;
  adapter.callTool = (async () => ({
    output: { action: "question", question_text: "q?", guess_text: null, rationale: "" },
    resolvedModel: "grok-4.20-0309-non-reasoning",
  })) as typeof adapter.callTool;
  try {
    const result = await runRacerTurn(answeredWith("NO"), {
      forceFinal: false,
      provider: "xai",
    });
    assert.equal(result.provenance.prompt_version, "racer/2.7.0");
    // Model identity must be exactly as before — the intervention changes
    // guidance, not who is playing.
    assert.equal(result.provenance.model_provider, "xai");
    assert.equal(result.provenance.model_id, "grok-4.20-0309-non-reasoning");
  } finally {
    adapter.callTool = original;
  }
});

test("STRUCTURAL GUARANTEE: the version cannot be stamped without the block", () => {
  // The claim racer/2.7.0 makes to the corpus is verified against the assembled
  // message, not asserted beside it. This pins that the guard exists and that
  // it is unconditional — the failure it prevents is a corpus full of turns
  // claiming guidance they never received, which is worse than no label at all.
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  assert.match(src, /function assertGuidanceApplied/);
  assert.match(src, /if \(!content\.includes\(CORE_RACER_RULES\)\)/);
  assert.match(src, /assertGuidanceApplied\(content\)/);
  // The block is appended unconditionally — no ternary, no feature flag, no
  // provider branch could make it conditional without this failing.
  assert.equal(
    /CORE_RACER_RULES\s*[:?]/.test(src),
    false,
    "the block must not be applied conditionally"
  );
});

test("the canonical text is preserved in the design record against racer/2.7.0", () => {
  const notes = readFileSync("docs/DESIGN-NOTES.md", "utf8");
  assert.ok(
    notes.includes(CORE_RACER_RULES),
    "DESIGN-NOTES must reproduce the canonical block verbatim"
  );
  assert.ok(notes.includes("racer/2.7.0"));
});

// ---------------------------------------------------------------------------
// Nothing else moved.
// ---------------------------------------------------------------------------

test("RG V2 adds no model call and leaves question budgets unchanged", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  const turnPath = src.slice(
    src.indexOf("export async function runRacerTurn"),
    src.indexOf("export async function resolveGuessIntent")
  );
  const revisionPath = src.slice(src.indexOf("export async function resolveGuessIntent"));
  assert.equal(
    (turnPath.match(/\.callTool</g) ?? []).length,
    1,
    "a normal Racer turn must still make exactly one model call"
  );
  assert.equal(
    (revisionPath.match(/\.callTool</g) ?? []).length,
    1,
    "the existing revision path must still make exactly one model call when invoked"
  );
  assert.deepEqual(QUESTION_BUDGETS, [20, 35, 50, 100]);
});

test("the Guess Detector's own logic is untouched", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  // The guess-intent SYSTEM prompt is unchanged — only the assembled user
  // message gained the trailing block. The detector itself is a separate,
  // deterministic module this change never reaches.
  assert.match(src, /GUESS_INTENT_SYSTEM_PROMPT/);
  const systemPrompt = src.slice(
    src.indexOf("const GUESS_INTENT_SYSTEM_PROMPT"),
    src.indexOf("function turnInputSchema")
  );
  assert.ok(systemPrompt.length > 0);
  assert.equal(
    /RACER GUIDANCE V2|RECONSTRUCT/.test(systemPrompt),
    false,
    "the guess-intent system prompt must stay unedited"
  );
  const detector = readFileSync("lib/guessDetector.ts", "utf8");
  assert.equal(/RACER GUIDANCE V2|CORE_RACER_RULES/.test(detector), false);
});

// ---------------------------------------------------------------------------
// THE GUESS-INTENT REVISION PATH.
//
// The audit gap this closes: `continue_questioning` returns a revised_question
// that REPLACES the original in question_text, so it — not the first attempt —
// is the question the human actually sees. Stamping racer/2.7.0 while that
// question was authored without the block would make the version true of a
// draft and false of the record. §32 measured 10 of ~20 turns flagged in one
// game, so the gap was material rather than theoretical.
// ---------------------------------------------------------------------------

test("the revision path carries the canonical block, trailing", () => {
  const content = buildGuessIntentMessage(answeredWith("NO"), "Is the target GPT-4?");
  assert.ok(content.includes(CORE_RACER_RULES));
  assert.ok(
    content.endsWith(`${CORE_RACER_RULES}\n\nDeclare your intent.`),
    `tail was:\n${content.slice(-300)}`
  );
});

test("the revision path still carries the flagged question and the transcript", () => {
  // The block must be additive. If it displaced the task, the resolution would
  // be answering a different question than the one that was flagged.
  const content = buildGuessIntentMessage(answeredWith("NO"), "Is the target GPT-4?");
  assert.ok(content.includes("The question that was flagged: Is the target GPT-4?"));
  assert.ok(content.includes("Transcript so far:"));
  assert.ok(content.includes("A1: NO"));
});

test("the canonical block is SINGLE-SOURCED across both authoring paths", () => {
  // Two divergent literals under one version string would make the audit claim
  // unfalsifiable. This proves both assemblies embed the same constant rather
  // than two texts that merely look alike today.
  const turn = buildRacerTurnMessage(answeredWith("NO"), {
    forceFinal: false,
    clueAvailable: false,
  });
  const revision = buildGuessIntentMessage(answeredWith("NO"), "Is the target GPT-4?");
  assert.ok(turn.includes(CORE_RACER_RULES));
  assert.ok(revision.includes(CORE_RACER_RULES));

  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  const definitions =
    src.match(/RACER GUIDANCE V2 — STRUCTURED DELIBERATION — APPLY EVERY TURN/g) ?? [];
  assert.equal(definitions.length, 1, "exactly one definition of the canonical text");
});

/** Capture what a transport is handed on the guess-intent path. */
async function captureIntentRequest(provider: "anthropic" | "xai"): Promise<ToolCallRequest> {
  const adapter = provider === "anthropic" ? anthropicAdapter : xaiAdapter;
  const original = adapter.callTool;
  let captured: ToolCallRequest | null = null;

  adapter.callTool = (async (request: ToolCallRequest) => {
    captured = request;
    return {
      output: {
        resolution: "continue_questioning",
        guess_text: null,
        revised_question: "Does the target predate 2023?",
      },
      resolvedModel: `${provider}-stub`,
    } as ToolCallResult<unknown>;
  }) as typeof adapter.callTool;

  try {
    await resolveGuessIntent(answeredWith("NO"), "Is the target GPT-4?", provider);
  } finally {
    adapter.callTool = original;
  }

  assert.ok(captured, "the adapter was never called");
  return captured as unknown as ToolCallRequest;
}

test("continue_questioning produces a revised question under the canonical guidance", async () => {
  const original = xaiAdapter.callTool;
  let seen: ToolCallRequest | null = null;
  xaiAdapter.callTool = (async (request: ToolCallRequest) => {
    seen = request;
    return {
      output: {
        resolution: "continue_questioning",
        guess_text: null,
        revised_question: "Does the target predate 2023?",
      },
      resolvedModel: "grok-stub",
    } as ToolCallResult<unknown>;
  }) as typeof xaiAdapter.callTool;

  try {
    const r = await resolveGuessIntent(answeredWith("NO"), "Is the target GPT-4?", "xai");
    assert.equal(r.resolution, "continue_questioning");
    assert.equal(r.revised_question, "Does the target predate 2023?");
  } finally {
    xaiAdapter.callTool = original;
  }

  // The question the human will actually see was authored with the block present.
  assert.ok(
    (seen as unknown as ToolCallRequest).messages[0]?.content.includes(CORE_RACER_RULES)
  );
});

test("Claude and Grok receive identical guidance on the revision path too", async () => {
  const [claude, grok] = await Promise.all([
    captureIntentRequest("anthropic"),
    captureIntentRequest("xai"),
  ]);
  assert.equal(claude.system, grok.system);
  assert.deepEqual(claude.messages, grok.messages);
  for (const req of [claude, grok]) {
    assert.ok(req.messages[0]?.content.includes(CORE_RACER_RULES));
  }
});

test("BOTH authoring paths are guarded — neither can run without the block", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  const guards = src.match(/assertGuidanceApplied\(content\)/g) ?? [];
  assert.equal(
    guards.length,
    2,
    "runRacerTurn and resolveGuessIntent must each verify the assembled message"
  );
  // The guard's own predicate, pinned so it cannot be softened into a warning.
  assert.match(src, /if \(!content\.includes\(CORE_RACER_RULES\)\)[\s\S]{0,120}throw new Error/);
});

test("the revision path does not contaminate the human's answer or the transcript", () => {
  const g = game([entry({ turn_index: 1, composer_response: "NO" })]);
  const before = JSON.stringify(g.qa_log);
  buildGuessIntentMessage(toRacerPublicState(g), "Is the target GPT-4?");
  assert.equal(JSON.stringify(g.qa_log), before);
  assert.equal(JSON.stringify(g).includes("RACER GUIDANCE V2"), false);
});

test("no Contest Verdict code path is touched", () => {
  for (const file of [
    "lib/corpus/gameContests.ts",
    "app/api/contest/[id]/route.ts",
    "app/api/game/[id]/contest/route.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.equal(
      /CORE_RACER_RULES|RACER_PROMPT_VERSION/.test(src),
      false,
      `${file} must be unrelated to Racer guidance`
    );
  }
});

test("the system prompt was NOT edited — one experimental variable, not two", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  const system = src.slice(
    src.indexOf("const RACER_SYSTEM_PROMPT"),
    src.indexOf("const GUESS_INTENT_SYSTEM_PROMPT")
  );
  assert.ok(system.length > 0);
  assert.equal(
    /RACER GUIDANCE V2|RECONSTRUCT/.test(system),
    false,
    "structured deliberation must live only in the trailing block"
  );
});
