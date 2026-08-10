"use client";

/**
 * The gap between pressing start and the game opening.
 *
 * Creating a game is a model call, so there is a real pause with nothing on
 * screen to explain it. A disabled button carrying a changed label is easy to
 * miss on a phone, and a player who misses it presses start again.
 *
 * This replaces the setup form outright while the call is in flight. That is
 * the whole mechanism: with the form unmounted there is no second button to
 * press, so duplicate starts are prevented by there being nothing to click
 * rather than by a guard that has to be remembered. It disappears on its own
 * when the component unmounts on navigation, or when the parent moves to
 * another step. No timer, no engine change, no new state to keep in sync.
 */
export default function ThinkingState({ note }: { note?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center gap-3 rounded-md border border-[var(--green)]/30 bg-[var(--green)]/6 px-4 py-10 text-center"
    >
      <span
        aria-hidden="true"
        className="inline-block h-7 w-7 animate-spin rounded-full border-[3px] border-[var(--green)]/70"
        style={{ borderRightColor: "transparent" }}
      />
      <p className="text-sm font-medium text-[var(--green)]">Az AI gondolkodik…</p>
      {note && <p className="max-w-xs text-xs text-[var(--ink-soft)]">{note}</p>}
    </div>
  );
}
