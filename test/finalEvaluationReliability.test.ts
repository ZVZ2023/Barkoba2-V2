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

test("guessRevealLine: the exact required format, AI Racer perspective (racer_kind 'ai') -- byte-identical to the pre-V2.9.2.1 wording", () => {
  assert.equal(guessRevealLine("ceiling", "ai"), "Az AI tippje: „ceiling”.");
  assert.equal(guessRevealLine("  televízió távirányító  ", "ai"), "Az AI tippje: „televízió távirányító”.");
});

test("guessRevealLine: null for a missing or blank guess (a concede), in either perspective", () => {
  assert.equal(guessRevealLine(null, "ai"), null);
  assert.equal(guessRevealLine("", "ai"), null);
  assert.equal(guessRevealLine("   ", "ai"), null);
  assert.equal(guessRevealLine(null, "human"), null);
  assert.equal(guessRevealLine("", "human"), null);
  assert.equal(guessRevealLine("   ", "human"), null);
});

// V2.9.2.1 PRODUCTION FIX -- the reported field defect: RacerClient.tsx (AI
// Composer, HUMAN Racer) showed "Az AI tippje: „Kite”." to the human player
// who had just typed "Kite" themselves. These are the ticket's own exact
// required strings, for racer_kind "human".
test("guessRevealLine: the human Racer's own view (racer_kind 'human') -- the production fix", () => {
  assert.equal(guessRevealLine("Kite", "human"), "A tipped: „Kite”.");
  assert.equal(guessRevealLine("  televízió távirányító  ", "human"), "A tipped: „televízió távirányító”.");
});

test("evaluationStatusLine: every experience mode produces its required character, for a guess, AI Racer perspective", () => {
  assert.match(evaluationStatusLine("competitive", "guess", "ai"), /hivatalos ellenőrzése/, "Competitive: concise and serious");
  assert.match(evaluationStatusLine("friendly", "guess", "ai"), /együtt/, "Friendly: warm and collaborative");
  assert.match(
    evaluationStatusLine("teaching", "guess", "ai"),
    /ugyanarra a dologra utal-e.*következetesek maradtak-e/,
    "Teaching: explains what is being checked -- referent identity AND answer consistency"
  );
  assert.match(evaluationStatusLine("humorous", "guess", "ai"), /fején találta-e a szöget/, "Humorous: playful, but a status description");
});

test("evaluationStatusLine: every experience mode produces the corrected human-Racer wording, for a guess", () => {
  assert.match(evaluationStatusLine("competitive", "guess", "human"), /hivatalos ellenőrzése/, "Competitive stays concise and serious");
  assert.match(evaluationStatusLine("friendly", "guess", "human"), /sikerült-e eltalálnod/, "Friendly: 2nd person, the production fix's exact required text");
  assert.match(
    evaluationStatusLine("teaching", "guess", "human"),
    /rögzített titok.*következetesek maradtak-e/,
    "Teaching: the secret belongs to the AI Composer, not the human viewer"
  );
  assert.match(evaluationStatusLine("humorous", "guess", "human"), /fején találtad-e a szöget/, "Humorous: 2nd person");
});

test("evaluationStatusLine: humor never asserts an outcome -- only ever describes the pending check, in either perspective", () => {
  for (const racerKind of ["ai", "human"] as const) {
    for (const mode of EXPERIENCE_MODES) {
      const line = evaluationStatusLine(mode, "guess", racerKind);
      assert.doesNotMatch(line, /nyertél|vesztettél|helyes|helytelen/i, `${mode}/${racerKind}'s status line must not assert a verdict`);
    }
  }
});

test("evaluationStatusLine: a legacy game (no experience_mode) gets the neutral Competitive wording, in either perspective", () => {
  assert.equal(evaluationStatusLine(null, "guess", "ai"), evaluationStatusLine("competitive", "guess", "ai"));
  assert.equal(evaluationStatusLine(null, "concede", "ai"), evaluationStatusLine("competitive", "concede", "ai"));
  assert.equal(evaluationStatusLine(null, "guess", "human"), evaluationStatusLine("competitive", "guess", "human"));
  assert.equal(evaluationStatusLine(null, "concede", "human"), evaluationStatusLine("competitive", "concede", "human"));
});

test("evaluationStatusLine: a concede is worded distinctly from a guess, in every mode and either perspective", () => {
  for (const racerKind of ["ai", "human"] as const) {
    for (const mode of [...EXPERIENCE_MODES, null] as (ExperienceMode | null)[]) {
      assert.notEqual(evaluationStatusLine(mode, "guess", racerKind), evaluationStatusLine(mode, "concede", racerKind));
    }
  }
});

test("evaluationStatusLine: racer_kind 'ai' output is byte-identical to the pre-V2.9.2.1 wording -- the AI-Racer perspective must be preserved exactly", () => {
  assert.equal(evaluationStatusLine("competitive", "guess", "ai"), "Az eredmény hivatalos ellenőrzése folyamatban.");
  assert.equal(evaluationStatusLine("competitive", "concede", "ai"), "Az AI feladta. Az eredmény hivatalos ellenőrzése folyamatban.");
  assert.equal(evaluationStatusLine("friendly", "guess", "ai"), "Nézzük meg együtt, sikerült-e eltalálnia!");
  assert.equal(
    evaluationStatusLine("friendly", "concede", "ai"),
    "Az AI feladta a próbálkozást. Nézzük meg, kiállták-e a válaszaid az ellenőrzést!"
  );
  assert.equal(evaluationStatusLine("humorous", "guess", "ai"), "Most jön a hivatalos igazságpillanat — lássuk, tényleg fején találta-e a szöget!");
});

test("evaluationStatusLine/guessRevealLine: the human-Racer perspective never addresses the AI Composer's secret/answers as the viewer's own ('a titkod'/'a válaszaid')", () => {
  for (const mode of [...EXPERIENCE_MODES, null] as (ExperienceMode | null)[]) {
    for (const finalAction of ["guess", "concede"] as const) {
      const line = evaluationStatusLine(mode, finalAction, "human");
      assert.doesNotMatch(line, /a titkod|a válaszaid/, `${mode}/${finalAction} must not misattribute the secret/answers to the human Racer`);
    }
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

test("SOURCE: EvaluationState.tsx sources its copy from lib/evaluationCopy.ts, not inline strings, and threads racerKind (V2.9.2.1) into both calls", () => {
  assert.match(EVALUATION_STATE_SRC, /from "@\/lib\/evaluationCopy"/);
  assert.match(EVALUATION_STATE_SRC, /guessRevealLine\(finalGuessText, racerKind\)/);
  assert.match(EVALUATION_STATE_SRC, /evaluationStatusLine\(experienceMode, finalAction, racerKind\)/);
});

test("SOURCE: GameClient.tsx passes final_guess_text/final_action/experience_mode/racer_kind, and the guess is never shown before the existing pre-guess checkpoint", () => {
  const at = GAME_CLIENT_SRC.indexOf("<EvaluationState");
  assert.ok(at > 0);
  const block = GAME_CLIENT_SRC.slice(Math.max(0, at - 300), at + 300);
  assert.match(block, /!guessRevealPending/, "EvaluationState must still only mount after the pre-guess checkpoint has passed");
  assert.match(block, /finalGuessText=\{game\.final_guess_text\}/);
  assert.match(block, /finalAction=\{game\.final_action\}/);
  assert.match(block, /experienceMode=\{game\.experience_mode\}/);
  assert.match(block, /racerKind=\{game\.racer_kind\}/, "V2.9.2.1: role must be derived from game state, not account identity or which file is rendering");
});

test("SOURCE: RacerClient.tsx passes final_guess_text/final_action/experience_mode/racer_kind into EvaluationState -- the production fix's actual call site", () => {
  const at = RACER_CLIENT_SRC.indexOf("<EvaluationState");
  assert.ok(at > 0);
  const block = RACER_CLIENT_SRC.slice(at, at + 300);
  assert.match(block, /finalGuessText=\{game\.final_guess_text\}/);
  assert.match(block, /finalAction=\{game\.final_action\}/);
  assert.match(block, /experienceMode=\{game\.experience_mode\}/);
  assert.match(block, /racerKind=\{game\.racer_kind\}/, "V2.9.2.1: RacerClient.tsx's game.racer_kind is always \"human\" -- this prop is what fixes the reported defect");
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

// V2.8.8.4 SUPERSEDES this test's original shape. RacerClient.tsx's
// resolveGame() no longer contains an inline `fetch(...)`/`setError(null)`
// pair at all -- V2.8.8.4 routed it through the SAME runOwnedResolveRequest
// mechanism GameClient.tsx already used, which owns the error-clearing
// behavior itself (see runOwnedResolveRequest's own "DELIBERATELY does NOT
// clear the error here" test just above, and test/racerClientResolveParity
// .test.ts's "EXECUTED (retry visibility)" test, which proves — by actually
// executing the real mechanism with RacerClient's own field mapping — that
// its setError callback never sees a null between two real failures. This
// replacement asserts the CURRENT wiring: no inline error-clearing logic
// was reintroduced, and the request is routed through the shared,
// already-tested function rather than a hand-rolled fetch.
test("SOURCE: RacerClient.tsx's resolveGame routes through runOwnedResolveRequest -- it no longer owns error-clearing logic inline at all", () => {
  const fnAt = RACER_CLIENT_SRC.indexOf("const resolveGame = useCallback(async () => {");
  assert.ok(fnAt > 0);
  const nextFnAt = RACER_CLIENT_SRC.indexOf("useEffect(() => {\n    if (resolveFired.current) return;", fnAt);
  const fnBody = RACER_CLIENT_SRC.slice(fnAt, nextFnAt > fnAt ? nextFnAt : fnAt + 3000);
  assert.match(fnBody, /await runOwnedResolveRequest\(/, "must be routed through the shared mechanism");
  assert.doesNotMatch(fnBody, /setError\(null\)/, "no inline error-clearing logic of its own -- runOwnedResolveRequest owns that behavior");
  assert.doesNotMatch(fnBody, /await fetch\(`\/api\/game\/\$\{game\.game_id\}\/resolve`/, "the old unguarded inline fetch must be gone");
});
