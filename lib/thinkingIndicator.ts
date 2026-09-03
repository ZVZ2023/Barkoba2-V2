import type { GameLanguage } from "./types";

// ---------------------------------------------------------------------------
// V2.8.4.1 — three-stage AI-activity indicator: elapsed-time -> stage, and
// stage -> status copy. Pure, no React, no timers, no DOM — the same reason
// lib/turnRecovery.ts and lib/turnRequestGuard.ts are pure: this project has
// no jsdom/testing-library dependency, so the actual decision logic (which
// stage a given elapsed duration is in, and what it says) is extracted here
// where it can be exercised directly with synthetic elapsed values in place
// of real timers. app/components/ThinkingIndicator.tsx calls this SAME
// function against a real Date.now()/setInterval; test/thinkingIndicator.test.ts
// drives it with fixed millisecond inputs standing in for fake timers.
//
// TRUTHFULNESS BY CONSTRUCTION: this module has no concept of "done" or
// "failed" — it only ever answers "given this many elapsed milliseconds,
// which stage and which words." Starting and stopping the clock is entirely
// the caller's job (mount/render only while genuinely waiting; stop
// rendering the instant canonical progress, success, or failure arrives), so
// there is no separate "is it still going" state here to drift out of sync.
// ---------------------------------------------------------------------------

export type ThinkingStage = "eager" | "focused" | "deep";

/** Stage boundaries in milliseconds. Stage 3 has no upper bound -- it holds
 * until the caller stops rendering the indicator (success, timeout, or
 * failure), never on a fixed clock of its own. */
export const THINKING_STAGE_BOUNDARIES_MS: { readonly focused: number; readonly deep: number } = {
  focused: 20_000,
  deep: 40_000,
};

export function stageForElapsedMs(elapsedMs: number): ThinkingStage {
  if (elapsedMs >= THINKING_STAGE_BOUNDARIES_MS.deep) return "deep";
  if (elapsedMs >= THINKING_STAGE_BOUNDARIES_MS.focused) return "focused";
  return "eager";
}

/**
 * Visible status copy per stage. The shell this ships in today (see
 * app/game/[id]/GameClient.tsx) is unconditionally Hungarian regardless of
 * game_language -- the same "shell language is not game language" rule the
 * V2.8.4 language-gate correction established -- so only "hu" is actually
 * wired up today. "en" exists so the component is not shell-locked if an
 * English shell is ever built, and so both languages are exercised by tests.
 */
export const THINKING_STAGE_COPY: Record<GameLanguage, Record<ThinkingStage, string>> = {
  en: {
    eager: "Barkóba AI is thinking…",
    focused: "This one needs a closer look…",
    deep: "Still working—your game is safe.",
  },
  hu: {
    eager: "Barkóba AI gondolkodik…",
    focused: "Ez most alaposabb átgondolást igényel…",
    deep: "Még mindig dolgozik — a játékod biztonságban van.",
  },
};

export function thinkingStatusText(language: GameLanguage, elapsedMs: number): string {
  return THINKING_STAGE_COPY[language][stageForElapsedMs(elapsedMs)];
}

// ---------------------------------------------------------------------------
// V2.8.4.2 — EXPANDED WAITING-MESSAGE LIBRARY.
//
// THINKING_STAGE_COPY above is untouched and remains the STABLE screen-reader
// status (see app/components/ThinkingIndicator.tsx: it is what the aria-live
// region announces, and it only ever changes at a stage boundary — at most
// twice over a whole wait). Everything below is a SEPARATE, purely decorative
// rotation of playful copy, shown visually but never placed in the aria-live
// region, so it can rotate every few seconds without flooding a screen
// reader. Two different mechanisms for two different audiences, not one
// mechanism doing double duty.
//
// Selection/rotation logic lives here, pure and directly testable, for the
// same reason stageForElapsedMs does: no rendering harness exists in this
// project to exercise it inside a component.
// ---------------------------------------------------------------------------

export interface WaitingMessagePair {
  en: string;
  hu: string;
}

/**
 * At least 8 pairs per stage. None claim progress, a percentage, a
 * guaranteed time, secret knowledge, or anything about the target — the
 * secret is never revealed here, and "did you know" trivia about it is
 * deliberately excluded even in the abstract, since it could tip off the
 * Setter watching the same screen. Playful and lightly self-aware; never
 * insulting or anxiety-producing.
 */
export const WAITING_MESSAGES: Record<ThinkingStage, readonly WaitingMessagePair[]> = {
  eager: [
    { en: "Barkóba AI is thinking…", hu: "Barkóba AI gondolkodik…" },
    { en: "Spinning up the little grey cells…", hu: "Pörgeti a szürkeállományt…" },
    { en: "Warming up the guessing engine…", hu: "Bemelegíti a találgatómotort…" },
    { en: "On the case!", hu: "Már dolgozik az ügyön!" },
    { en: "Chasing the first lead…", hu: "Az első nyomot követi…" },
    { en: "Feeling good about this one…", hu: "Bizakodó ezzel kapcsolatban…" },
    { en: "Lacing up the thinking boots…", hu: "Felhúzza a gondolkodócipőt…" },
    { en: "Sharpening the next question…", hu: "Élesíti a következő kérdést…" },
    { en: "Off to a confident start…", hu: "Magabiztos nekifutás…" },
  ],
  focused: [
    { en: "This one needs a closer look…", hu: "Ez most alaposabb átgondolást igényel…" },
    { en: "Hmm, narrowing things down…", hu: "Hm, szűkíti a kört…" },
    { en: "Weighing a couple of options…", hu: "Mérlegel néhány lehetőséget…" },
    { en: "Double-checking a hunch…", hu: "Ellenőriz egy megérzést…" },
    { en: "This one is keeping its secrets…", hu: "Ez jól őrzi a titkait…" },
    { en: "Taking its time to be careful…", hu: "Inkább alaposan, mint gyorsan…" },
    { en: "Reconsidering the last clue…", hu: "Újragondolja az utolsó nyomot…" },
    { en: "A trickier puzzle than it looked…", hu: "Trükkösebb, mint elsőre tűnt…" },
    { en: "Circling back on an idea…", hu: "Visszatér egy ötlethez…" },
  ],
  deep: [
    { en: "Still working—your game is safe.", hu: "Még mindig dolgozik — a játékod biztonságban van." },
    { en: "Deep in thought—no rush needed.", hu: "Mély gondolkodásban — nincs miért sietned." },
    { en: "Taking the scenic route to an answer.", hu: "Kacskaringós úton jár a válasz felé." },
    { en: "Really committing to this one.", hu: "Igazán elköteleződött emellett a kérdés mellett." },
    { en: "Still here, still thinking.", hu: "Még mindig itt van, még mindig gondolkodik." },
    { en: "This is a genuine head-scratcher.", hu: "Ez tényleg fejtörő." },
    { en: "Patience is a virtue—so is this wait.", hu: "A türelem rózsát terem — ez a várakozás is." },
    { en: "Slow and steady, no shortcuts.", hu: "Lassan, de biztosan, kertelés nélkül." },
    { en: "Nothing lost—just taking longer than usual.", hu: "Semmi nem veszett el — csak a szokásosnál tovább tart." },
  ],
};

/** Injectable so tests can drive selection deterministically. Defaults to Math.random. */
export type RandomFn = () => number;

/**
 * Fisher-Yates. Pure: returns a NEW array, never mutates `items`.
 */
export function shuffle<T>(items: readonly T[], random: RandomFn = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const temp = result[i]!;
    result[i] = result[j]!;
    result[j] = temp;
  }
  return result;
}

export interface WaitingMessageRotation {
  /** The message currently showing for this stage -- does not advance on its own. */
  current(stage: ThinkingStage): WaitingMessagePair;
  /** Advance to a new message for this stage. Never repeats one already shown
   * (for this stage, this episode) until every message in that stage's pool
   * has been shown once, at which point it reshuffles a fresh cycle. */
  next(stage: ThinkingStage): WaitingMessagePair;
}

/**
 * One rotation, scoped to a single waiting episode. A caller creates exactly
 * one of these per episode (see ThinkingIndicator's own startedAt-keyed
 * lifetime) and calls `next()` on a timer; `current()` is for reading the
 * active message without advancing it (e.g. on first render).
 */
export function createWaitingMessageRotation(random: RandomFn = Math.random): WaitingMessageRotation {
  const queues: Record<ThinkingStage, WaitingMessagePair[]> = { eager: [], focused: [], deep: [] };
  const shown: Record<ThinkingStage, WaitingMessagePair | null> = { eager: null, focused: null, deep: null };

  function draw(stage: ThinkingStage): WaitingMessagePair {
    if (queues[stage].length === 0) {
      queues[stage] = shuffle(WAITING_MESSAGES[stage], random);
    }
    const picked = queues[stage].shift()!;
    shown[stage] = picked;
    return picked;
  }

  return {
    current(stage) {
      return shown[stage] ?? draw(stage);
    },
    next(stage) {
      return draw(stage);
    },
  };
}

/** How often the decorative message rotates. Calm and readable, not chatty. */
export const WAITING_MESSAGE_ROTATION_MS = 4500;
