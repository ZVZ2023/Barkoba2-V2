"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { computeRevealScrollTop, shouldRevealResult } from "@/lib/resultReveal";
import type { GamePhase } from "@/lib/types";

// ---------------------------------------------------------------------------
// V2.8.7.3 — ONE shared reveal mechanism for every player-facing game screen
// (GameClient.tsx, RacerClient.tsx, HumanClient.tsx), so mobile reveal
// behavior cannot diverge again the way it already had: V2.8.7.2 shipped
// this only on GameClient.tsx, and RacerClient.tsx/HumanClient.tsx never
// gained it — a real field gap ("the player is already scrolled deep into a
// long game"), not a future nice-to-have. All three screens now call this
// ONE hook instead of three independent (and divergeable) copies.
//
// WHY THIS SHAPE (focus -> two animation frames -> fresh measurement ->
// authoritative scroll): the V2.8.7.2 version called window.scrollTo(...)
// THEN heading.focus({ preventScroll: true }), trusting preventScroll to
// keep focus from moving anything. iOS Safari does not reliably honor
// preventScroll — focus() can still jump-scroll the target into view using
// its own "minimal scroll" algorithm, which aligns the element's TOP with
// the viewport's BOTTOM edge (exactly the field symptom: "only the
// beginning of the result card appeared near the bottom"). That native jump
// runs synchronously inside focus() and, landing after an in-flight smooth
// scroll, cancels it — no ordering of the original two calls could have
// prevented this, since focus() was always the second, overriding call.
//
// Fix: call focus() FIRST and let the browser do whatever native scrolling
// it insists on. Wait two animation frames for that jump (and any layout it
// triggers) to fully settle, then measure geometry FRESH and issue this
// hook's OWN precise scroll — as the LAST scroll action taken, it always
// wins, regardless of whether preventScroll was honored or which browser
// this runs on. The double rAF is the standard, simplest reliable way to
// wait for a browser's own post-focus layout/scroll to settle before
// measuring.
// ---------------------------------------------------------------------------

export interface ResultRevealHandles {
  /** Attach to this screen's own <header>. Measured for scroll offset only. */
  headerRef: RefObject<HTMLElement>;
  /**
   * Attach to the result heading (an <h2>, so it reads as a heading to
   * assistive tech). Becomes a valid PROGRAMMATIC focus target — this hook
   * is the only thing that ever focuses it; it is never in the Tab order.
   */
  headingRef: RefObject<HTMLHeadingElement>;
}

/**
 * Fires exactly once per genuine transition INTO "complete" (see
 * lib/resultReveal.ts's shouldRevealResult) — covers every terminal outcome
 * equally (a correct guess, an incorrect guess, a concession, and an
 * adjudicated verdict all collapse to phase becoming "complete"), never on
 * an unrelated re-render while already complete, and never before
 * resolution, so ordinary scrolling during play is untouched.
 */
export function useResultReveal(phase: GamePhase): ResultRevealHandles {
  const headerRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPhaseRef = useRef(phase);

  useEffect(() => {
    const reveal = shouldRevealResult({ previousPhase: previousPhaseRef.current, phase });
    previousPhaseRef.current = phase;
    if (!reveal) return;
    const heading = headingRef.current;
    if (!heading) return;

    heading.focus({ preventScroll: true });

    let outerFrame = 0;
    let innerFrame = 0;
    outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0;
        const targetTop = computeRevealScrollTop({
          targetTop: heading.getBoundingClientRect().top,
          currentScrollY: window.scrollY,
          headerHeight,
        });
        window.scrollTo({ top: targetTop, behavior: "smooth" });
      });
    });

    // A phase change before the frames fire, or this screen unmounting
    // (navigating to a new game, "Új játék"), must not let a stale callback
    // measure or scroll against a screen that has moved on.
    return () => {
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame);
    };
  }, [phase]);

  return { headerRef, headingRef };
}
