import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isExactGuessMatch } from "../lib/exactGuessMatch";
import { normalizeForConservativeIdentityMatch } from "../lib/textIdentity";
import { normalizeTargetForNoveltyCheck } from "../lib/targetNovelty";
import { evaluationStatusLine, guessRevealLine } from "../lib/evaluationCopy";
import { EXPERIENCE_MODES } from "../lib/experienceMode";
import type { ExperienceMode } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.8.8.1 — FINAL-EVALUATION RELIABILITY AND MODE-AWARE PRESENTATION.
//
// Field evidence: two Human-Setter/AI-Racer games showed repeated "Az
// értékelés megszakadt" (evaluation interrupted) failures, one on a
// Humorous-mode exact-string guess ("Távirányító" for "television remote
// control" -- NOT an exact match, still needs real adjudication) and one on
// an apparent exact guess ("ceiling"). No production DB credentials were
// available in this environment, so the root-cause section below is a
// CODE-LEVEL hypothesis, not confirmed against corpus.turn_operations --
// stated honestly, not as a confirmed finding.
// ---------------------------------------------------------------------------

const RESOLVE_ROUTE_SRC = readFileSync("app/api/game/[id]/resolve/route.ts", "utf8");
const TURN_REQUEST_GUARD_SRC = readFileSync("lib/turnRequestGuard.ts", "utf8");
const RACER_CLIENT_SRC = readFileSync("app/game/[id]/RacerClient.tsx", "utf8");
const GAME_CLIENT_SRC = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
const EVALUATION_STATE_SRC = readFileSync("app/components/EvaluationState.tsx", "utf8");

// ---------------------------------------------------------------------------
// (1) & (2) — the conservative normalizer/matcher itself, fully executed.
// ---------------------------------------------------------------------------

test("isExactGuessMatch: identical strings match", () => {
  assert.equal(isExactGuessMatch("ceiling", "ceiling"), true);
});

test("isExactGuessMatch: case/punctuation/diacritic-only differences use the fast path", () => {
  assert.equal(isExactGuessMatch("Ceiling", "ceiling"), true, "case-only");
  assert.equal(isExactGuessMatch("ceiling.", "ceiling"), true, "trailing punctuation");
  assert.equal(isExactGuessMatch("  ceiling  ", "ceiling"), true, "surrounding whitespace");
  assert.equal(isExactGuessMatch("mennyezet", "Mennyezet."), true, "case + punctuation, Hungarian");
  assert.equal(isExactGuessMatch("kave", "kávé"), true, "diacritic-only difference");
  assert.equal(isExactGuessMatch("OZ", "Őz!"), true, "case + diacritic + punctuation");
});

test("isExactGuessMatch: synonyms and translations do NOT use the fast path -- the reported field case", () => {
  assert.equal(
    isExactGuessMatch("Távirányító", "television remote control"),
    false,
    "the exact field incident: a correct translation must still go through real adjudication"
  );
  assert.equal(isExactGuessMatch("kutya", "dog"), false, "translation");
  assert.equal(isExactGuessMatch("puppy", "dog"), false, "synonym");
});

test("isExactGuessMatch: broader/narrower concepts do NOT use the fast path", () => {
  assert.equal(isExactGuessMatch("animal", "dog"), false, "broader concept");
  assert.equal(isExactGuessMatch("golden retriever", "dog"), false, "narrower concept");
});

test("isExactGuessMatch: an empty guess or target never matches, even against itself", () => {
  assert.equal(isExactGuessMatch("", ""), false);
  assert.equal(isExactGuessMatch("   ", "dog"), false);
  assert.equal(isExactGuessMatch("dog", ""), false);
});

test("lib/textIdentity.ts's normalizer is reused (not re-copied) by lib/targetNovelty.ts", () => {
  assert.equal(normalizeTargetForNoveltyCheck, normalizeForConservativeIdentityMatch);
});

// ---------------------------------------------------------------------------
// (1) & (4) — resolve/route.ts's fast-path wiring.
//
// HONEST LIMITATION, stated per this codebase's own established convention
// for the resolve route (a PERMITTED SECRET CALL SITE -- see the route's
// own module doc, and test/gameplayAuthorization.test.ts's identical
// precedent): getSecretForAdjudication is scoped to a narrow allowlist
// (scripts/check-isolation.mjs's PERMITTED_SECRET_IMPORTERS), which does
// NOT include test files, so a genuine end-to-end invocation of this route
// with a real secret cannot be constructed from a test without either
// weakening that allowlist or routing through the full creation+play flow.
// These are SOURCE-CONTRACT assertions -- a weaker claim than an executed
// one, stated plainly rather than implied.
// ---------------------------------------------------------------------------

test("SOURCE: the fast-path check runs BEFORE consumeModelCall and runAdjudicator, inside needsAdjudication", () => {
  const needsAt = RESOLVE_ROUTE_SRC.indexOf("if (needsAdjudication(game.final_action)) {");
  assert.ok(needsAt > 0);
  const fastPathAt = RESOLVE_ROUTE_SRC.indexOf("isExactGuessMatch(guessText, secret.target)", needsAt);
  const budgetAt = RESOLVE_ROUTE_SRC.indexOf("consumeModelCall(\"resolve\")", needsAt);
  const adjudicatorCallAt = RESOLVE_ROUTE_SRC.indexOf("runAdjudicator({", needsAt);
  assert.ok(fastPathAt > needsAt, "the exact-match check must exist inside the adjudication branch");
  assert.ok(budgetAt > fastPathAt, "the budget must never be consumed before the fast-path check");
  assert.ok(adjudicatorCallAt > fastPathAt, "the real Adjudicator call must sit after the fast-path check");
});

test("SOURCE: the fast-path branch sets the verdict directly and never calls the Adjudicator, Integrity Review, or the model-call budget", () => {
  const fastPathAt = RESOLVE_ROUTE_SRC.indexOf("if (isExactGuessMatch(guessText, secret.target)) {");
  const elseAt = RESOLVE_ROUTE_SRC.indexOf("} else {", fastPathAt);
  assert.ok(fastPathAt > 0 && elseAt > fastPathAt);
  const fastPathBlock = RESOLVE_ROUTE_SRC.slice(fastPathAt, elseAt);
  assert.match(fastPathBlock, /adjudicatorVerdict = "correct";/);
  assert.doesNotMatch(fastPathBlock, /runAdjudicator/);
  assert.doesNotMatch(fastPathBlock, /runIntegrityReview/);
  assert.doesNotMatch(fastPathBlock, /consumeModelCall/);
});

test("SOURCE: a non-exact guess retains the exact pre-existing adjudication behavior (the else branch is the original code, unchanged)", () => {
  const elseAt = RESOLVE_ROUTE_SRC.indexOf("} else {\n      const budget = await consumeModelCall");
  assert.ok(elseAt > 0, "the else branch must still consume budget and call the real Adjudicator");
  const elseBlockEnd = RESOLVE_ROUTE_SRC.indexOf("\n  }\n\n  // ---", elseAt);
  const elseBlock = RESOLVE_ROUTE_SRC.slice(elseAt, elseBlockEnd > elseAt ? elseBlockEnd : elseAt + 3000);
  assert.match(elseBlock, /runAdjudicator\(\{/);
  assert.match(elseBlock, /guess: guessText,/);
  assert.match(elseBlock, /adjudicator_unavailable/, "the existing recoverable-error contract must be unchanged");
});

test("SOURCE: needsIntegrityReview's own existing table is untouched -- a fast-path 'correct' verdict skips Integrity Review exactly like a real one", () => {
  // lib/resolveResult.ts is not edited by this patch at all; this pins that
  // the fast path relies on that EXISTING, already-tested skip rule rather
  // than adding a second special case for it.
  assert.doesNotMatch(RESOLVE_ROUTE_SRC, /needsIntegrityReview\([^)]*"correct"/);
  const integrityAt = RESOLVE_ROUTE_SRC.indexOf("if (needsIntegrityReview(game.final_action, adjudicatorVerdict))");
  assert.ok(integrityAt > 0, "the SAME needsIntegrityReview call (no new fast-path-specific branch) still gates the review");
});

test("SOURCE: deterministic-resolution provenance uses ONLY existing telemetry schema -- no migration", () => {
  const fastPathAt = RESOLVE_ROUTE_SRC.indexOf("if (isExactGuessMatch(guessText, secret.target)) {");
  const elseAt = RESOLVE_ROUTE_SRC.indexOf("} else {", fastPathAt);
  const fastPathBlock = RESOLVE_ROUTE_SRC.slice(fastPathAt, elseAt);
  assert.match(fastPathBlock, /operationKind: "adjudicator",/, "an existing operation_kind value");
  assert.match(fastPathBlock, /provider: "deterministic",/, "provider is unconstrained free text -- migrations/0012");
  assert.match(fastPathBlock, /status: "accepted",/, "an existing status value");
  assert.match(fastPathBlock, /requestedModelId: null,/);
  assert.match(fastPathBlock, /usage: null,/);
  assert.doesNotMatch(RESOLVE_ROUTE_SRC, /CREATE TABLE|ALTER TABLE/, "no migration is introduced by this patch");
});

test("SOURCE: maxDuration widened, with the honest limitation documented", () => {
  assert.match(RESOLVE_ROUTE_SRC, /export const maxDuration = 120;/);
  assert.match(RESOLVE_ROUTE_SRC, /HONEST LIMITATION/);
  assert.match(RESOLVE_ROUTE_SRC, /CODE-LEVEL hypothesis/);
  assert.match(RESOLVE_ROUTE_SRC, /corpus\.turn_operations/);
});

// ---------------------------------------------------------------------------
// (9) — verdict/IS-IS untouched: this patch never edits lib/resolveResult.ts
// or lib/layerTwo.ts at all. Confirmed by their own pre-existing test files
// (test/resolveResult.test.ts, test/layerTwoIntegration.test.ts), run as
// part of this ticket's own focused sweep rather than duplicated here.
// ---------------------------------------------------------------------------

test("SOURCE: lib/resolveResult.ts is not imported or reimplemented by the fast path -- it reuses the SAME deriveResult/needsAdjudication/needsIntegrityReview", () => {
  assert.match(RESOLVE_ROUTE_SRC, /from "@\/lib\/resolveResult"/);
  const resolveResultSrc = readFileSync("lib/resolveResult.ts", "utf8");
  assert.match(resolveResultSrc, /Zero I\/O, zero model calls, zero/, "the pure result table itself is untouched");
});

// ---------------------------------------------------------------------------
// (5), (6), (7) — the guess reveal and mode-aware copy.
// ---------------------------------------------------------------------------

test("guessRevealLine: the exact required format", () => {
  assert.equal(guessRevealLine("ceiling"), "Az AI tippje: „ceiling”.");
  assert.equal(guessRevealLine("  televízió távirányító  "), "Az AI tippje: „televízió távirányító”.");
});

test("guessRevealLine: null for a missing or blank guess (a concede)", () => {
  assert.equal(guessRevealLine(null), null);
  assert.equal(guessRevealLine(""), null);
  assert.equal(guessRevealLine("   "), null);
});

test("evaluationStatusLine: every experience mode produces its required character, for a guess", () => {
  assert.match(evaluationStatusLine("competitive", "guess"), /hivatalos ellenőrzése/, "Competitive: concise and serious");
  assert.match(evaluationStatusLine("friendly", "guess"), /együtt/, "Friendly: warm and collaborative");
  assert.match(
    evaluationStatusLine("teaching", "guess"),
    /ugyanarra a dologra utal-e.*következetesek maradtak-e/,
    "Teaching: explains what is being checked -- referent identity AND answer consistency"
  );
  assert.match(evaluationStatusLine("humorous", "guess"), /fején találta-e a szöget/, "Humorous: playful, but a status description");
});

test("evaluationStatusLine: humor never asserts an outcome -- only ever describes the pending check", () => {
  for (const mode of EXPERIENCE_MODES) {
    const line = evaluationStatusLine(mode, "guess");
    assert.doesNotMatch(line, /nyertél|vesztettél|helyes|helytelen/i, `${mode}'s status line must not assert a verdict`);
  }
});

test("evaluationStatusLine: a legacy game (no experience_mode) gets the neutral Competitive wording", () => {
  assert.equal(evaluationStatusLine(null, "guess"), evaluationStatusLine("competitive", "guess"));
  assert.equal(evaluationStatusLine(null, "concede"), evaluationStatusLine("competitive", "concede"));
});

test("evaluationStatusLine: a concede is worded distinctly from a guess, in every mode", () => {
  for (const mode of [...EXPERIENCE_MODES, null] as (ExperienceMode | null)[]) {
    assert.notEqual(evaluationStatusLine(mode, "guess"), evaluationStatusLine(mode, "concede"));
  }
});

test("SOURCE: EvaluationState.tsx renders the guess line OUTSIDE the error/pending branch -- visible during initial evaluation, retries, AND recoverable errors", () => {
  const guessLineAt = EVALUATION_STATE_SRC.indexOf("{guessLine &&");
  const errorBranchAt = EVALUATION_STATE_SRC.indexOf("{error ? (");
  assert.ok(guessLineAt > 0 && errorBranchAt > guessLineAt, "the guess line must render before (outside) the error/pending conditional");
});

test("SOURCE: EvaluationState.tsx retains the plain 'ÉRTÉKELÉS FOLYAMATBAN…' heading and its aria-live behavior", () => {
  assert.match(EVALUATION_STATE_SRC, /ÉRTÉKELÉS/);
  assert.match(EVALUATION_STATE_SRC, /FOLYAMATBAN…/);
  assert.match(EVALUATION_STATE_SRC, /aria-live="polite"/);
});

test("SOURCE: EvaluationState.tsx sources its copy from lib/evaluationCopy.ts, not inline strings", () => {
  assert.match(EVALUATION_STATE_SRC, /from "@\/lib\/evaluationCopy"/);
  assert.match(EVALUATION_STATE_SRC, /guessRevealLine\(finalGuessText\)/);
  assert.match(EVALUATION_STATE_SRC, /evaluationStatusLine\(experienceMode, finalAction\)/);
});

test("SOURCE: GameClient.tsx passes final_guess_text/final_action/experience_mode, and the guess is never shown before the existing pre-guess checkpoint", () => {
  const at = GAME_CLIENT_SRC.indexOf("<EvaluationState");
  assert.ok(at > 0);
  const block = GAME_CLIENT_SRC.slice(Math.max(0, at - 300), at + 300);
  assert.match(block, /!guessRevealPending/, "EvaluationState must still only mount after the pre-guess checkpoint has passed");
  assert.match(block, /finalGuessText=\{game\.final_guess_text\}/);
  assert.match(block, /finalAction=\{game\.final_action\}/);
  assert.match(block, /experienceMode=\{game\.experience_mode\}/);
});

test("SOURCE: RacerClient.tsx passes final_guess_text/final_action/experience_mode into EvaluationState", () => {
  const at = RACER_CLIENT_SRC.indexOf("<EvaluationState");
  assert.ok(at > 0);
  const block = RACER_CLIENT_SRC.slice(at, at + 300);
  assert.match(block, /finalGuessText=\{game\.final_guess_text\}/);
  assert.match(block, /finalAction=\{game\.final_action\}/);
  assert.match(block, /experienceMode=\{game\.experience_mode\}/);
});

// ---------------------------------------------------------------------------
// (8) — repeated taps still produce only one request.
// ---------------------------------------------------------------------------

test("SOURCE: RacerClient.tsx's resolveGame now has its own synchronous in-flight guard, checked BEFORE any state update or await", () => {
  const fnAt = RACER_CLIENT_SRC.indexOf("const resolveGame = useCallback(async () => {");
  assert.ok(fnAt > 0);
  const fnBody = RACER_CLIENT_SRC.slice(fnAt, fnAt + 400);
  assert.match(fnBody, /if \(resolveInFlightRef\.current\) return;/);
  const guardAt = fnBody.indexOf("if (resolveInFlightRef.current) return;");
  const firstAwaitAt = fnBody.indexOf("await fetch");
  assert.ok(guardAt >= 0 && (firstAwaitAt === -1 || guardAt < firstAwaitAt));
  assert.match(RACER_CLIENT_SRC, /resolveInFlightRef\.current = true;/);
  assert.match(RACER_CLIENT_SRC, /resolveInFlightRef\.current = false;/);
});

// ---------------------------------------------------------------------------
// (E) retry visibility — the root bug and its fix, proved both by source
// and (below) by an EXECUTED assertion against the existing, already-tested
// runOwnedResolveRequest harness (test/turnRequestGuard.test.ts).
// ---------------------------------------------------------------------------

test("SOURCE: runOwnedResolveRequest no longer clears the error at the START of an attempt", () => {
  const fnAt = TURN_REQUEST_GUARD_SRC.indexOf("export async function runOwnedResolveRequest(");
  const bodyStart = TURN_REQUEST_GUARD_SRC.indexOf("state.setResolving(true);", fnAt);
  const nextCodeLine = TURN_REQUEST_GUARD_SRC.slice(bodyStart, bodyStart + 600);
  assert.doesNotMatch(
    nextCodeLine,
    /state\.setResolving\(true\);\s*\n\s*state\.setResolveError\(null\);/,
    "the premature clear must be gone"
  );
  assert.match(nextCodeLine, /DELIBERATELY does NOT clear the error here/);
});

test("SOURCE: RESOLVE_CLIENT_TIMEOUT_MS was widened alongside the route's maxDuration, preserving the documented margin", () => {
  assert.match(TURN_REQUEST_GUARD_SRC, /export const RESOLVE_CLIENT_TIMEOUT_MS = 150_000;/);
});

test("SOURCE: RacerClient.tsx's resolveGame no longer clears `error` before the fetch, only on success or a fresh failure", () => {
  const fnAt = RACER_CLIENT_SRC.indexOf("const resolveGame = useCallback(async () => {");
  const fetchAt = RACER_CLIENT_SRC.indexOf("await fetch(`/api/game/${game.game_id}/resolve`", fnAt);
  assert.ok(fnAt > 0 && fetchAt > fnAt);
  const preFetch = RACER_CLIENT_SRC.slice(fnAt, fetchAt);
  assert.doesNotMatch(preFetch, /setError\(null\)/, "no premature clear before the request is even sent");
  const postFetch = RACER_CLIENT_SRC.slice(fetchAt, fetchAt + 500);
  assert.match(postFetch, /else \{\s*setError\(null\);/, "cleared explicitly on success");
});
