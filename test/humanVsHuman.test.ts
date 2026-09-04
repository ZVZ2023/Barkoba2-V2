import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { awaitingRacer, isHumanVsHuman, isParticipant, requireSeat, resolveSeat } from "../lib/seats";
import { buildComposerView, buildGameView, isSeatsTurn, pendingQuestionIndex } from "../lib/gameView";
import { QUESTION_BUDGETS, recommendedBudget, resolveQuestionBudget } from "../lib/questionBudget";
import { resultCopy, seatWon } from "../lib/resultCopy";
import type { GameRecord, QuestionLogEntry } from "../lib/types";

// ---------------------------------------------------------------------------
// V2.3 — the rules that must hold before two strangers share a game.
//
// Scoped to the critical gates only: role integrity, secret isolation, and
// whose turn it is. The narrowing and seat logic are pure functions precisely
// so they can be proven here rather than in a browser.
// ---------------------------------------------------------------------------

const COMPOSER = "a".repeat(32);
const RACER = "b".repeat(32);
const STRANGER = "c".repeat(32);

function entry(o: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
  return {
    id: randomUUID(), turn_index: 1, turn_type: "question", racer_output_raw: "",
    question_text: "Fizikai tárgy?", guess_text: null, composer_response: null,
    ambiguous_explanation: null, guess_detector_flagged: false, guess_detector_method: null,
    guess_intent_outcome: null, clue_text: null, original_question_text: null,
    edit_status: null, edit_reason: null, ambiguous_consumed_credit: false,
    timestamp: new Date().toISOString(), model_id: null, model_provider: null, prompt_version: null,
    answered_at: null, pre_revision_question_text: null,
    quality_score: null, information_gain: null,
    strategy_classification: null, integrity_flag: null, confidence: null, latency_ms: null,
    ...o,
  };
}

function hhGame(o: Partial<GameRecord> = {}): GameRecord {
  return {
    game_id: randomUUID(), revision: 0, player_id: COMPOSER,
    composer_player_id: COMPOSER, racer_player_id: RACER, join_code: "ABCD2345",
    phase: "questioning", created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(), max_questions: 20, game_language: "hu",
    private_target: false, composer_kind: "human", racer_kind: "human", racer_provider: null,
    difficulty: null, clue_mode: null, question_count: 0, question_count_high_water_mark: 0, ambiguous_count: 0,
    qa_log: [], final_action: null, final_guess_text: null, result: null,
    integrity_notes: null, integrity_flagged_turns: null, adjudication_notes: null,
    adjudicator_verdict: null, integrity_verdict: null, adjudication_confidence: null,
    revealed_target: null, revealed_definition: null, revealed_granularity: null,
    revealed_modifiers: null, revealed_locked_at: null,
    corrections: [], abandoned_branches: [], clarification_prompt: null,
    benchmark_case_id: null, benchmark_run_id: null,
    ...o,
  };
}

// --- role integrity ---------------------------------------------------------

test("each participant resolves to their own seat", () => {
  const g = hhGame();
  assert.equal(resolveSeat(g, COMPOSER), "composer");
  assert.equal(resolveSeat(g, RACER), "racer");
});

test("a stranger holding the URL has no seat at all", () => {
  const g = hhGame();
  assert.equal(resolveSeat(g, STRANGER), null);
  assert.equal(resolveSeat(g, null), null);
  assert.equal(isParticipant(g, STRANGER), false);
});

test("Human↔Human never falls back to the one-human rule", () => {
  // A game still waiting for its Racer must not hand the empty seat to whoever
  // asks — that fallback is only safe in modes with exactly one human.
  const g = hhGame({ racer_player_id: null });
  assert.equal(resolveSeat(g, STRANGER), null);
});

test("the Racer cannot act as Composer, and vice versa", () => {
  const g = hhGame();
  assert.deepEqual(requireSeat(g, RACER, "composer"), {
    ok: false, seat: "racer", error: "wrong_seat",
  });
  assert.deepEqual(requireSeat(g, COMPOSER, "racer"), {
    ok: false, seat: "composer", error: "wrong_seat",
  });
});

test("a stranger and a wrong-seat participant are distinguished", () => {
  const g = hhGame();
  assert.equal(requireSeat(g, STRANGER, "racer").error, "not_a_participant");
  assert.equal(requireSeat(g, COMPOSER, "racer").error, "wrong_seat");
});

test("single-human modes keep working without recorded seats", () => {
  // Games created before 2.3.0.0 are still live in Redis for up to 24h.
  const legacy = hhGame({
    composer_kind: "human", racer_kind: "ai", racer_provider: null,
    composer_player_id: null, racer_player_id: null,
  });
  assert.equal(isHumanVsHuman(legacy), false);
  assert.equal(resolveSeat(legacy, STRANGER), "composer");
});

// --- SECRET ISOLATION — the highest-priority constraint ---------------------

test("the Racer view contains no target field, by shape", () => {
  const g = hhGame({
    qa_log: [entry({ composer_response: "YES" })],
    revealed_target: null,
  });
  const view = buildGameView(g, "racer");
  const serialized = JSON.stringify(view);

  assert.equal("secret" in view, false, "a Racer view must have no secret block");
  assert.doesNotMatch(serialized, /"secret"/);
  assert.doesNotMatch(serialized, /join_code/, "the invitation is Composer-only too");
});

test("a target present in the record still never reaches the Racer view", () => {
  // The strongest form of the guarantee: even if GameRecord holds target text,
  // the Racer projection is built field by field and cannot carry it.
  const g = hhGame({
    revealed_definition: "SECRET-DEFINITION",
    revealed_modifiers: "SECRET-MODIFIER",
    revealed_granularity: "generic_type",
  });
  const serialized = JSON.stringify(buildGameView(g, "racer"));
  assert.doesNotMatch(serialized, /SECRET-DEFINITION/);
  assert.doesNotMatch(serialized, /SECRET-MODIFIER/);
});

test("the Composer view carries the target and the invitation", () => {
  const g = hhGame();
  const view = buildComposerView(g, { target: "kanál", definition: "evőeszköz" });
  assert.equal(view.secret.target, "kanál");
  assert.equal(view.join_code, "ABCD2345");
});

test("after resolution the declassified target is visible to BOTH seats", () => {
  const g = hhGame({ phase: "complete", result: "racer_correct", revealed_target: "kanál" });
  assert.equal(buildGameView(g, "racer").revealed_target, "kanál");
});

// --- turn synchronisation ---------------------------------------------------

test("an unanswered question makes it the Composer's move", () => {
  const g = hhGame({ qa_log: [entry()] });
  assert.equal(pendingQuestionIndex(g), 1);
  assert.equal(isSeatsTurn(g, "composer"), true);
  assert.equal(isSeatsTurn(g, "racer"), false);
});

test("an answered question hands the move back to the Racer", () => {
  const g = hhGame({ qa_log: [entry({ composer_response: "YES" })] });
  assert.equal(pendingQuestionIndex(g), null);
  assert.equal(isSeatsTurn(g, "racer"), true);
  assert.equal(isSeatsTurn(g, "composer"), false);
});

test("nobody may act while the second player has not joined", () => {
  const g = hhGame({ racer_player_id: null });
  assert.equal(awaitingRacer(g), true);
  assert.equal(isSeatsTurn(g, "composer"), false);
  assert.equal(isSeatsTurn(g, "racer"), false);
});

test("nobody may act once the game is over", () => {
  const g = hhGame({ phase: "complete" });
  assert.equal(isSeatsTurn(g, "racer"), false);
  assert.equal(isSeatsTurn(g, "composer"), false);
});

// --- question budget: recommended, overridable, then authoritative ----------

test("each difficulty recommends one of the offered allowances", () => {
  for (const d of ["easy", "medium", "hard"] as const) {
    assert.ok(
      (QUESTION_BUDGETS as readonly number[]).includes(recommendedBudget(d)),
      `${d} must recommend an offered budget`
    );
  }
  // Harder means further to deduce, so more questions — not a stricter game.
  assert.ok(recommendedBudget("easy") < recommendedBudget("medium"));
  assert.ok(recommendedBudget("medium") < recommendedBudget("hard"));
});

test("the Composer's override wins over the recommendation", () => {
  assert.equal(resolveQuestionBudget("easy", 100), 100);
  assert.equal(resolveQuestionBudget("hard", 20), 20);
});

test("no override means the recommendation", () => {
  assert.equal(resolveQuestionBudget("medium", undefined), recommendedBudget("medium"));
  assert.equal(resolveQuestionBudget("medium", null), recommendedBudget("medium"));
});

test("a budget that is not on offer falls back instead of failing the game", () => {
  for (const bad of [0, -5, 21, 999, "50", NaN, {}]) {
    assert.equal(resolveQuestionBudget("hard", bad), recommendedBudget("hard"));
  }
});

test("the chosen budget is authoritative game state, not a display value", () => {
  // What creation resolves is what the record carries, and what the record
  // carries is what gameplay counts against.
  const chosen = resolveQuestionBudget("hard", 100);
  const g = hhGame({ max_questions: chosen, question_count: chosen });

  assert.equal(g.max_questions, 100);
  assert.equal(buildGameView(g, "racer").max_questions, 100);
  assert.equal(buildGameView(g, "racer").questions_remaining, 0);
});

test("the H↔H route enforces the budget it was given, whatever its size", () => {
  // The guard is `question_count >= max_questions`, so a 100-question game must
  // still be asking at 99 and out of questions at 100.
  const src = readFileSync("app/api/game/[id]/hh/turn/route.ts", "utf8");
  assert.match(src, /game\.question_count >= game\.max_questions/);
  assert.match(src, /out_of_questions/);

  const nearlyDone = hhGame({ max_questions: 100, question_count: 99 });
  assert.equal(buildGameView(nearlyDone, "racer").questions_remaining, 1);
});

test("the budget rule applies to BOTH human-Composer flows, from one source", () => {
  // It belongs to "a human owns the target", not to who is guessing. The two
  // setup screens must share the control, or the same choice ends up meaning
  // two different things.
  const composer = readFileSync("app/ComposerEntry.tsx", "utf8");
  const human = readFileSync("app/play/human/HumanSetup.tsx", "utf8");

  for (const [name, src] of [["/compose", composer], ["/play/human", human]] as const) {
    assert.match(src, /BudgetPicker/, `${name} must use the shared picker`);
    assert.match(src, /max_questions: pickedBudget|max_questions: budget/, `${name} must submit it`);
    assert.match(src, /difficulty,/, `${name} must submit the difficulty`);
  }

  // Neither screen may carry its own copy of the difficulty vocabulary.
  for (const src of [composer, human]) {
    assert.doesNotMatch(src, /Hétköznapi dolgok/);
  }
});

test("a Composer who expresses no choice keeps the historic default", () => {
  // /compose has always used the MAX_QUESTIONS deployment knob. A client that
  // does not send the control must not be silently moved onto a new default.
  const src = readFileSync("app/api/game/create/route.ts", "utf8");
  assert.match(src, /composerChoseBudget\s*=\s*\n?\s*body\.difficulty !== undefined \|\| body\.max_questions !== undefined/);
  assert.match(src, /composerChoseBudget\s*\n?\s*\?\s*resolveQuestionBudget\(humanDifficulty, body\.max_questions\)\s*\n?\s*:\s*env\.maxQuestions\(\)/);
});

test("creation resolves the budget before the Validator judges the target", () => {
  // A target reasonable inside 50 questions may not be inside 20, so the
  // Validator has to be told the allowance the game will actually use.
  const src = readFileSync("app/api/game/create/route.ts", "utf8");
  const budgetAt = src.indexOf("resolveQuestionBudget(humanDifficulty");
  const validatorAt = src.indexOf("runValidator(target");
  assert.ok(budgetAt > 0 && validatorAt > 0);
  assert.ok(budgetAt < validatorAt, "the budget must be resolved first");
  assert.match(src, /max_questions: maxQuestions,/);
});

// --- V2.3.1 (1): the winner is unmistakable, from each seat's own view ------

test("every outcome tells each seat whether THEY won", () => {
  const outcomes = [
    "racer_correct",
    "racer_incorrect",
    "composer_win_integrity_upheld",
    "racer_win_integrity_violation",
  ] as const;

  for (const r of outcomes) {
    const composer = resultCopy(r, "composer");
    const racer = resultCopy(r, "racer");

    // Exactly one side won — never both, never neither.
    assert.notEqual(composer.won, racer.won, `${r} must have one winner`);
    assert.equal(composer.won, seatWon(r, "composer"));
    assert.equal(racer.won, seatWon(r, "racer"));

    // Each headline is non-empty and differs between seats: the same neutral
    // sentence for both is precisely what the field test found unreadable.
    assert.ok(composer.headline.length > 0 && racer.headline.length > 0);
    assert.notEqual(composer.headline, racer.headline, `${r} reads the same to both`);
  }
});

test("the two most common outcomes read as specified", () => {
  assert.equal(resultCopy("racer_incorrect", "composer").headline, "NYERTÉL!");
  assert.match(resultCopy("racer_incorrect", "composer").detail, /nem találta el/);
  assert.equal(resultCopy("racer_incorrect", "racer").headline, "NEM TALÁLTAD EL");
  assert.match(resultCopy("racer_incorrect", "racer").detail, /gondolkodó nyert/);

  // The inverse, so a correct guess is equally obvious to both.
  assert.equal(resultCopy("racer_correct", "racer").headline, "ELTALÁLTAD!");
  assert.equal(resultCopy("racer_correct", "composer").headline, "VESZTETTÉL");
});

test("a concede reads as a concede, not as a wrong guess", () => {
  assert.equal(resultCopy("composer_win_integrity_upheld", "racer").headline, "FELADTAD");
  assert.match(
    resultCopy("composer_win_integrity_upheld", "composer").detail,
    /feladta/
  );
});

test("the result screen no longer relies on the neutral sentence", () => {
  const src = readFileSync("app/game/[id]/HumanClient.tsx", "utf8");
  assert.doesNotMatch(src, /"Nem talált\."/);
  assert.match(src, /outcome\.headline/);
  // The adjudication text still follows — it explains, it no longer announces.
  assert.match(src, /adjudication_notes/);
});

// --- V2.3.1 (2): BIZONYTALAN opens its own explanation ----------------------

test("the explanation is reached THROUGH the BIZONYTALAN choice", () => {
  const src = readFileSync("app/game/[id]/HumanClient.tsx", "utf8");
  // The field is behind the choice, not sitting above the buttons.
  assert.match(src, /setExplaining\(true\)/);
  assert.match(src, /explaining \?|!explaining/);
  // And it still submits the same field the server and adjudicator already use.
  assert.match(src, /ambiguous_explanation: explanation/);
});

test("an AMBIGUOUS answer still carries its explanation into the record", () => {
  // Unchanged persistence: the projection surfaces what the Composer typed.
  const g = hhGame({
    qa_log: [
      entry({
        composer_response: "AMBIGUOUS",
        ambiguous_explanation: "No longer, it is machine made.",
      }),
    ],
  });
  assert.equal(
    buildGameView(g, "racer").turns[0]?.ambiguous_explanation,
    "No longer, it is machine made."
  );
});

// --- V2.3.1 (3): the Composer's voluntary hint ------------------------------

test("a hint is a clue turn — no new turn type, no migration", () => {
  const src = readFileSync("app/api/game/[id]/hh/turn/route.ts", "utf8");
  assert.match(src, /body\.action === "hint"/);
  assert.match(src, /entry\.turn_type = "clue"/);
  assert.match(src, /entry\.clue_text = text/);
  // It must not consume a question or become an answer.
  const hintBlock = src.slice(src.indexOf('body.action === "hint"'), src.indexOf("Composer: answer the one"));
  assert.doesNotMatch(hintBlock, /question_count \+= 1/);
  assert.doesNotMatch(hintBlock, /composer_response/);
});

test("only the Composer may hint", () => {
  // V2.8.6 R2 — the seat check for "hint" moved out of this block: it now
  // runs pre-lock, alongside every other action's own seat requirement (see
  // requiredSeat), not repeated inline per action. Proven here as: hint and
  // answer are the only two actions routed to the composer seat, and that
  // determination runs before acquireTurnLock — i.e., authorization is
  // decided before any lock is spent on it.
  const src = readFileSync("app/api/game/[id]/hh/turn/route.ts", "utf8");
  const requiredSeatAt = src.indexOf('body.action === "hint" || body.action === "answer" ? "composer" : "racer"');
  const seatCheckAt = src.indexOf('requireSeat(game, playerId, requiredSeat)');
  const lockAt = src.indexOf("acquireTurnLock(gameId, HH_TURN_LOCK_TTL_SECONDS)");
  assert.ok(requiredSeatAt >= 0, "hint must route to the composer seat, not the racer's");
  assert.ok(seatCheckAt > requiredSeatAt && seatCheckAt < lockAt, "the seat check must run before the lock is acquired");
});

test("a hint reaches the Racer and survives in the transcript", () => {
  const g = hhGame({
    qa_log: [
      entry({ turn_index: 1, composer_response: "YES" }),
      entry({ turn_index: 2, turn_type: "clue", question_text: null, clue_text: "Rossz irányba indultál." }),
    ],
  });
  // The projection is what both the first render and every poll are built from,
  // so appearing here is what makes it survive refresh and reconnect.
  const racerTurns = buildGameView(g, "racer").turns;
  assert.equal(racerTurns[1]?.turn_type, "clue");
  assert.equal(racerTurns[1]?.clue_text, "Rossz irányba indultál.");
});

test("a hint between a question and its answer does not steal the turn", () => {
  // The regression this ordering invites: a clue arriving after an unanswered
  // question must not mask it and hand the move back to the Racer.
  const g = hhGame({
    qa_log: [
      entry({ turn_index: 1 }), // asked, unanswered
      entry({ turn_index: 2, turn_type: "clue", question_text: null, clue_text: "Nézd máshol." }),
    ],
  });
  assert.equal(pendingQuestionIndex(g), 1);
  assert.equal(isSeatsTurn(g, "composer"), true);
  assert.equal(isSeatsTurn(g, "racer"), false);
});

test("a hint after an answered question leaves it the Racer's turn", () => {
  const g = hhGame({
    qa_log: [
      entry({ turn_index: 1, composer_response: "NO" }),
      entry({ turn_index: 2, turn_type: "clue", question_text: null, clue_text: "Melegebb." }),
    ],
  });
  assert.equal(pendingQuestionIndex(g), null);
  assert.equal(isSeatsTurn(g, "racer"), true);
});

// --- structural guards ------------------------------------------------------

/** Actual import statements only — these files discuss secretStore in comments. */
function importsSecretStore(src: string): boolean {
  return /^\s*import[\s\S]*?from\s+["'][^"']*secretStore["']/m.test(src);
}

test("the H↔H turn route never imports secretStore", () => {
  // A Human↔Human turn needs no target: the Composer supplies the answer and
  // the existing Adjudicator judges it later at /resolve.
  const src = readFileSync("app/api/game/[id]/hh/turn/route.ts", "utf8");
  assert.equal(importsSecretStore(src), false);
});

test("gameView never imports secretStore", () => {
  // The narrowing rule and the secret lookup must stay in different files.
  assert.equal(importsSecretStore(readFileSync("lib/gameView.ts", "utf8")), false);
});

test("the game page never imports secretStore", () => {
  // It did in the first draft, and check-isolation.mjs rejected it. The
  // approved scope widened the allowlist by exactly one entry: the view route.
  assert.equal(importsSecretStore(readFileSync("app/game/[id]/page.tsx", "utf8")), false);
});

test("exactly one V2.3 entry was added to the secret allowlist", () => {
  const src = readFileSync("scripts/check-isolation.mjs", "utf8");
  // Scoped to the PERMITTED block. The game page appears elsewhere in this file
  // — in QUARANTINED, which is where it belongs: quarantined FROM the secret.
  const permitted = src.slice(
    src.indexOf("const PERMITTED_SECRET_IMPORTERS"),
    src.indexOf("const QUARANTINED")
  );
  assert.ok(permitted.length > 0, "could not locate the allowlist block");
  assert.equal(
    (permitted.match(/"app\/api\/game\/\[id\]\/view\/route\.ts"/g) || []).length,
    1,
    "the view route, and nothing else"
  );
  assert.doesNotMatch(permitted, /"app\/game\/\[id\]\/page\.tsx"/);
});

test("the Composer secret getter is identity-gated inside secretStore", () => {
  const src = readFileSync("lib/secretStore.ts", "utf8");
  assert.match(src, /getSecretForComposer/);
  assert.match(src, /composer_player_id !== requestingPlayerId/);
});

test("migration 0003 is additive and keeps erasure working on finalized rows", () => {
  const m = readFileSync("migrations/0003_human_human_participants.sql", "utf8");
  assert.match(m, /ADD COLUMN IF NOT EXISTS composer_player_id/);
  assert.match(m, /ADD COLUMN IF NOT EXISTS racer_player_id/);
  assert.doesNotMatch(m, /DROP TABLE|DROP COLUMN/);
  // Without this the unlink would raise on an already-finalized H↔H game.
  assert.match(m, /- 'composer_player_id' - 'racer_player_id'/);
});
