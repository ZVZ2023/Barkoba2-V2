import RecoverPrompt from "../components/RecoverPrompt";
import type { Metadata } from "next";
import Link from "next/link";
import Stage from "../components/Stage";
import SiteHeader from "../components/SiteHeader";
import { copy } from "@/lib/ui/copy";
import { formatVersionLabel, getAppVersion } from "@/lib/appVersion";

// The one new screen between the front door and the two proven modes.
// Nothing here touches the engine — both cards are links to entry points that
// already exist and already work.

export const metadata: Metadata = { title: "Barkóba — Új játék" };

export default function PlayPage() {
  return (
    <>
      <Stage />
      <div className="flex min-h-screen w-full flex-col text-neutral-900">
        <SiteHeader />
        <main className="w-full flex-1 px-4 py-6 sm:px-6">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{copy.modes.title}</h1>
              <p className="mt-1 text-sm text-neutral-700">{copy.modes.subtitle}</p>
            </div>

            <Link
              href="/compose"
              className="flex min-w-0 flex-col gap-1 rounded-xl border border-white/60 bg-white/75 p-5 shadow-sm backdrop-blur-sm"
            >
              <span className="text-lg font-semibold">{copy.modes.humanComposer.title}</span>
              <span className="text-base text-neutral-800">{copy.modes.humanComposer.subtitle}</span>
              <span className="text-sm text-neutral-600">{copy.modes.humanComposer.detail}</span>
            </Link>

            <Link
              href="/play/ai"
              className="flex min-w-0 flex-col gap-1 rounded-xl border border-white/60 bg-white/75 p-5 shadow-sm backdrop-blur-sm"
            >
              <span className="text-lg font-semibold">{copy.modes.aiComposer.title}</span>
              <span className="text-base text-neutral-800">{copy.modes.aiComposer.subtitle}</span>
              <span className="text-sm text-neutral-600">{copy.modes.aiComposer.detail}</span>
            </Link>

            {/* V2.3 — the first Human↔Human mode. */}
            <Link
              href="/play/human"
              className="flex min-w-0 flex-col gap-1 rounded-xl border border-white/60 bg-white/75 p-5 shadow-sm backdrop-blur-sm"
            >
              <span className="text-lg font-semibold">Játék egy másik emberrel</span>
              <span className="text-base text-neutral-800">→ te gondolsz, ő kérdez</span>
              <span className="text-sm text-neutral-600">
                Te zárod le a titkot, és küldesz egy meghívó linket.
              </span>
            </Link>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link href="/" className="min-h-11 text-sm text-neutral-600 underline underline-offset-2">
                {copy.modes.back}
              </Link>
              <span className="text-xs text-neutral-600" title="Telepített Barkóba verzió">
                {formatVersionLabel(getAppVersion())}
              </span>
            </div>

            {/*
              Returning-player recovery. Must stay INSIDE the max-w-2xl column:
              as a bare child of <main> it escaped the centred content area and
              rendered clipped against the left viewport edge, which made the
              only route back to a protected Player effectively invisible.
            */}
            <div className="min-w-0 border-t border-neutral-900/10 pt-4">
              <RecoverPrompt />
            </div>
          </div>
      </main>
      </div>
    </>
  );
}
