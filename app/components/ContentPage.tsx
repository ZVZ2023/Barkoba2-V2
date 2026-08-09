import Link from "next/link";
import SiteHeader from "./SiteHeader";
import SiteFooter from "./SiteFooter";

// ---------------------------------------------------------------------------
// Shell for long-form pages.
//
// Deliberately NOT the illustrated front-page composition. The artwork is a
// stage for a landing screen; behind three paragraphs of privacy text it is
// noise competing with the words. These pages take the palette — parchment,
// dark green, restrained red — and nothing else. Readability first.
//
// No artwork means no coordinate positioning and nothing to misalign, which is
// also why these pages are the safest thing in Milestone 3.
// ---------------------------------------------------------------------------

export default function ContentPage({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen w-full flex-col bg-[#f6ece0] text-neutral-900">
      <SiteHeader />

      <main className="w-full flex-1 px-4 py-6 sm:px-6 sm:py-10">
        <article className="mx-auto w-full max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          {lead && (
            <p className="mt-3 text-base leading-relaxed text-neutral-700">{lead}</p>
          )}
          <div className="mt-8 flex flex-col gap-8">{children}</div>

          <Link
            href="/"
            className="mt-10 inline-flex min-h-11 items-center rounded-lg border border-neutral-900/25 px-5 py-3 text-sm font-medium text-neutral-800"
          >
            ← Vissza a főoldalra
          </Link>
        </article>
      </main>

      <SiteFooter />
    </div>
  );
}

/** A titled block. Keeps every content page structurally identical. */
export function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <h2 className="text-xl font-semibold tracking-tight text-[#1e3a24]">{heading}</h2>
      <div className="mt-2 flex flex-col gap-2 text-[15px] leading-relaxed text-neutral-800">
        {children}
      </div>
    </section>
  );
}

export function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5">
      {items.map((t) => (
        <li key={t} className="min-w-0">
          {t}
        </li>
      ))}
    </ul>
  );
}
