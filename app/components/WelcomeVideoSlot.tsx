/**
 * V2.7.0 human-test fix — the natural slot for a future ~30-second welcome
 * video (what Barkóba is, the gondolkodó/kérdező idea, one play tip, a light
 * nod to competitions/history). No asset exists yet: per the task that added
 * this, the architecture correction must not be blocked on producing one, so
 * this renders an unobtrusive placeholder rather than nothing or a broken
 * player. Swap the contents for a real <video>/embed when the asset exists;
 * nothing else on the pending-verification screen depends on this file's
 * internals.
 */
export default function WelcomeVideoSlot() {
  return (
    <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-[var(--ink)]/20 bg-[var(--ink)]/5 text-xs text-[var(--ink-soft)]">
      Bemutató videó hamarosan
    </div>
  );
}
