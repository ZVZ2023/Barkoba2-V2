"use client";

import { useEffect, useState } from "react";
import { stageForElapsedMs, THINKING_STAGE_COPY, type ThinkingStage } from "@/lib/thinkingIndicator";
import type { GameLanguage } from "@/lib/types";

// ---------------------------------------------------------------------------
// V2.8.4.1 — the three-stage AI-activity indicator.
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
// does not reset the stage clock back to "eager".
// ---------------------------------------------------------------------------

const TICK_MS = 1000;

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

  useEffect(() => {
    setStage(stageForElapsedMs(Date.now() - startedAt));
    const interval = setInterval(() => {
      setStage(stageForElapsedMs(Date.now() - startedAt));
    }, TICK_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt]);

  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="inline-block h-6 w-6 shrink-0 animate-spin rounded-full border-[3px] border-[var(--ink)]/70 motion-reduce:animate-none"
        style={{ borderRightColor: "transparent", animationDuration: `${STAGE_SPIN_SECONDS[stage]}s` }}
      />
      <p className="text-sm text-[var(--ink-soft)]">{THINKING_STAGE_COPY[language][stage]}</p>
    </div>
  );
}
