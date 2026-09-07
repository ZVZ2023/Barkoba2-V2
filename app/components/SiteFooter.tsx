"use client";

import Link from "next/link";
import { copy } from "@/lib/ui/copy";

// The four content pages are real as of 0.9.1.0 and are ordinary links now.
//
// V2.9.1 HU MVP — the social-icon row (Facebook/Instagram/X) that used to
// sit below them is removed, not merely hidden or left as Coming Soon.
// Social destinations still do not exist, and a set of icons implying they
// do is misleading for this Hungarian launch — see app/contact/page.tsx's
// own honest "no public channel exists yet" framing, which this now matches
// instead of contradicting.

export default function SiteFooter({ version }: { version?: string }) {
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
