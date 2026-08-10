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
