"use client";

import Link from "next/link";
import { copy } from "@/lib/ui/copy";
import { useComingSoon } from "./ComingSoon";

// Real controls, not painted ones. The language selector and Login are visible
// because the design promises them and because removing them would mean
// redesigning this header the moment V2 lands — but both route to the honest
// Coming Soon treatment rather than pretending to work.

export default function SiteHeader() {
  const comingSoon = useComingSoon();

  return (
    <header className="flex w-full items-center justify-between gap-3 px-4 py-4 sm:px-6">
      <Link href="/" className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-7 w-7 shrink-0 rounded-full border-[3px] border-neutral-900/85"
          style={{ borderRightColor: "transparent" }}
        />
        <span className="truncate text-lg font-semibold tracking-tight text-neutral-900">
          {copy.brand.name}
        </span>
      </Link>

      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => comingSoon(copy.header.languageAria ?? "Nyelv")}
          aria-label={copy.header.languageAria}
          className="flex min-h-11 items-center gap-1.5 rounded-md border border-neutral-900/20 px-3 py-2 text-sm text-neutral-800"
        >
          <span aria-hidden="true">🌐</span>
          <span className="font-medium">{copy.header.language}</span>
          <span aria-hidden="true" className="text-xs opacity-60">▾</span>
        </button>

        <button
          onClick={() => comingSoon(copy.header.login)}
          className="flex min-h-11 items-center gap-2 rounded-md border border-neutral-900/20 px-3 py-2 text-sm text-neutral-800"
        >
          <span aria-hidden="true">👤</span>
          <span className="hidden sm:inline">{copy.header.login}</span>
        </button>
      </div>
    </header>
  );
}
