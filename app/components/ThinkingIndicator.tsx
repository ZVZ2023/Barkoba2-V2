"use client";

import { useEffect, useRef, useState } from "react";
import {
  createWaitingMessageRotation,
  stageForElapsedMs,
  THINKING_STAGE_COPY,
  WAITING_MESSAGE_ROTATION_MS,
  type ThinkingStage,
  type WaitingMessagePair,
} from "@/lib/thinkingIndicator";
import type { GameLanguage } from "@/lib/types";

// ---------------------------------------------------------------------------
// V2.8.4.1 — the three-stage AI-activity indicator.
// V2.8.4.2 — expanded with a rotating, curated waiting-message library.
//
// Reuses the same ring motif as the header logo and EvaluationState (a
// partial circle, animated via Tailwind's own animate-spin) rather than a new
// illustration — re-timed per stage instead of drawn from scratch. Compact
// and inline by design: this sits inside the active-question card, not as a
// full-screen overlay, per the explicit requirement that it must not consume
// most of the phone screen.
//
// TRUTHFUL BY CONSTRUCTION: this component has no success/failure/timeout
// state of its own. The caller (GameClient) mounts it for exactly as long as
// it is genuinely waiting on the next turn and unmounts it the instant
// canonical progress, success, or failure arrives — see lib/thinkingIndicator.ts's
// own module doc. `startedAt` is owned by the caller (not Date.now() at this
// component's own mount) specifically so a turn_in_progress retry mid-wait
// does not reset the stage clock back to "eager". Unmounting (React's own
// cleanup on the effects below) is what ends the rotation on success or a
// resolved error — there is no separate "stop" call to remember.
//
// TWO SEPARATE CHANNELS, ONE FOR EACH AUDIENCE. THINKING_STAGE_COPY (the
// original v2.8.4.1 per-stage line) is the STABLE status: it lives in the
// aria-live region and changes at most twice over a whole wait — at a stage
// boundary, never on the rotation's own cadence. The curated message library
// is purely decorative: shown visually, marked aria-hidden, and rotates every
// few seconds. Putting the rotating text inside aria-live would flood a
// screen reader on every rotation; keeping it out, while the stable line
// still announces the one meaningful state change a screen-reader user
// actually needs, is the whole point of having two channels rather than one.
// ---------------------------------------------------------------------------

const STAGE_TICK_MS = 1000;

/** Spin duration per stage — brisk and lively at first, slowing into a
 * calmer, more deliberate rotation as the wait lengthens. */
const STAGE_SPIN_SECONDS: Record<ThinkingStage, number> = {
  eager: 1.1,
  focused: 2.4,
  deep: 4.5,
};

interface Props {
  /** Date.now() when this waiting episode began. */
  startedAt: number;
  language: GameLanguage;
}

export default function ThinkingIndicator({ startedAt, language }: Props) {
  const [stage, setStage] = useState<ThinkingStage>(() => stageForElapsedMs(Date.now() - startedAt));
  const stageRef = useRef(stage);

  // One rotation instance per mounted episode -- a turn_in_progress retry
  // does not remount this component (see GameClient's waitingForAi), so the
  // "no repeat until exhausted" pool naturally spans the whole episode,
  // retries included.
  const rotationRef = useRef<ReturnType<typeof createWaitingMessageRotation> | null>(null);
  if (!rotationRef.current) {
    rotationRef.current = createWaitingMessageRotation();
  }
  const [messagePair, setMessagePair] = useState<WaitingMessagePair>(() =>
    rotationRef.current!.current(stage)
  );

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    setStage(stageForElapsedMs(Date.now() - startedAt));
    const interval = setInterval(() => {
      setStage(stageForElapsedMs(Date.now() - startedAt));
    }, STAGE_TICK_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt]);

  // A stage change shows a fresh message for the NEW stage immediately,
  // rather than waiting out whatever was left of the rotation timer below.
  const priorStageRef = useRef(stage);
  useEffect(() => {
    if (priorStageRef.current !== stage) {
      priorStageRef.current = stage;
      setMessagePair(rotationRef.current!.next(stage));
    }
  }, [stage]);

  useEffect(() => {
    const interval = setInterval(() => {
      setMessagePair(rotationRef.current!.next(stageRef.current));
    }, WAITING_MESSAGE_ROTATION_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="inline-block h-6 w-6 shrink-0 animate-spin rounded-full border-[3px] border-[var(--ink)]/70 motion-reduce:animate-none"
        style={{ borderRightColor: "transparent", animationDuration: `${STAGE_SPIN_SECONDS[stage]}s` }}
      />
      {/* Decorative, visual only -- rotates every few seconds. */}
      <p aria-hidden="true" className="text-sm text-[var(--ink-soft)]">
        {messagePair[language]}
      </p>
      {/* The one thing a screen reader actually announces. Stable: changes
          only at a stage boundary, never on the rotation above. */}
      <span role="status" aria-live="polite" className="sr-only">
        {THINKING_STAGE_COPY[language][stage]}
      </span>
    </div>
  );
}
