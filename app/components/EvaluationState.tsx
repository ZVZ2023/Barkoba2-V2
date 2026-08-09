"use client";

// ---------------------------------------------------------------------------
// The dominant evaluation state, shared by both game modes.
//
// It replaced a line of small grey text that a first-time player could easily
// read as "the game is over" — and then navigate away mid-adjudication.
//
// The failure case is the same component, not a different one. A player whose
// network dropped is in the same place in the game as one who is simply
// waiting; only the message and the affordance change. Building it once means
// the recovery path cannot be styled into invisibility separately from the
// happy path — which is exactly how the last retry button was lost.
// ---------------------------------------------------------------------------

export default function EvaluationState({
  error,
  busy,
  onRetry,
}: {
  error: string | null;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--parchment)]/95 p-6 backdrop-blur-sm">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <span
          aria-hidden="true"
          className={`inline-block h-20 w-20 rounded-full border-[6px] border-[var(--ink)]/85 ${
            error ? "" : "animate-spin"
          }`}
          style={{ borderRightColor: "transparent", animationDuration: "2.4s" }}
        />

        {error ? (
          <>
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-[var(--ink)]">
                Az értékelés megszakadt.
              </h2>
              <p className="mt-2 text-base text-[var(--ink)]">A játékod megmaradt.</p>
              <p className="mt-1 text-sm text-[var(--ink-soft)]">{error}</p>
            </div>
            <button
              onClick={onRetry}
              disabled={busy}
              className="min-h-12 w-full rounded-lg bg-[var(--green)] px-6 py-3 text-lg font-semibold text-[var(--parchment)] shadow-sm disabled:opacity-40"
            >
              {busy ? "ÚJRAPRÓBÁLKOZÁS…" : "ÚJRA"}
            </button>
            <p className="text-xs text-[var(--ink-soft)]">
              Semmit nem kell újrajátszanod. A kérdéseid, a válaszaid és a tipp
              megmaradtak — csak az értékelés indul újra.
            </p>
          </>
        ) : (
          <>
            <h2
              className="text-2xl font-semibold leading-tight tracking-tight text-[var(--ink)]"
              aria-live="polite"
            >
              ÉRTÉKELÉS
              <br />
              FOLYAMATBAN…
            </h2>
            <p className="text-sm text-[var(--ink-soft)]">
              Az eredmény még nem áll készen. Nincs teendőd — maradj ezen az oldalon.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
