import Link from "next/link";
import { copy } from "@/lib/ui/copy";
import PlayerAwareSiteHeader from "./PlayerAwareSiteHeader";
import SiteFooter from "./SiteFooter";
import WelcomeVideoSlot from "./WelcomeVideoSlot";

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
            {/* The hero title AND the four play-relationship rows
                (Ember vs Ember / Ember vs AI / AI vs Ember / AI vs AI) are
                already painted into the background artwork itself
                (public/art/stage-portrait.jpg etc.) — no live HTML text for
                either here, so neither is ever rendered twice. */}
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

          {/*
            V2.9.1 HU MVP ONBOARDING — a newcomer landing on "/" had no brief
            explanation of the two roles, the current beta status, the free
            trial game, the 5-credit registration bonus, or that a paid
            engine tier exists — all of it lived behind /rules, /purchase, or
            a finished game, never here. Copy reused verbatim from its
            existing approved sources rather than invented: role titles/
            details from `copy.modes` (already used on /play), the beta
            framing from app/beta/BetaClient.tsx's own live copy, and the
            premium price from app/ComposerEntry.tsx's PREMIUM_PRICE_COPY —
            same string, not a second one that could drift from it.
            WelcomeVideoSlot is reused here specifically so the video is
            reachable BEFORE registration; its two other placements
            (PurchaseClient, ClaimPrompt) are both post-registration gates.
          */}
          <section
            aria-label="Mielőtt elkezded"
            className="flex flex-col gap-6 rounded-2xl border border-white/60 bg-white/70 p-4 shadow-sm backdrop-blur-sm sm:p-6 lg:flex-row lg:items-start"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">Mielőtt elkezded</h2>
                <p className="mt-1 text-sm leading-relaxed text-neutral-700">
                  A Barkóba jelenleg mindenki számára béta állapotban elérhető,
                  magyar nyelven.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <p className="font-semibold leading-snug">
                    {copy.modes.humanComposer.title}{" "}
                    <span className="font-normal text-neutral-600">
                      {copy.modes.humanComposer.subtitle}
                    </span>
                  </p>
                  <p className="text-sm leading-snug text-neutral-700">
                    {copy.modes.humanComposer.detail}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="font-semibold leading-snug">
                    {copy.modes.aiComposer.title}{" "}
                    <span className="font-normal text-neutral-600">
                      {copy.modes.aiComposer.subtitle}
                    </span>
                  </p>
                  <p className="text-sm leading-snug text-neutral-700">
                    {copy.modes.aiComposer.detail}
                  </p>
                </div>
              </div>

              <p className="text-sm leading-relaxed text-neutral-700">
                Az első játék ingyenes próbajáték. Regisztrációval — egy név és
                egy megerősített e-mail-cím megadásával — 5 további VERSENYT
                kapsz.
              </p>

              <p className="text-sm leading-relaxed text-neutral-700">
                A kérdező AI alapértelmezetten az ingyenes „Érvelő AI” motort
                használja. Megvásárolt VERSENY-egyenlegből a prémium „Emberi
                szintű AI” motorra is válthatsz — 2 gombóc, jelenleg kb. 4,20
                USD / játék.
              </p>
            </div>

            <div className="shrink-0 self-center lg:self-start">
              <WelcomeVideoSlot />
            </div>
          </section>
        </div>
      </main>

      <SiteFooter version={version} />
    </div>
  );
}
