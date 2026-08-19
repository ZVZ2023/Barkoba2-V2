"use client";

import Link from "next/link";
import { copy } from "@/lib/ui/copy";
import { useComingSoon } from "./ComingSoon";
import { BalanceBadge, CreditGateway, useEntitlement } from "./Entitlement";
import AccountControl from "./AccountControl";

// The language selector remains painted/Coming Soon. AccountControl is the
// minimal real registration/login/logout surface; the TASK 7 layout is kept.

export default function SiteHeader({
  hasEstablishedPlayerIdentity,
  accountAuthenticated,
}: {
  hasEstablishedPlayerIdentity: boolean;
  accountAuthenticated: boolean;
}) {
  const comingSoon = useComingSoon();
  const entitlement = useEntitlement(hasEstablishedPlayerIdentity);

  return (
    <header className="grid w-full grid-cols-1 items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-6 md:grid-cols-[minmax(0,1fr)_minmax(0,auto)_auto] md:py-4">
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

      <div className="flex min-w-0 items-center justify-end gap-2 md:col-start-3 md:row-start-1">
        <button
          onClick={() => comingSoon(copy.header.languageAria ?? "Nyelv")}
          aria-label={copy.header.languageAria}
          className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-md border border-neutral-900/20 px-2.5 py-2 text-sm text-neutral-800 sm:min-h-11 sm:px-3"
        >
          <span aria-hidden="true">🌐</span>
          <span className="font-medium">{copy.header.language}</span>
          <span aria-hidden="true" className="text-xs opacity-60">▾</span>
        </button>

        <AccountControl authenticated={accountAuthenticated} />
      </div>

      {hasEstablishedPlayerIdentity && (
        <div className="flex min-w-0 max-w-full flex-col items-end gap-2 text-right [&>div]:max-w-full [&>div]:flex-wrap [&>div]:justify-end md:col-start-2 md:row-start-1 md:max-w-sm">
          <BalanceBadge view={entitlement.view} />
          {entitlement.view?.play_state === "exhausted" && (
            <CreditGateway />
          )}
        </div>
      )}
    </header>
  );
}
