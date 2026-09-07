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
  const lang = gameLanguage === "en" ? "en" : "hu";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 self-start text-xs text-[var(--ink-soft)] underline-offset-2 hover:underline"
      >
        {lang === "en" ? "Send feedback" : "Visszajelzés küldése"}
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-[var(--ink)]/15 bg-white/50 p-3">
      <FeedbackForm lang={lang} gameId={gameId} compact />
    </div>
  );
}
