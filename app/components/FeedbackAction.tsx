"use client";

import { useState } from "react";
import FeedbackForm from "./FeedbackForm";

// ---------------------------------------------------------------------------
// V2.9.1 — the discreet "Visszajelzés küldése" / "Send feedback" action on a
// completed game's result screen.
//
// COLLAPSED BY DEFAULT, matching "discreet": a single small text link, not a
// prominent button competing with the primary "Új játék" call to action.
//
// gameId IS AN OPAQUE PROP, NEVER RENDERED. This component reads it once
// and hands it straight to FeedbackForm, which itself only ever puts it in
// a POST body — see that file's own header for the full guarantee. No
// target, guess, transcript, player identity, or provider/model data is
// reachable from here at all: this component is never given any of it.
//
// V2.9.1 CORRECTION — added a "Bezárás"/"Close" control inside the expanded
// form (FeedbackForm's own onClose prop). Once the player has opened the
// form at least once (mounted -> true), it stays MOUNTED and is only ever
// toggled with the `hidden` attribute from then on — never unmounted again
// — so FeedbackForm's own `message` state survives a close/reopen cycle
// intact. Before the first open, nothing is mounted at all: no extra DOM,
// no wasted render, matching the pre-correction behavior exactly.
// ---------------------------------------------------------------------------

export default function FeedbackAction({
  gameId,
  gameLanguage,
}: {
  gameId: string;
  /** Selects the button's OWN bilingual label only — matches the established
   * "label stays fixed to a fact about the game, narrative follows
   * game_language" split (see app/ComposerEntry.tsx's V2.8.8.7 doc). */
  gameLanguage: string;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const lang = gameLanguage === "en" ? "en" : "hu";

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => {
            setMounted(true);
            setOpen(true);
          }}
          className="mt-3 self-start text-xs text-[var(--ink-soft)] underline-offset-2 hover:underline"
        >
          {lang === "en" ? "Send feedback" : "Visszajelzés küldése"}
        </button>
      )}
      {mounted && (
        <div hidden={!open} className="mt-3 rounded-md border border-[var(--ink)]/15 bg-white/50 p-3">
          <FeedbackForm lang={lang} gameId={gameId} compact onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
