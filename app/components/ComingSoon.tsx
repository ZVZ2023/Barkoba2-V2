"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { copy } from "@/lib/ui/copy";

// ---------------------------------------------------------------------------
// The honest treatment for anything that belongs to V2.
//
// A control the design promises must never be a dead button. It stays visible,
// it responds, and it says plainly that the feature is not here yet. The
// message is live HTML over the supplied artwork — not baked into the image —
// so it can be translated and read by a screen reader.
// ---------------------------------------------------------------------------

const ComingSoonContext = createContext<(label?: string) => void>(() => {});

export function useComingSoon() {
  return useContext(ComingSoonContext);
}

export function ComingSoonProvider({ children }: { children: React.ReactNode }) {
  const [label, setLabel] = useState<string | null>(null);
  const open = useCallback((l?: string) => setLabel(l ?? ""), []);
  const close = useCallback(() => setLabel(null), []);

  return (
    <ComingSoonContext.Provider value={open}>
      {children}
      {label !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={copy.comingSoon.title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={close}
        >
          <div
            className="relative w-full max-w-sm overflow-hidden rounded-2xl bg-[#f6ece0] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src="/art/coming-soon.jpg"
              alt=""
              aria-hidden="true"
              className="h-56 w-full object-cover object-top"
            />
            <div className="flex flex-col gap-2 p-5 text-center">
              <h2 className="text-xl font-semibold text-neutral-900">
                {copy.comingSoon.title}
              </h2>
              <p className="text-sm text-neutral-700">
                {label ? `${label} — ${copy.comingSoon.body}` : copy.comingSoon.body}
              </p>
              <button
                onClick={close}
                autoFocus
                className="mt-3 min-h-11 rounded-md bg-[#1e3a24] px-5 py-3 text-sm font-medium text-[#f6ece0]"
              >
                {copy.comingSoon.close}
              </button>
            </div>
          </div>
        </div>
      )}
    </ComingSoonContext.Provider>
  );
}
