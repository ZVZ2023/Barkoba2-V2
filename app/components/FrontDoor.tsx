import Link from "next/link";
import { copy } from "@/lib/ui/copy";
import PlayerAwareSiteHeader from "./PlayerAwareSiteHeader";
import SiteFooter from "./SiteFooter";

// ---------------------------------------------------------------------------
// The front door: real HTML over the artwork stage.
//
// LAYOUT DECISION, stated because it is a compromise: the mockup composes
// against specific painted features — buttons beside the ensō, the feature bar
// across the Danube. Reproducing that would need absolute positioning tied to
// image coordinates, which breaks the moment the viewport ratio moves off the
// asset's. So the interface flows normally in a left-weighted column that sits
// over the artwork's calm side, and the art reads as a stage rather than a
// background the text is pinned to.
//
// The parts of the composition that survive every viewport: content weighted
// left where the art is quiet, the busy right side (Parliament, flowers) left
// clear, and the ornamental strip along the bottom never overlapped by text.
// ---------------------------------------------------------------------------

const FEATURE_MARKS = ["◯", "🔒", "◌", "🛡", "▮", "🏆"];
const STEP_MARKS = ["1", "2", "3", "4"];

export default function FrontDoor({ version }: { version?: string }) {
  return (
    <div className="flex min-h-screen w-full flex-col text-neutral-900">
      <PlayerAwareSiteHeader />

      <main className="w-full flex-1 px-4 sm:px-6">
        <div className="mx-auto w-full max-w-5xl">
          {/* HERO */}
          <section className="flex flex-col gap-5 py-8 sm:py-12 lg:max-w-xl">
            <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
              {copy.hero.headline.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </h1>

            <p className="text-base leading-relaxed text-neutral-700">
              {copy.hero.support.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </p>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Link
                href="/play"
                className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-[#1e3a24] px-6 py-3 text-base font-medium text-[#f6ece0] shadow-sm"
              >
                <span aria-hidden="true">✦</span>
                {copy.hero.primary}
              </Link>
              <a
                href="#hogyan-mukodik"
                className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-neutral-900/30 bg-[#f6ece0]/70 px-6 py-3 text-base font-medium text-neutral-900"
              >
                <span aria-hidden="true">📖</span>
                {copy.hero.secondary}
              </a>
            </div>
          </section>

          {/* FEATURE PANEL */}
          <section
            aria-label="Jellemzők"
            className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-sm backdrop-blur-sm sm:p-6"
          >
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {copy.features.map((f, i) => (
                <li key={f.title} className="flex min-w-0 items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f6ece0] text-lg"
                  >
                    {FEATURE_MARKS[i]}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold leading-snug">{f.title}</p>
                    {f.lines.map((l) => (
                      <span key={l} className="block text-sm leading-snug text-neutral-700">
                        {l}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* HOW IT WORKS */}
          <section id="hogyan-mukodik" className="scroll-mt-4 py-8 sm:py-12">
            <h2 className="text-2xl font-semibold tracking-tight">{copy.howItWorks.title}</h2>
            <ol className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {copy.howItWorks.steps.map((s, i) => (
                <li key={s.title} className="flex min-w-0 gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1e3a24] text-sm font-semibold text-[#f6ece0]"
                  >
                    {STEP_MARKS[i]}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold leading-snug">{s.title}</p>
                    {s.lines.map((l) => (
                      <span key={l} className="block text-sm leading-snug text-neutral-700">
                        {l}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </main>

      <SiteFooter version={version} />
    </div>
  );
}
