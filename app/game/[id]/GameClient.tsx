"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pendingClueRequest } from "@/lib/clueCredits";
import { completedHistoryForDisplay } from "@/lib/gameHistoryOrder";
import { derivePhaseOneState, isReferentScopeQuestion } from "@/lib/phaseOne";
import { questionNumbers } from "@/lib/questionNumbers";
import { isSandboxClarificationEntry } from "@/lib/sandboxClarification";
import { effectiveConsumed, isWithinCorrectionWindow } from "@/lib/rewind";
import { shouldAutoRequestTurn, shouldOfferTurnRetry, shouldReconcileStaleRequestOnForeground } from "@/lib/turnRecovery";
import {
  CLIENT_TURN_TIMEOUT_MS,
  CLUE_CLIENT_TIMEOUT_MS,
  RESOLVE_CLIENT_TIMEOUT_MS,
  createRequestOwnership,
  mergeViewIntoGame,
  reconciliationShowsProgress,
  runOwnedTurnRequest,
  runOwnedResolveRequest,
  type ActiveRequestHandle,
  type RequestOwnership,
  type ResolveResponseBody,
  type TurnResponseBody,
} from "@/lib/turnRequestGuard";
import type { GameView } from "@/lib/gameView";
import type { ComposerAnswer, GameLanguage, GameRecord, QuestionLogEntry } from "@/lib/types";
import ResultPanel from "./ResultPanel";
import AccountControl from "@/app/components/AccountControl";
import EvaluationState from "@/app/components/EvaluationState";
import ThinkingIndicator from "@/app/components/ThinkingIndicator";

// V2.8.4.1 — the retry delay for a turn_in_progress response (the server's
// turn lock is already held, most often by a still-finishing provider call
// from a prior attempt). Long enough that a bounded retry loop cannot hammer
// the endpoint; short enough that the player never notices a stall.
const TURN_LOCK_RETRY_DELAY_MS = 3000;

interface Props {
  initialGame: GameRecord;
  versionLabel: string;
  /** V2.8.4.3 — resolved server-side by app/game/[id]/page.tsx. */
  accountAuthenticated?: boolean;
  accountPhotoUrl?: string | null;
}

/** Stored values stay YES/NO/AMBIGUOUS; only the display is Hungarian. */
const ANSWER_HU: Record<string, string> = {
  YES: "IGEN",
  NO: "NEM",
  AMBIGUOUS: "IS-IS",
};

/**
 * V2.8.5 FINAL ENGINE-CONTRACT CORRECTION (localization) — the "+1"
 * corridor's UI text was hard-coded Hungarian, so an English game received
 * Hungarian copy at exactly the moment it most needs to be legible: a
 * private clarification question, or the terminal restart/reframe state.
 * Selected by game.game_language, matching the pattern ResultPanel.tsx's
 * own integrityFallbackNotice() already established for bilingual copy.
 */
const SANDBOX_CLARIFICATION_LABEL: Record<GameLanguage, string> = {
  hu: "Privát célpont-tisztázás — nem az AI kérdése, és nem számít bele a kérdéseibe.",
  en: "Private target clarification — not a question from the AI, and it does not count against your questions.",
};

const SANDBOX_CLARIFICATION_FAILURE_HEADING: Record<GameLanguage, string> = {
  hu: "Nem sikerült egyértelmű célkategóriát megállapítani",
  en: "Could not establish a clear target category",
};

// V2.8.7.1 — the game is NOT actually over here: game.phase never leaves
// "questioning" (see app/api/game/[id]/turn/route.ts's own comment on this
// branch), and the correction window fix in lib/rewind.ts's
// isWithinCorrectionWindow means one of the five recent, visible answers
// above is now reachably correctable. The copy says so — this used to read
// as a dead end ("this game cannot continue... start a new game") when a
// working way back was the whole point of the fix.
const SANDBOX_CLARIFICATION_FAILURE_BODY: Record<GameLanguage, string> = {
  hu: "A megadott válaszokból nem alakult ki egyértelmű, privát célkategória-szerződés. Javítsd az egyik nemrégi válaszodat fent — ez nem fogyaszt új kérdést. Ha inkább újrakezdenéd, azt is megteheted.",
  en: "Your answers did not settle into a clear, private target-category contract. Correct one of your recent answers above — this does not use another question. You can also start a new game instead, if you would rather.",
};

const SANDBOX_CLARIFICATION_NEW_GAME_LABEL: Record<GameLanguage, string> = {
  hu: "Inkább új játékot kezdek",
  en: "Start a new game instead",
};

function pendingQuestion(game: GameRecord): QuestionLogEntry | null {
  const last = game.qa_log.length > 0 ? game.qa_log[game.qa_log.length - 1] : undefined;
  if (!last) return null;
  if (last.turn_type !== "question") return null;
  return last.composer_response === null ? last : null;
}

/** How many turns a correction at this turn would discard. */
function discardCount(game: GameRecord, turnIndex: number): number {
  const index = game.qa_log.findIndex((e) => e.turn_index === turnIndex);
  return index < 0 ? 0 : game.qa_log.length - index - 1;
}

function answeredTurns(game: GameRecord): QuestionLogEntry[] {
  return game.qa_log.filter(
    (e) =>
      (e.turn_type !== "question" || e.composer_response !== null) &&
      // V2.8.5 ENGINE-CONTRACT CORRECTION (defect 5) — a completed "+1"
      // private sandbox-clarification entry is not a Racer question and must
      // not appear in the ordinary Racer-question history at all, numbered
      // or not.
      !isSandboxClarificationEntry(e)
  );
}

interface GuessCheckpoint {
  guessEntry: QuestionLogEntry;
  /** The single answer that produced the guess — the only thing the Composer sees here. */
  answeredEntry: QuestionLogEntry;
}

/**
 * V2.6.x — the pre-guess checkpoint.
 *
 * The turn route computes and stores the Racer's final guess in the same
 * call that records the triggering answer, so by the time this component
 * sees it the guess already exists in `game`. This deliberately does NOT
 * render it (see the `turns` filter below) or let the auto-resolve effect
 * fire until the Composer has confirmed — or corrected — the one answer that
 * produced it. A mis-tap immediately before a guess used to be irreversible
 * the instant the guess appeared; now it has one more, narrower chance: the
 * Composer sees their own last answer, never the AI's guess, and can still
 * fix it via the ordinary correction flow before the guess is ever shown.
 * See docs/DESIGN-NOTES.md §48 and lib/rewind.ts's
 * isPreGuessCheckpointCorrection, which is what makes the correction
 * itself possible while phase is "resolving".
 */
function pendingGuessCheckpoint(game: GameRecord): GuessCheckpoint | null {
  if (game.phase !== "resolving") return null;
  const guessEntry = game.qa_log[game.qa_log.length - 1];
  if (!guessEntry || guessEntry.turn_type !== "guess") return null;
  const answeredEntry = game.qa_log[game.qa_log.length - 2];
  if (
    !answeredEntry ||
    answeredEntry.turn_type !== "question" ||
    answeredEntry.composer_response === null
  ) {
    return null;
  }
  return { guessEntry, answeredEntry };
}

export default function GameClient({
  initialGame,
  versionLabel,
  accountAuthenticated = false,
  accountPhotoUrl = null,
}: Props) {
  const [game, setGame] = useState<GameRecord>(initialGame);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // V2.8.5 ENGINE-CONTRACT CORRECTION (defect 5) — the "+1" corridor's
  // truthful "no coherent contract" terminal state. Distinct from `error`:
  // this is not a retryable gameplay failure, so it gets its own localized,
  // actionable panel rather than the generic red error banner.
  const [sandboxClarificationFailed, setSandboxClarificationFailed] = useState(false);
  const [ambiguousMode, setAmbiguousMode] = useState(false);
  const [explanation, setExplanation] = useState("");
  // V2.6.x — set only by the pre-guess checkpoint's own confirm button. While
  // false and a guess is pending reveal, the guess entry is withheld from the
  // transcript and the auto-resolve effect below does not fire. See
  // pendingGuessCheckpoint above.
  const [guessConfirmed, setGuessConfirmed] = useState(false);
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [correctionExplanation, setCorrectionExplanation] = useState("");
  // Mirrors `ambiguousMode` on the main answer path: Ambiguous reveals the
  // optional note before committing, Yes/No commit straight away.
  const [correctionAmbiguousMode, setCorrectionAmbiguousMode] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Keyed on qa_log length rather than a boolean, so the resume also fires
  // after a rewind truncates the log — not only on the opening turn.
  const autoTurnFor = useRef<number | null>(null);
  const resolveFired = useRef(false);
  // V2.5-B4 — the last turn attempt failed and no human has asked to retry.
  // Suspends only the AUTOMATIC path; see lib/turnRecovery.ts for why clearing
  // the ref alone would turn one failure into a retry loop.
  const [turnFailed, setTurnFailed] = useState(false);
  // V2.8.4.1 — the server's turn lock is already held by another in-flight
  // request (see lib/turnRequestGuard.ts's turn_in_progress handling). This
  // is transient, not a failure: a dedicated effect below retries quietly
  // after a short delay instead of surfacing a dead-looking error.
  const [awaitingTurnLock, setAwaitingTurnLock] = useState(false);

  // S1 / RB-1 — request ownership. See lib/turnRequestGuard.ts. One tracker
  // for the life of this screen; only the most recently begun sendTurn() may
  // mutate game/error/busy/turnFailed/ambiguousMode/explanation or the
  // auto-turn guard below.
  const requestOwnershipRef = useRef<RequestOwnership | null>(null);
  if (!requestOwnershipRef.current) {
    requestOwnershipRef.current = createRequestOwnership();
  }
  // Always the latest `game` — read by a reconciliation that may run after
  // this closure's own `game` has gone stale (a newer request may already
  // have updated it while this one was still failing).
  const gameRef = useRef(game);
  useEffect(() => {
    gameRef.current = game;
  }, [game]);
  // V2.8.5.1 — the CURRENT /turn request's abort handle, if one is in
  // flight; null otherwise. Lets the visibilitychange handler below abort a
  // request it judges stale directly, through the SAME path
  // CLIENT_TURN_TIMEOUT_MS's own internal timer uses — see
  // lib/turnRequestGuard.ts's own doc on why this is one mechanism with two
  // triggers, not two competing ones.
  const activeRequestRef = useRef<ActiveRequestHandle | null>(null);

  // V2.8.5.2 — /resolve's own request-ownership tracker, independent of
  // /turn's above (a separate request stream). Mirrors requestOwnershipRef
  // exactly — see lib/turnRequestGuard.ts's runOwnedResolveRequest.
  const resolveOwnershipRef = useRef<RequestOwnership | null>(null);
  if (!resolveOwnershipRef.current) {
    resolveOwnershipRef.current = createRequestOwnership();
  }
  const activeResolveRequestRef = useRef<ActiveRequestHandle | null>(null);
  // V2.8.5.2 (D) — synchronous submission guard for resolveGame() itself:
  // claimed the instant the FIRST call begins, before any await, so a rapid
  // second tap of the Retry control (or an overlapping auto-fire) returns
  // immediately rather than firing a second POST /resolve. Released only
  // when the owned request reaches its terminal/reconciled state. See the
  // identical pattern on the answer-submission path below.
  const resolveInFlightRef = useRef(false);
  // V2.8.5.2 (D) — the same synchronous submission guard for sendTurn()
  // itself. Production forensic (game a0b7743b-...): dense clusters of
  // 409s (up to 6 in ~11s) consistent with two answer submissions landing
  // before React's `disabled={busy}` re-render could commit — the SERVER's
  // turn-lock/CAS correctly rejected the collision every time (no wrong
  // answer was ever applied), but each extra submission still cost a real
  // request and a quiet turn_in_progress retry cycle. A plain ref update is
  // synchronous, unlike React state, so checking it FIRST (before any
  // await, before runOwnedTurnRequest's own state.setBusy(true) even runs)
  // closes the exact window a double-tap or duplicate event needs. This
  // does NOT interfere with sendTurn()'s own internal callers (the
  // auto-turn effect, the awaitingTurnLock quiet retry, retryTurn): each of
  // those only ever fires once busy is already false, i.e. once a PRIOR
  // sendTurn() call has already fully settled and cleared this same ref —
  // they are sequential with the call they follow, never concurrent with it.
  const answerInFlightRef = useRef(false);

  // V2.8.6 R2 — sendClue()'s own request-ownership tracker, independent of
  // sendTurn's and resolveGame's above (a third, separate request stream —
  // same reasoning as resolveOwnershipRef's own doc). Safe as a THIRD
  // independent stream rather than sharing sendTurn's: the clue-request
  // panel and the pending-question panel are mutually exclusive render
  // branches below (clueWanted and pending can never both be true — each
  // checks the qa_log's single last entry's turn_type), so there is no
  // button that can race sendTurn's, unlike RacerClient.tsx's screen (see
  // that file's own comment on why IT shares one mutex instead).
  const clueOwnershipRef = useRef<RequestOwnership | null>(null);
  if (!clueOwnershipRef.current) {
    clueOwnershipRef.current = createRequestOwnership();
  }
  const activeClueRequestRef = useRef<ActiveRequestHandle | null>(null);
  // (D) synchronous submission guard for sendClue() itself — see
  // answerInFlightRef's own doc above for why a plain ref, not React state.
  const clueInFlightRef = useRef(false);
  const clueTurnFailedRef = useRef(false);

  const pending = pendingQuestion(game);
  // The Racer spent a credit and is waiting on words, not on YES/NO.
  const clueWanted = pendingClueRequest(game);
  // V2.8.4.1 correction — referent scope answered IS-IS twice (the primary
  // question and its deterministic clarification). Phase One does not guess
  // a value here and must never hand this to Phase Two — the Setter has to
  // correct one of the two scope answers before play can continue. Computed
  // straight from the same pure replay GameClient already trusts for the
  // "my Swiss Army knife" helper text; the server enforces the actual block
  // (see app/api/game/[id]/turn/route.ts), this is purely the explanation.
  const phaseOneScopeUnresolved = derivePhaseOneState(game.qa_log, game.game_language).unresolved;
  const [clueText, setClueText] = useState("");

  // V2.8.6 R2 — rebuilt on runOwnedTurnRequest, the same shared,
  // ownership-guarded module sendTurn/resolveGame already use (see
  // lib/turnRequestGuard.ts). Previously a plain fetch/setState wrapper with
  // no lock-sharing, no revision, no ownership and no reconciliation —
  // exactly the shape that module's own doc names as the original
  // sendTurn defect.
  const sendClue = useCallback(async () => {
    // (D) synchronous guard — see clueInFlightRef's own doc above.
    if (clueInFlightRef.current) return;
    clueInFlightRef.current = true;
    // Read once, before the request begins: clueText is cleared on success
    // inside setGame below, so the value captured here (not a re-read of
    // React state after the fact) is what must be sent.
    const textToSend = clueText;
    try {
      await runOwnedTurnRequest(
        clueOwnershipRef.current as RequestOwnership,
        {
          requestTurn: async (signal) => {
            const res = await fetch(`/api/game/${gameRef.current.game_id}/clue`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                clue_text: textToSend,
                // V2.8.6 R2 — the My Car Key invariant, extended to /clue.
                expected_revision: gameRef.current.revision,
              }),
              signal,
            });
            const data = (await res.json()) as TurnResponseBody;
            return { ok: res.ok, data };
          },
          requestView: async () => {
            const res = await fetch(`/api/game/${gameRef.current.game_id}/view`);
            const body = (await res.json()) as { view?: GameView };
            return { ok: res.ok, view: body.view ?? null };
          },
        },
        {
          getGame: () => gameRef.current,
          setGame: (next) => {
            // Clear the draft only once the transcript actually shows the
            // clue landed (mirrors RacerClient's own reconciliationShowsProgress
            // use for its compose fields) — not merely because THIS attempt's
            // own HTTP response was ok, since a lost-response reconciliation
            // must also be able to clear it.
            if (reconciliationShowsProgress(gameRef.current, next)) {
              setClueText("");
            }
            setGame(next);
          },
          setError,
          setTurnFailed: (failed) => {
            clueTurnFailedRef.current = failed;
          },
          setBusy,
          setAmbiguousMode: () => {},
          setExplanation: () => {},
          clearAutoTurnGuard: () => {},
          setTurnInProgress: () => {},
          registerActiveRequest: (handle) => {
            activeClueRequestRef.current = handle;
          },
          clearActiveRequest: () => {
            activeClueRequestRef.current = null;
          },
        },
        CLUE_CLIENT_TIMEOUT_MS
      );
    } finally {
      clueInFlightRef.current = false;
    }
  }, [clueText]);

  // S1 / RB-1 — the actual GameClient.sendTurn() defect and its fix are
  // documented in lib/turnRequestGuard.ts's module doc. This function is now
  // a thin transport/state adapter: request ownership (so a superseded
  // request's late success/failure/finally can never overwrite what a newer
  // one already established) and canonical-truth reconciliation on a
  // transport failure (one GET /view read, never a second /turn call) both
  // live in that pure, directly-tested module — see
  // test/turnRequestGuard.test.ts.
  const sendTurn = useCallback(
    async (answer?: ComposerAnswer, ambiguousExplanation?: string) => {
      // (D) synchronous guard — see answerInFlightRef's own doc above.
      if (answerInFlightRef.current) return;
      answerInFlightRef.current = true;
      try {
        await runOwnedTurnRequest(
          requestOwnershipRef.current as RequestOwnership,
          {
          requestTurn: async (signal) => {
            const res = await fetch(`/api/game/${game.game_id}/turn`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                answer
                  ? {
                      answer,
                      ambiguous_explanation: ambiguousExplanation,
                      // V2.8.1 — the My Car Key integrity hotfix. Binds this
                      // answer to the exact state this screen was showing, so a
                      // stale retry can never land on a question the human never
                      // saw. See lib/types.ts's GameRecord.revision.
                      expected_revision: game.revision,
                    }
                  : {}
              ),
              // V2.8.5.1 — lets lib/turnRequestGuard.ts's CLIENT_TURN_TIMEOUT_MS
              // (or a stale-request abort from the visibilitychange handler
              // below) actually cancel THIS network request, not merely stop
              // waiting on it client-side.
              signal,
            });
            const data = (await res.json()) as TurnResponseBody;
            return { ok: res.ok, data };
          },
          requestView: async () => {
            const res = await fetch(`/api/game/${gameRef.current.game_id}/view`);
            const body = (await res.json()) as { view?: GameView };
            return { ok: res.ok, view: body.view ?? null };
          },
        },
        {
          getGame: () => gameRef.current,
          setGame: (next) => setGame(next),
          setError,
          setSandboxClarificationFailed,
          setTurnFailed,
          setBusy,
          setAmbiguousMode,
          setExplanation,
          clearAutoTurnGuard: () => {
            // V2.5-B4. Both halves matter and neither works alone:
            //   the ref is cleared so a stale qa_log length can never wedge the
            //   game again — the GROK-03 stall;
            //   turnFailed suspends the automatic path so clearing the ref does
            //   not turn one failure into a loop against a failing provider.
            autoTurnFor.current = null;
          },
          setTurnInProgress: setAwaitingTurnLock,
          registerActiveRequest: (handle) => {
            activeRequestRef.current = handle;
          },
          clearActiveRequest: () => {
            activeRequestRef.current = null;
          },
        }
        );
      } finally {
        // (D) released only once the owned request has fully reached its
        // terminal/reconciled state — runOwnedTurnRequest's own await chain
        // covers both the ordinary path and the reconcile-after-failure path.
        answerInFlightRef.current = false;
      }
    },
    [game.game_id, game.revision]
  );

  /**
   * V2.5-B4 — the human asking for another attempt.
   *
   * The ONLY thing that clears `turnFailed`, which is what keeps recovery
   * deliberate rather than automatic. The ref is cleared too, so if this
   * attempt also fails the game still cannot wedge.
   */
  const retryTurn = useCallback(() => {
    autoTurnFor.current = null;
    setTurnFailed(false);
    setError(null);
    void sendTurn();
  }, [sendTurn]);

  const correctAnswer = useCallback(
    async (turnIndex: number, answer: ComposerAnswer, explanation?: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/game/${game.game_id}/correct`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            turn_index: turnIndex,
            answer,
            ambiguous_explanation: explanation,
            // Optimistic concurrency: refuses if the game moved on meanwhile.
            expected_log_length: game.qa_log.length,
          }),
        });
        const data = await res.json();
        if (data.game) setGame(data.game as GameRecord);
        if (!res.ok) setError(data.message || "Nem sikerült javítani a választ.");
        else {
          // A correction is the human acting on a game that has moved to a new
          // state. Whatever failed before it is no longer the situation, so the
          // automatic resume is re-armed rather than left suspended.
          setTurnFailed(false);
          // V2.8.7.1 — the "+1" corridor's own terminal state is cleared the
          // same deliberate way: only by the human correcting the flagged
          // answer, never by the effect that would otherwise re-request a
          // turn and hit the identical, deterministic failure again. Whether
          // this correction actually resolves the corridor is decided fresh
          // on the NEXT /turn call (Phase One and the clarification state are
          // both replayed from qa_log, never stored) — clearing this flag
          // only re-arms that replay; it does not assume the outcome.
          setSandboxClarificationFailed(false);
        }
      } catch {
        setError("Hálózati hiba — próbáld újra.");
      } finally {
        setBusy(false);
        setCorrecting(null);
        setCorrectionAmbiguousMode(false);
        setCorrectionExplanation("");
      }
    },
    [game.game_id, game.qa_log.length]
  );

  // V2.8.5.2 — bounded, ownership-guarded, and synchronously de-duplicated.
  // See lib/turnRequestGuard.ts's runOwnedResolveRequest doc for the "Hálózati
  // hiba a lezárásnál" production forensic this repairs (a fetch with no
  // timeout, indistinguishable client-side from a server that never
  // responded even though it had actually completed).
  const resolveGame = useCallback(async () => {
    // (D) synchronous guard, claimed before any await: a rapid second tap
    // (or an overlapping auto-fire racing a manual Retry) returns immediately
    // rather than issuing a second POST /resolve. /resolve is idempotent
    // server-side regardless, but this avoids spending a second round-trip
    // (and, while a review is genuinely running, a second provider budget
    // slot) on a request already in flight.
    if (resolveInFlightRef.current) return;
    resolveInFlightRef.current = true;
    try {
      await runOwnedResolveRequest(
        resolveOwnershipRef.current as RequestOwnership,
        {
          requestResolve: async (signal) => {
            const res = await fetch(`/api/game/${gameRef.current.game_id}/resolve`, {
              method: "POST",
              signal,
            });
            const data = (await res.json()) as ResolveResponseBody;
            return { ok: res.ok, data };
          },
          requestView: async () => {
            const res = await fetch(`/api/game/${gameRef.current.game_id}/view`);
            const body = (await res.json()) as { view?: GameView };
            return { ok: res.ok, view: body.view ?? null };
          },
        },
        {
          getGame: () => gameRef.current,
          setGame: (next) => setGame(next),
          setResolveError,
          setResolving,
          // Allow a retry: the route is idempotent and the phase is unchanged.
          clearResolveGuard: () => {
            resolveFired.current = false;
          },
          registerActiveRequest: (handle) => {
            activeResolveRequestRef.current = handle;
          },
          clearActiveRequest: () => {
            activeResolveRequestRef.current = null;
          },
        }
      );
    } finally {
      resolveInFlightRef.current = false;
    }
  }, []);

  const guessCheckpoint = pendingGuessCheckpoint(game);
  const guessRevealPending = guessCheckpoint !== null && !guessConfirmed;

  // Resolve as soon as the game reaches "resolving" — UNLESS an unconfirmed
  // guess is sitting behind the pre-guess checkpoint, in which case scoring
  // waits for the Composer, same as the reveal does. The ref guards
  // strict-mode double-effect; the route is idempotent regardless, which
  // matters here because each real invocation spends strong-model calls.
  useEffect(() => {
    if (resolveFired.current) return;
    if (game.phase !== "resolving") return;
    if (guessRevealPending) return;
    resolveFired.current = true;
    void resolveGame();
  }, [game.phase, guessRevealPending, resolveGame]);

  // Ask the Racer for the next question whenever the game is live and nothing
  // is pending. That covers the opening turn and the resume after a rewind,
  // which leaves exactly the same state: last entry answered, none pending.
  // The ref keys on log length so it fires once per state, and the route's
  // idempotency guard covers every other duplicate path.
  useEffect(() => {
    // V2.5-B4 — the decision moved to lib/turnRecovery.ts so it can be tested
    // without running React. This effect now only APPLIES it.
    if (
      !shouldAutoRequestTurn({
        phase: game.phase,
        hasPendingQuestion: pendingQuestion(game) !== null,
        // A clue request is just as much a turn awaiting the human as a
        // question is.
        hasPendingClueRequest: Boolean(pendingClueRequest(game)),
        busy,
        turnFailed,
        sandboxClarificationFailed,
        lastAutoTurnAt: autoTurnFor.current,
        qaLogLength: game.qa_log.length,
      })
    ) {
      return;
    }
    autoTurnFor.current = game.qa_log.length;
    void sendTurn();
  }, [game, busy, turnFailed, sandboxClarificationFailed, sendTurn]);

  // V2.8.4.1 — turn_in_progress: the server's lock is already held (most
  // often a still-finishing provider call from a prior attempt). Quiet,
  // bounded retry after a short delay — never a dead-looking screen, never an
  // immediate hot loop against a lock that has not cleared yet.
  useEffect(() => {
    if (!awaitingTurnLock || busy) return;
    const timer = setTimeout(() => {
      void sendTurn();
    }, TURN_LOCK_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [awaitingTurnLock, busy, sendTurn]);

  // V2.8.4.1 — reconcile on return from the background. A fetch suspended
  // while the tab was hidden is neither a confirmed success nor a confirmed
  // failure; assuming failure would show a false error over a turn the
  // server may already have completed. Reuses the SAME canonical-truth
  // helpers lib/turnRequestGuard.ts's own failure path already trusts — no
  // new reconciliation logic, just a second trigger for the existing one.
  //
  // V2.8.5.1 — the plain `if (busy) return` here is what let the "silent
  // stall" forensic's game freeze permanently: it assumed an in-flight
  // request always eventually settles, which is false for a fetch a
  // backgrounded mobile browser silently discards. Now: a busy request is
  // left alone ONLY while shouldReconcileStaleRequestOnForeground says it is
  // still within its legitimate window; a STALE busy request is aborted
  // directly via activeRequestRef, which drives it down runOwnedTurnRequest's
  // own existing abort→reconcile path (one mechanism, two triggers — see
  // lib/turnRequestGuard.ts). This never issues a second /turn call itself,
  // and aborting an already-settled or already-aborted handle is a no-op, so
  // repeated visibility events cannot stack recovery attempts.
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState !== "visible") return;
      if (busy) {
        const active = activeRequestRef.current;
        if (
          !shouldReconcileStaleRequestOnForeground({
            busy,
            activeRequestStartedAt: active?.startedAt ?? null,
            now: Date.now(),
            timeoutMs: CLIENT_TURN_TIMEOUT_MS,
          })
        ) {
          return; // still within its legitimate active window — leave it alone
        }
        active?.abort();
        return;
      }
      void (async () => {
        try {
          const res = await fetch(`/api/game/${gameRef.current.game_id}/view`);
          const body = (await res.json()) as { view?: GameView };
          if (!res.ok || !body.view) return;
          const before = gameRef.current;
          const reconciled = mergeViewIntoGame(before, body.view);
          if (reconciliationShowsProgress(before, reconciled)) {
            setGame(reconciled);
            setError(null);
            setTurnFailed(false);
          }
        } catch {
          // Best-effort background refresh, not a user action — silent.
        }
      })();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [busy]);

  // V2.8.4.1 — the three-stage AI-activity indicator's episode clock. Owned
  // here (not by ThinkingIndicator's own mount time) so a turn_in_progress
  // retry mid-wait does not reset the stage back to "eager": the indicator
  // stays mounted continuously across the gap between attempts because
  // `waitingForAi` stays true (awaitingTurnLock) even while `busy` is
  // momentarily false between the two requests.
  const waitingForAi = (busy || awaitingTurnLock) && !clueWanted && !guessRevealPending;
  const [waitStartedAt, setWaitStartedAt] = useState<number | null>(null);
  useEffect(() => {
    if (waitingForAi) {
      setWaitStartedAt((prev) => prev ?? Date.now());
    } else {
      setWaitStartedAt(null);
    }
  }, [waitingForAi]);

  const offerTurnRetry = shouldOfferTurnRetry({
    phase: game.phase,
    hasPendingQuestion: pending !== null,
    hasPendingClueRequest: Boolean(clueWanted),
    busy,
    turnFailed,
    sandboxClarificationFailed,
    lastAutoTurnAt: autoTurnFor.current,
    qaLogLength: game.qa_log.length,
  });

  // See lib/questionNumbers.ts — turn_index is an identifier, not a count.
  const numbers = questionNumbers(game.qa_log);
  // The guess itself stays out of the transcript entirely until the
  // checkpoint above is confirmed — "show the player their own last answer,
  // not the AI's proposed guess."
  const turns = answeredTurns(game).filter(
    (e) => !(guessRevealPending && e.id === guessCheckpoint!.guessEntry.id)
  );
  // V2.8.4.2 — correction-budget integrity. Uses the durable floor, not the
  // possibly-lower recomputed question_count, so the displayed remaining
  // count can never imply a correction bought back spent questions.
  const consumed = effectiveConsumed(game);
  const questionsLeft = Math.max(0, game.max_questions - consumed);

  return (
    <main className="mx-auto flex w-full min-h-screen max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--ink)]/10 pb-3">
        <div className="flex min-w-0 flex-col">
          <a href="/" className="flex min-w-0 items-center gap-2" aria-label="Barkóba főoldal">
            <span
              aria-hidden="true"
              className="inline-block h-6 w-6 shrink-0 rounded-full border-[3px] border-[var(--ink)]/80"
              style={{ borderRightColor: "transparent" }}
            />
            <span className="truncate text-base font-semibold tracking-tight">Barkóba</span>
          </a>
          {/*
            The version also sits at the very bottom of this screen, which after
            a twenty-question transcript is a scroll hunt. A field tester must
            be able to read the build identity without leaving the first
            viewport, so it lives in the persistent header too. Same single
            source, rendered twice — no second hardcoded string.
          */}
          <span
            className="mt-0.5 text-[11px] tabular-nums text-[var(--ink-soft)]"
            title="Telepített Barkóba verzió"
          >
            {versionLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-start gap-2">
          {/* V2.8.4.3 — same account control as every other header surface. */}
          <AccountControl authenticated={accountAuthenticated} photoUrl={accountPhotoUrl} />
          <div className="text-right">
            <div className="text-sm font-semibold tabular-nums">
              {consumed} / {game.max_questions}
            </div>
            <div className="text-xs text-[var(--ink-soft)]">{questionsLeft} maradt</div>
          </div>
        </div>
      </header>

      <p className="-mt-2 text-sm text-[var(--ink-soft)]">
        <span className="font-medium text-[var(--ink)]">Te gondoltál valamire. Az AI kérdez.</span>
      </p>

      <section className="flex flex-col gap-4">
        {/*
          V2.8.4.1 — ACTIVE AREA, always first: whatever needs the player's
          attention right now (a clue request, the pre-guess checkpoint, or
          the current question) appears directly below the header, before the
          completed transcript, so a new question never requires scrolling to
          the bottom to find it. Exactly one of these four is ever true at a
          given moment — clueWanted/guessRevealPending/pending are mutually
          exclusive by construction (each checks the qa_log's single LAST
          entry's turn_type).
        */}
        {clueWanted && (
          <div className="flex flex-col gap-3 rounded-md border border-[var(--blue)]/35 bg-[var(--blue)]/6 p-4">
            <p className="text-sm text-[var(--blue)]">
              Az AI súgót kért. Segíts neki — ez nem számít bele a kérdéseibe.
            </p>
            <textarea
              spellCheck
              autoCorrect="on"
              autoCapitalize="sentences"
              // V2.8.4.2 — mobile note-text tolerance: a locale hint so the
              // device's own spell-checker/autocorrect uses the right
              // dictionary. Purely a UI hint — the server stores whatever
              // text is submitted, unchanged.
              lang={game.game_language}
              className="h-20 w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--blue)]"
              value={clueText}
              onChange={(e) => setClueText(e.target.value)}
              placeholder="pl. Nem a lakásban keresd."
              disabled={busy}
            />
            <button
              onClick={() => void sendClue()}
              disabled={busy || !clueText.trim()}
              className="min-h-11 self-start rounded-md bg-[var(--blue)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
            >
              Súgok
            </button>
          </div>
        )}

        {!clueWanted && guessRevealPending && (
          <div className="flex flex-col gap-3 rounded-md border border-[var(--ink)]/25 bg-white/60 p-4">
            <p className="text-sm text-[var(--ink)]">
              Az AI a végső tippjére készül. Mielőtt megmutatnánk, nézd át az
              utolsó válaszod itt fent — utoljára most tudod javítani, utána
              már nem.
            </p>
            <button
              onClick={() => setGuessConfirmed(true)}
              disabled={busy || correcting !== null}
              className="min-h-12 self-start rounded-md bg-[var(--green)] px-5 py-3 text-base font-semibold text-[var(--parchment)] shadow-sm disabled:opacity-40"
            >
              Tovább, jöhet a tipp
            </button>
          </div>
        )}

        {!clueWanted && !guessRevealPending && pending && pending.question_text && (
          <div
            className={
              isSandboxClarificationEntry(pending)
                ? "flex flex-col gap-3 rounded-md border border-[var(--blue)]/35 bg-[var(--blue)]/6 p-4"
                : "flex flex-col gap-3 rounded-md border border-[var(--ink)]/25 bg-white/60 p-4"
            }
          >
            {/*
              V2.8.5 ENGINE-CONTRACT CORRECTION (defect 5) — the "+1" private
              sandbox-clarification corridor must visibly identify itself as
              private and state plainly that it costs no Racer question, and
              must NOT carry a numbered badge that would read as though it
              were the AI's Nth question (it is a question to the SETTER, not
              from the Racer, and lib/questionNumbers.ts already excludes it
              from the count these badges show elsewhere).
            */}
            {isSandboxClarificationEntry(pending) ? (
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--blue)]">
                {SANDBOX_CLARIFICATION_LABEL[game.game_language]}
              </p>
            ) : null}
            <div className="flex min-w-0 gap-3">
              {!isSandboxClarificationEntry(pending) && (
                <span className="w-6 shrink-0 pt-0.5 text-xs text-[var(--ink-soft)] sm:w-8">
                  #{numbers.get(pending.id) ?? pending.turn_index}
                </span>
              )}
              <p className="min-w-0 break-words text-sm text-[var(--ink)]">{pending.question_text}</p>
            </div>

            {/*
              V2.8.4.1 — REFERENT SCOPE helper text. Only for the current
              (new-wording) question; an in-progress game still showing the
              old wording gets no helper text, matching what it shipped with.
            */}
            {isReferentScopeQuestion(pending.question_text) && (
              <p className="min-w-0 break-words text-xs text-[var(--ink-soft)] sm:pl-11">
                „A zsebkésem” = IGEN. „Egy zsebkés” = NEM.
              </p>
            )}

            {!ambiguousMode ? (
              <div className="flex flex-wrap gap-2 sm:pl-11">
                <button
                  onClick={() => void sendTurn("YES")}
                  disabled={busy}
                  className="min-h-11 flex-1 rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40 sm:flex-none"
                >
                  IGEN
                </button>
                <button
                  onClick={() => void sendTurn("NO")}
                  disabled={busy}
                  className="min-h-11 flex-1 rounded-md bg-[var(--red)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40 sm:flex-none"
                >
                  NEM
                </button>
                <button
                  onClick={() => setAmbiguousMode(true)}
                  disabled={busy}
                  className="min-h-11 flex-1 rounded-md border border-[var(--red)]/45 px-4 py-2.5 text-sm font-medium text-[var(--ink)] disabled:opacity-40 sm:flex-none"
                >
                  IS-IS
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:pl-11">
                <p className="text-xs text-[var(--ink-soft)]">
                  IS-IS: sem az IGEN, sem a NEM nem lenne pontos pontosítás nélkül. Írd le, miért — az AI látja ezt a megjegyzést. Kitöltése nem kötelező.
                </p>
                <textarea
                  spellCheck
                  autoCorrect="on"
                  autoCapitalize="sentences"
                  // V2.8.4.2 — mobile note-text tolerance: see the clue
                  // textarea's own comment above.
                  lang={game.game_language}
                  className="h-20 w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  placeholder="pl. attól függ, beleszámít-e a fogantyú"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => void sendTurn("AMBIGUOUS", explanation)}
                    disabled={busy}
                    className="min-h-12 flex-1 rounded-md bg-[var(--green)] px-5 py-3 text-base font-semibold text-[var(--parchment)] shadow-sm disabled:opacity-40 sm:flex-none"
                  >
                    IS-IS küldése
                  </button>
                  <button
                    onClick={() => {
                      setAmbiguousMode(false);
                      setExplanation("");
                    }}
                    disabled={busy}
                    className="min-h-11 rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm text-[var(--ink)]"
                  >
                    Mégsem
                  </button>
                </div>
              </div>
            )}

            {waitingForAi && waitStartedAt !== null && (
              <div className="sm:pl-11">
                {/* V2.8.4.1 — shell language is Hungarian regardless of
                    game_language; see lib/gameLanguage.ts's own module doc. */}
                <ThinkingIndicator startedAt={waitStartedAt} language="hu" />
              </div>
            )}
          </div>
        )}

        {!clueWanted && !guessRevealPending && !pending && (
          <div className="flex flex-col gap-3">
            {phaseOneScopeUnresolved ? (
              <div className="rounded-md border border-[var(--red)]/35 bg-[var(--red)]/8 p-4">
                <p className="text-sm text-[var(--red)]">
                  A hatókör kérdésére kétszer is IS-IS érkezett, ezért a kör
                  nem folytatható.
                </p>
                <p className="mt-1 text-sm text-[var(--ink)]">
                  Javítsd ki az egyik választ fent, a korábbi kérdéseknél:
                  IGEN, ha kizárólag egyetlen konkrét példány a jó válasz;
                  NEM, ha bármelyik megfelelő példány elfogadható.
                </p>
              </div>
            ) : waitingForAi && waitStartedAt !== null ? (
              <ThinkingIndicator startedAt={waitStartedAt} language="hu" />
            ) : (
              turns.length === 0 && (
                <p className="text-sm text-[var(--ink-soft)]">Várjuk az AI első kérdését.</p>
              )
            )}
          </div>
        )}

        {/*
          V2.8.4.2 — completed history renders NEWEST-first, below the active
          area above. `completedHistoryForDisplay` returns a new, reversed
          array for THIS rendering only — `turns` itself (chronological) is
          untouched, and remains what drives length/emptiness checks and
          every non-display computation in this component.
        */}
        {completedHistoryForDisplay(turns).map((entry) => (
          <div key={entry.id} className="flex flex-col gap-1.5">
            {entry.turn_type === "question" && entry.question_text && (
              <>
                <div className="flex min-w-0 gap-3">
                  <span className="w-6 shrink-0 pt-0.5 text-xs text-[var(--ink-soft)] sm:w-8">
                    #{numbers.get(entry.id) ?? entry.turn_index}
                  </span>
                  <p className="min-w-0 break-words text-sm text-[var(--ink)]">{entry.question_text}</p>
                </div>
                <div className="flex min-w-0 gap-3">
                  <span className="w-6 shrink-0 sm:w-8" />
                  <span
                    className={
                      entry.composer_response === "YES"
                        ? "text-xs font-medium text-[var(--green)]"
                        : entry.composer_response === "NO"
                          ? "text-xs font-medium text-[var(--red)]"
                          : "text-xs font-medium text-[var(--red)]"
                    }
                  >
                    {ANSWER_HU[entry.composer_response ?? ""] ?? entry.composer_response}
                  </span>
                </div>
                {entry.ambiguous_explanation && (
                  <div className="flex min-w-0 gap-3">
                    <span className="w-6 shrink-0 sm:w-8" />
                    <p className="min-w-0 break-words text-xs italic text-[var(--ink-soft)]">
                      {entry.ambiguous_explanation}
                    </p>
                  </div>
                )}

                {(game.phase === "questioning" ||
                  // The pre-guess checkpoint reuses this same correction UI
                  // for exactly one turn: the answer that produced the
                  // unrevealed guess. See pendingGuessCheckpoint above.
                  (guessRevealPending && guessCheckpoint!.answeredEntry.turn_index === entry.turn_index)) &&
                  // V2.8.4.2 — correction-budget integrity. Only the latest
                  // CORRECTION_WINDOW_SIZE answered questions offer the
                  // control at all; the server enforces the same window
                  // regardless of what this hides or shows.
                  isWithinCorrectionWindow(game.qa_log, entry.turn_index) &&
                  correcting !== entry.turn_index && (
                  <div className="flex min-w-0 gap-3">
                    <span className="w-6 shrink-0 sm:w-8" />
                    <button
                      onClick={() => {
                        setCorrecting(entry.turn_index);
                        setCorrectionAmbiguousMode(false);
                        setCorrectionExplanation(entry.ambiguous_explanation ?? "");
                      }}
                      disabled={busy}
                      className="text-xs text-[var(--ink-soft)] underline underline-offset-2 disabled:opacity-40"
                    >
                      Válasz javítása
                    </button>
                  </div>
                )}

                {correcting === entry.turn_index && (
                  <div className="flex min-w-0 gap-3">
                    <span className="w-6 shrink-0 sm:w-8" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-md border border-[var(--ink)]/25 bg-white/60 p-3">
                      <p className="text-xs text-[var(--ink-soft)]">
                        {discardCount(game, entry.turn_index) > 0 ? (
                          <>
                            A javítás visszaállítja a játékot a(z){" "}
                            {numbers.get(entry.id) ?? entry.turn_index}. kérdésre,
                            és eldobja az utána következő {discardCount(game, entry.turn_index)} kört.
                            Az azóta felhasznált kérdéseket visszakapod.
                          </>
                        ) : (
                          <>Cseréld le a válaszod erre a kérdésre.</>
                        )}
                      </p>
                      {!correctionAmbiguousMode ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => void correctAnswer(entry.turn_index, "YES")}
                            disabled={busy}
                            className="min-h-11 flex-1 rounded-md bg-[var(--green)] px-3 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40 sm:flex-none"
                          >
                            IGEN
                          </button>
                          <button
                            onClick={() => void correctAnswer(entry.turn_index, "NO")}
                            disabled={busy}
                            className="min-h-11 flex-1 rounded-md bg-[var(--red)] px-3 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40 sm:flex-none"
                          >
                            NEM
                          </button>
                          <button
                            onClick={() => setCorrectionAmbiguousMode(true)}
                            disabled={busy}
                            className="min-h-11 flex-1 rounded-md border border-[var(--red)]/45 px-3 py-2.5 text-sm font-medium text-[var(--ink)] disabled:opacity-40 sm:flex-none"
                          >
                            IS-IS
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <p className="text-xs text-[var(--ink-soft)]">
                            Írd le, miért lenne félrevezető egy sima igen vagy
                            nem. Nem kötelező. Az ellenfeled látja ezt a
                            megjegyzést.
                          </p>
                          <textarea
                            spellCheck
                            autoCorrect="on"
                            autoCapitalize="sentences"
                            // V2.8.4.2 — mobile note-text tolerance: see the
                            // clue textarea's own comment above.
                            lang={game.game_language}
                            className="h-20 w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
                            value={correctionExplanation}
                            onChange={(e) => setCorrectionExplanation(e.target.value)}
                            placeholder="pl. attól függ, beleszámít-e a fogantyú"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() =>
                                void correctAnswer(
                                  entry.turn_index,
                                  "AMBIGUOUS",
                                  correctionExplanation
                                )
                              }
                              disabled={busy}
                              className="min-h-12 rounded-md bg-[var(--green)] px-5 py-3 text-base font-semibold text-[var(--parchment)] disabled:opacity-40"
                            >
                              IS-IS küldése
                            </button>
                            <button
                              onClick={() => setCorrectionAmbiguousMode(false)}
                              disabled={busy}
                              className="min-h-11 rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm text-[var(--ink)]"
                            >
                              Vissza
                            </button>
                          </div>
                        </div>
                      )}
                      <button
                        onClick={() => {
                          setCorrecting(null);
                          setCorrectionAmbiguousMode(false);
                          setCorrectionExplanation("");
                        }}
                        disabled={busy}
                        className="self-start text-xs text-[var(--ink-soft)] underline underline-offset-2"
                      >
                        Mégsem
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {entry.turn_type === "guess" && (
              <div className="rounded-md border border-[var(--ink)]/25 bg-white/70 p-3">
                <p className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">
                  Az AI tippje
                </p>
                <p className="mt-1 break-words text-sm text-[var(--ink)]">{entry.guess_text}</p>
              </div>
            )}

            {entry.turn_type === "clue" && (
              <div className="rounded-md border border-[var(--blue)]/30 bg-[var(--blue)]/6 p-3">
                <p className="whitespace-nowrap text-xs uppercase tracking-wide text-[var(--blue)]">
                  SÚGÓ
                </p>
                <p className="mt-1 break-words text-sm text-[var(--blue)]">
                  {entry.clue_text ?? "Az AI súgót kért."}
                </p>
              </div>
            )}

            {entry.turn_type === "concede" && (
              <div className="rounded-md border border-[var(--ink)]/25 bg-white/70 p-3">
                <p className="text-sm text-[var(--ink)]">Az AI feladta.</p>
              </div>
            )}
          </div>
        ))}
      </section>

      {/*
        Not shown while guessRevealPending — still at the checkpoint above,
        nothing has actually started resolving yet.
      */}
      {game.phase === "resolving" && !guessRevealPending && (
        <EvaluationState error={resolveError} busy={resolving} onRetry={() => void resolveGame()} />
      )}

      {game.phase === "complete" && (
        <ResultPanel
          game={game}
          resolving={resolving}
          error={resolveError}
          onRetry={() => void resolveGame()}
        />
      )}

      {/*
        V2.8.5 ENGINE-CONTRACT CORRECTION (defect 5) — the "+1" corridor's
        truthful terminal state. Not a retryable failure (no retry button —
        there is nothing left to retry), and not the generic red error
        banner: an honest explanation plus the existing New Game navigation,
        matching the requirement that this never surface as a raw/generic
        409 error.
      */}
      {sandboxClarificationFailed && (
        <section className="rounded-md border border-[var(--ink)]/25 bg-white/70 p-4">
          <h2 className="text-base font-semibold text-[var(--ink)]">
            {SANDBOX_CLARIFICATION_FAILURE_HEADING[game.game_language]}
          </h2>
          <p className="mt-2 text-sm text-[var(--ink-soft)]">
            {SANDBOX_CLARIFICATION_FAILURE_BODY[game.game_language]}
          </p>
          <a
            href="/"
            className="mt-4 inline-block min-h-11 rounded-md bg-[var(--green)] px-5 py-3 text-sm font-medium text-[var(--parchment)]"
          >
            {SANDBOX_CLARIFICATION_NEW_GAME_LABEL[game.game_language]}
          </a>
        </section>
      )}

      {error && (
        <div className="rounded-md border border-[var(--red)]/35 bg-[var(--red)]/8 p-3">
          <p className="text-sm text-[var(--red)]">{error}</p>

          {/* V2.5-B4 — the way back.
              Before this, a failed turn was a dead end: the message said "try
              again" and nothing on the page could. Your answers and any
              correction are already saved on the server, so this asks for the
              next question again and loses nothing. */}
          {offerTurnRetry && (
            <button
              type="button"
              onClick={retryTurn}
              className="mt-3 min-h-11 rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
            >
              Kérdés újrakérése
            </button>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <a
          href="/"
          className="inline-flex min-h-11 items-center text-sm text-[var(--ink-soft)] underline-offset-2 hover:underline"
        >
          ← Vissza a Barkóba főoldalra
        </a>
        <span className="text-xs text-[var(--ink-soft)]" title="Telepített Barkóba verzió">
          {versionLabel}
        </span>
      </div>
    </main>
  );
}
