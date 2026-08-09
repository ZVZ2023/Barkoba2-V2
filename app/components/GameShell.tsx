import Link from "next/link";

// ---------------------------------------------------------------------------
// The Barkóba game table.
//
// Deliberately NOT the illustrated front door. The homepage is an invitation;
// this is the surface a player reads twenty times in a row, and the Budapest
// artwork behind a transcript would be decoration fighting the content.
//
// What carries identity instead: the parchment ground, the ensō mark, the name,
// and the palette. Enough that the player never wonders which product they are
// in, without spending mobile height on it — the header is one compact row.
//
// Every game screen routes through here, which is also how gameplay finally
// gets a consistent way home.
// ---------------------------------------------------------------------------

export default function GameShell({
  role,
  meta,
  version,
  children,
}: {
  /** "Te gondoltál valamire." — who the player is this game. */
  role: string;
  /** Optional right-hand status, e.g. questions remaining. */
  meta?: React.ReactNode;
  /**
   * Supplied by the server page. Deliberately a prop rather than read here:
   * this component is imported by client components, so reading the VERSION
   * file inside it drags node:fs into the browser bundle and fails the build.
   */
  version?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen w-full flex-col bg-[var(--parchment)] text-[var(--ink)]">
      <header className="w-full border-b border-[var(--ink)]/10 bg-[var(--parchment)]/90 px-4 py-3 backdrop-blur-sm sm:px-6">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3">
          <Link href="/" className="flex min-w-0 items-center gap-2" aria-label="Barkóba főoldal">
            <span
              aria-hidden="true"
              className="inline-block h-6 w-6 shrink-0 rounded-full border-[3px] border-[var(--ink)]/80"
              style={{ borderRightColor: "transparent" }}
            />
            <span className="truncate text-base font-semibold tracking-tight">Barkóba</span>
          </Link>
          {meta && <div className="shrink-0 text-right text-xs text-[var(--ink-soft)]">{meta}</div>}
        </div>
        <p className="mx-auto mt-1 w-full max-w-2xl text-xs text-[var(--ink-soft)]">{role}</p>
      </header>

      <main className="w-full flex-1 px-4 py-5 sm:px-6 sm:py-7">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">{children}</div>
      </main>

      <footer className="w-full px-4 pb-6 sm:px-6">
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link
              href="/"
              className="inline-flex min-h-11 items-center text-sm text-[var(--ink-soft)] underline-offset-2 hover:underline"
            >
              ← Vissza a Barkóba főoldalra
            </Link>
            {/*
              Version lives here as well as in the site footer. A tester spends
              the whole session on a game screen, which had no footer at all —
              so "it is in the footer" was true and useless.
            */}
            {version && (
              <span className="text-xs text-[var(--ink-soft)]" title="Telepített Barkóba verzió">
                {version}
              </span>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
