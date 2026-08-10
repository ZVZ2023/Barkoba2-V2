import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requestClueFromComposer } from "../lib/prompts/composerAnswer";

/** TASK 10 — clue policy, disclosure, and Racer request discipline. */

test("a no-clue game returns no clue without ever calling the model", async () => {
  // No API key is configured here; if this reached the model it would throw.
  const result = await requestClueFromComposer({
    target: "bicikli", definition: "a kerékpár", granularity: "generic_type",
    modifiers: null, qaLog: [], questionsAsked: 10, maxQuestions: 20,
    clueMode: "none", gameLanguage: "hu",
  });
  assert.equal(result.clue_text, null);
  assert.equal(result.redacted, false);
});

test("a requested clue passes through the disclosure guard", () => {
  const src = readFileSync("lib/prompts/composerAnswer.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function requestClueFromComposer"));
  assert.match(fn, /scrubClue\(/, "requested clues must be scrubbed like every other visible string");
});

test("the requested clue reuses the existing clue policy, not a second one", () => {
  const src = readFileSync("lib/prompts/composerAnswer.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function requestClueFromComposer"));
  assert.match(fn, /CLUE_GUIDANCE\[params\.clueMode\]/, "must use the shared clue guidance");
  assert.match(fn, /GRANULARITY_RULE\[params\.granularity\]/);
});

test("progressive calibrates to remaining budget; minimal stays restrained", () => {
  const src = readFileSync("lib/prompts/composerAnswer.ts", "utf8");
  const guidance = src.slice(src.indexOf("const CLUE_GUIDANCE"), src.indexOf("function renderTranscript"));
  assert.match(guidance, /minimal: `CLUES: minimal\./);
  assert.match(guidance, /restraint is the point/);
  assert.match(guidance, /progressive: `CLUES: progressive\./);
  assert.match(guidance, /your help should grow as the player's remaining questions shrink/);
  // The ceiling that keeps it a game in both modes.
  assert.match(guidance, /do not name the target/);
  // And the request path is told how much budget is left.
  const fn = src.slice(src.indexOf("export async function requestClueFromComposer"));
  assert.match(fn, /Questions used: \$\{params\.questionsAsked\}/);
  assert.match(fn, /Remaining: \$\{remaining\}/);
});

test("the Racer is offered a clue action only when a credit exists", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  assert.match(src, /clueAvailable\s*\n?\s*\?\s*\["question", "clue", "guess", "concede"\]/);
  assert.match(src, /state\.clue_credits_available > 0/);
});

test("the Racer cannot mint a credit it was not offered", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  assert.match(src, /action === "clue" && !clueAvailable \? "question" : action/);
});

test("eligibility is stated as an option, never an instruction", () => {
  const src = readFileSync("lib/prompts/racer.ts", "utf8");
  assert.match(src, /Being allowed to ask is not a reason to ask/);
});

test("an outstanding clue request halts the Racer instead of burning a turn", () => {
  const src = readFileSync("app/api/game/[id]/turn/route.ts", "utf8");
  assert.match(src, /pendingClueRequest\(game\)/);
});

test("the clue route never touches question_count or the final guess", () => {
  const src = readFileSync("app/api/game/[id]/clue/route.ts", "utf8");
  assert.doesNotMatch(src, /question_count\s*(\+=|=)/, "a clue must not cost a question");
  assert.doesNotMatch(src, /final_guess_text\s*=/, "a clue must not touch the guess");
  assert.doesNotMatch(src, /final_action\s*=/);
  assert.doesNotMatch(src, /composer_response\s*=/, "a clue must never become an answer");
});

test("player-facing terminology says Célpont, not Titok, for locking", () => {
  const src = readFileSync("app/ComposerEntry.tsx", "utf8");
  assert.match(src, /Célpont rögzítése/);
  assert.doesNotMatch(src, /Titok rögzítése/);
});

test("the ratified V1 question budgets are unchanged", () => {
  const src = readFileSync("app/RacerSetup.tsx", "utf8");
  assert.match(src, /const BUDGETS = \[20, 35, 50, 100\];/);
});

// ---------------------------------------------------------------------------
// TASK 11 — one help channel.
//
// Through 0.9.8.0 the ordinary answer call carried CLUE_GUIDANCE and its schema
// required a clue_text field, so the Composer supplied a clue with every YES and
// NO. That was an uncapped second help channel running beside the earned one,
// and no test pinned it — which is precisely why it reached a field tester.
// ---------------------------------------------------------------------------

/**
 * Source with comments stripped.
 *
 * These tests isolate one function and assert on what it contains, so the
 * boundary between functions has to be found by slicing. Two things kept
 * breaking that: doc comments mention the very identifiers being asserted
 * against, and an anchor containing a raw "\n" does not exist in a CRLF
 * checkout — indexOf returns -1 and the slice silently inspects the wrong
 * region. It passed on LF and failed on Windows.
 *
 * Removing comments fixes both at once: the remaining anchors are code, and no
 * anchor needs to span a line break at all.
 */
function sourceWithoutComments(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function answerFn(): string {
  const src = sourceWithoutComments("lib/prompts/composerAnswer.ts");
  const start = src.indexOf("export async function answerAsComposer");
  const end = src.indexOf("export async function requestClueFromComposer", start);
  assert.ok(start >= 0 && end > start, "could not isolate answerAsComposer");
  return src.slice(start, end);
}

function clueFn(): string {
  const src = sourceWithoutComments("lib/prompts/composerAnswer.ts");
  return src.slice(src.indexOf("export async function requestClueFromComposer"));
}

test("an ordinary answer is never given clue guidance", () => {
  assert.doesNotMatch(answerFn(), /CLUE_GUIDANCE/, "clue policy must not steer ordinary answers");
});

test("the ordinary answer schema has no clue field to fill", () => {
  const src = readFileSync("lib/prompts/composerAnswer.ts", "utf8");
  const schema = src.slice(src.indexOf("const INPUT_SCHEMA"), src.indexOf("function renderTranscript"));
  assert.doesNotMatch(schema, /clue_text:/, "asking for a clue is what produced one");
  assert.match(schema, /required: \["reasoning", "answer", "ambiguous_explanation"\]/);
});

test("an ordinary answer returns no clue whatever the mode", () => {
  assert.match(answerFn(), /clue_text: null/);
});

test("answering no longer takes a clue mode at all", () => {
  // A parameter that no longer steers anything is an invitation to reconnect it.
  const params = answerFn().slice(0, answerFn().indexOf("): Promise"));
  assert.doesNotMatch(params, /clueMode/);
});

test("ordinary answers are not stored as clues", () => {
  const src = readFileSync("app/api/game/[id]/ask/route.ts", "utf8");
  assert.doesNotMatch(src, /clue_text = (answer|reanswer)\.clue_text/);
});

test("SÚGÓ keeps the full clue policy, including progressive strength", () => {
  const fn = clueFn();
  assert.match(fn, /CLUE_GUIDANCE\[params\.clueMode\]/, "the explicit path must keep its strength policy");
  assert.match(fn, /Remaining: \$\{remaining\}/, "progressive calibrates on remaining budget");
  assert.match(fn, /scrubClue\(/);
});

test("the Composer is told a YES or NO is the whole reply", () => {
  const src = readFileSync("lib/prompts/composerAnswer.ts", "utf8");
  assert.match(src, /A YES OR A NO IS A CLASSIFICATION, NOT A CONVERSATION\./);
  assert.match(src, /the answer IS the whole reply/);
  assert.match(src, /what to ask next/, "must forbid volunteering the next direction");
});

test("an AMBIGUOUS explanation may justify the split but not steer", () => {
  const src = readFileSync("lib/prompts/composerAnswer.ts", "utf8");
  assert.match(src, /AN AMBIGUOUS EXPLANATION JUSTIFIES THE AMBIGUITY AND NOTHING MORE\./);
  assert.match(src, /Do not say WHICH members differ/);
  // The explanation channel must still exist — removing it would make a genuine
  // split indistinguishable from evasion.
  assert.match(src, /ambiguous_explanation/);
});

test("the SÚGÓ label cannot wrap mid-word on a narrow screen", () => {
  for (const path of ["app/game/[id]/RacerClient.tsx", "app/game/[id]/GameClient.tsx"]) {
    const src = readFileSync(path, "utf8");
    // The word also appears in comments; match the rendered label only.
    const m = src.match(/<(span|p)([^>]*)>\s*\n?\s*SÚGÓ\s*\n?\s*<\//);
    assert.ok(m, `${path} has no rendered SÚGÓ label`);
    const tag = m[2] ?? "";
    assert.match(tag, /whitespace-nowrap/, `${path}: SÚGÓ label may wrap`);
    assert.doesNotMatch(tag, /\bw-6\b/, `${path}: label is still in the 24px turn-number column`);
  }
});

test("the per-answer clue slot is gone from the transcript", () => {
  const src = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");
  assert.doesNotMatch(
    src,
    /\{entry\.clue_text && \(/,
    "rendering a clue beside an answer would re-legitimise the removed channel",
  );
});

// ---------------------------------------------------------------------------
// Question numbering — display only, engine untouched.
// ---------------------------------------------------------------------------

test("displayed question numbers count questions, not log entries", async () => {
  const { questionNumbers } = await import("../lib/questionNumbers");
  const log = [
    { id: "a", turn_type: "question" },
    { id: "b", turn_type: "question" },
    { id: "c", turn_type: "clue" },
    { id: "d", turn_type: "question" },
    { id: "e", turn_type: "guess" },
  ] as never;
  const n = questionNumbers(log);
  assert.equal(n.get("a"), 1);
  assert.equal(n.get("b"), 2);
  assert.equal(n.get("d"), 3, "a clue must not push the next question to #4");
  assert.equal(n.has("c"), false, "clue turns get no question number");
  assert.equal(n.has("e"), false, "a guess is not a numbered question");
});

test("the transcript number agrees with the header counter after a clue", async () => {
  const { questionNumbers } = await import("../lib/questionNumbers");
  // 12 charged questions with one clue between them: the last question is the
  // 12th, and must be labelled #12 even though its turn_index is 13.
  const log = [];
  for (let i = 1; i <= 6; i++) log.push({ id: `q${i}`, turn_type: "question" });
  log.push({ id: "clue", turn_type: "clue" });
  for (let i = 7; i <= 12; i++) log.push({ id: `q${i}`, turn_type: "question" });
  const n = questionNumbers(log as never);
  assert.equal(n.get("q12"), 12, "header says 12/20, so the transcript must say #12");
});

test("the clients display the question number, never the raw turn index", () => {
  for (const path of ["app/game/[id]/RacerClient.tsx", "app/game/[id]/GameClient.tsx"]) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(src, /#\{entry\.turn_index\}/, `${path} shows the raw log index`);
    assert.match(src, /questionNumbers\(game\.qa_log\)/);
  }
});

test("turn_index is still what the correction API addresses", () => {
  // The display change must not have altered which turn a correction targets.
  const src = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
  assert.match(src, /turn_index: turnIndex/);
  assert.match(src, /correctAnswer\(entry\.turn_index, "YES"\)/);
});

test("starting a game replaces the form rather than merely disabling it", () => {
  // Duplicate starts are prevented by there being no second button to press.
  const racer = readFileSync("app/RacerSetup.tsx", "utf8");
  assert.match(racer, /busy \? \(\s*<ThinkingState/);
  const composer = readFileSync("app/ComposerEntry.tsx", "utf8");
  assert.match(composer, /view\.step === "submitting" && \(\s*<ThinkingState/);
  assert.doesNotMatch(composer, /disabled=\{view\.step === "submitting"/, "dead guard left behind");
});

test("the thinking state announces itself and needs no timer to clear", () => {
  const src = readFileSync("app/components/ThinkingState.tsx", "utf8");
  assert.match(src, /Az AI gondolkodik…/);
  assert.match(src, /role="status"/);
  assert.match(src, /aria-live="polite"/);
  assert.doesNotMatch(src, /setTimeout|useEffect|useState/, "it must clear by unmounting, not on a clock");
});
