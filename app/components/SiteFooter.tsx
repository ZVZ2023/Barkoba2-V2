"use client";

import Link from "next/link";
import { copy } from "@/lib/ui/copy";
import { useComingSoon } from "./ComingSoon";

// The four content pages are real as of 0.9.1.0 and are ordinary links now.
// Social destinations still do not exist, so those keep the Coming Soon
// treatment rather than pointing at invented accounts.

export default function SiteFooter({ version }: { version?: string }) {
  const comingSoon = useComingSoon();

  const link = (href: string, label: string) => (
    <Link
      key={href}
      href={href}
      className="min-h-11 text-sm text-neutral-700 underline-offset-2 hover:underline"
    >
      {label}
    </Link>
  );

  return (
    <footer className="mt-auto w-full border-t border-neutral-900/10 bg-[#f6ece0]/70 px-4 py-6 sm:px-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <div className="min-w-0">
          <p className="text-base font-semibold text-neutral-900">{copy.brand.name}</p>
          <p className="text-sm text-neutral-700">{copy.footer.tagline}</p>
        </div>

        <nav className="flex flex-wrap items-center gap-x-5 gap-y-1">
          {link("/rules", copy.footer.rules)}
          {link("/privacy", copy.footer.privacy)}
          {link("/about", copy.footer.about)}
          {link("/contact", copy.footer.contact)}
        </nav>

        <div className="flex items-center gap-3">
          <span className="text-sm text-neutral-600">{copy.footer.social}</span>
          {["Facebook", "Instagram", "X"].map((n) => (
            <button
              key={n}
              onClick={() => comingSoon(n)}
              aria-label={n}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-neutral-900/20 text-sm text-neutral-700"
            >
              {n[0]}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/compose" className="text-xs text-neutral-500 underline underline-offset-2">
            {copy.modes.humanComposer.title}
          </Link>
          {/*
            0.9.7.0: this prop was accepted and never rendered. The version
            string still appeared in the page source — Next serializes client
            component props into the RSC payload — so a grep of the HTML said
            "present" while nothing was ever painted. Render it, and test what
            is paintable rather than what is in the file.
          */}
          {version && (
            <span
              className="text-xs tabular-nums text-neutral-600"
              title="Telepített Barkóba verzió"
            >
              {version}
            </span>
          )}
        </div>
      </div>
    </footer>
  );
}
