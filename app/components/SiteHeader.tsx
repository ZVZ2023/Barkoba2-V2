"use client";

import Link from "next/link";
import { copy } from "@/lib/ui/copy";
import { BalanceBadge, CreditGateway, useEntitlement } from "./Entitlement";
import AccountControl from "./AccountControl";

// V2.9.1 HU MVP — the language selector used to sit here as a painted/Coming
// Soon placeholder ("🌐 HU ▾"). This is a Hungarian-only launch: a control
// that visually implies another language is one tap away, when none exists,
// is misleading rather than merely unfinished — removed rather than left
// disabled. AccountControl remains the real registration/login/logout
// surface.

export default function SiteHeader({
  hasEstablishedPlayerIdentity,
  accountAuthenticated,
  photoUrl = null,
}: {
  hasEstablishedPlayerIdentity: boolean;
  accountAuthenticated: boolean;
  /** V2.8.4.3 — threaded from PlayerAwareSiteHeader's server-side resolution. */
  photoUrl?: string | null;
}) {
  const entitlement = useEntitlement(
    hasEstablishedPlayerIdentity,
    accountAuthenticated ? "account" : "guest"
  );

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
        <AccountControl authenticated={accountAuthenticated} photoUrl={photoUrl} />
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
