"use client";

import { useRef, useState } from "react";

// ---------------------------------------------------------------------------
// V2.9.1 — the one player-facing feedback form, shared by the standalone
// /feedback page (app/feedback/FeedbackPageClient.tsx) and the discreet
// per-game action on completed-game screens (FeedbackAction.tsx below).
//
// SENDS EXACTLY THREE FIELDS: message, lang, and (when provided) game_id.
// No target, guess, transcript, player identity, provider/model name, or
// any other game content is ever read or attached here — this component
// has no access to any of that in the first place, by construction: its
// only props are `lang` and an opaque `gameId` string.
//
// game_id ITSELF IS NEVER RENDERED. It travels straight from the `gameId`
// prop into the POST body; no JSX in this file ever displays it.
//
// FEEDBACK_MESSAGE_MAX_LENGTH is duplicated from lib/feedback.ts rather
// than imported — that module pulls in the corpus database client, and a
// client component must never be the reason server-only code reaches the
// browser bundle. Same reasoning HistoryClient.tsx's own header gives for
// duplicating its shape from lib/corpus/gameCorpus.ts. One integer is
// cheap to keep in sync; the isolation boundary is not cheap to get wrong.
// ---------------------------------------------------------------------------

const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;

const COPY = {
  hu: {
    placeholder: "Mit gondolsz a Barkóbáról?",
    submit: "Küldés",
    submitting: "Küldés…",
    success: "Köszönjük a visszajelzést!",
    sendAnother: "Másik visszajelzés küldése",
    emptyError: "Írj néhány szót, mielőtt elküldöd.",
    tooLongError: `A visszajelzés legfeljebb ${FEEDBACK_MESSAGE_MAX_LENGTH} karakter lehet.`,
    rateLimitError: "Túl sok visszajelzés érkezett. Próbáld újra egy kicsit később.",
    networkError: "Hálózati hiba — ellenőrizd a kapcsolatot, és próbáld újra.",
    unavailableError: "Most nem sikerült elküldeni a visszajelzést. Próbáld újra hamarosan.",
  },
  en: {
    placeholder: "What do you think about Barkóba?",
    submit: "Submit",
    submitting: "Submitting…",
    success: "Thanks for your feedback!",
    sendAnother: "Send another",
    emptyError: "Write a few words before submitting.",
    tooLongError: `Feedback can be at most ${FEEDBACK_MESSAGE_MAX_LENGTH} characters.`,
    rateLimitError: "Too many submissions. Please try again in a little while.",
    networkError: "Network error — check your connection and try again.",
    unavailableError: "Could not send feedback right now. Please try again soon.",
  },
} as const;

type Step =
  | { kind: "editing" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

export default function FeedbackForm({
  lang,
  gameId = null,
  compact = false,
}: {
  lang: "hu" | "en";
  /** Opaque; never rendered — see this file's own header. Omitted entirely for the standalone page. */
  gameId?: string | null;
  /** Tighter spacing for the embedded, discreet per-game placement. */
  compact?: boolean;
}) {
  const [message, setMessage] = useState("");
  const [step, setStep] = useState<Step>({ kind: "editing" });
  // A synchronous guard, checked BEFORE React state updates land — the same
  // reasoning RacerClient.tsx's own resolveInFlightRef doc gives: a rapid
  // double-tap can fire a second click before a state-driven `disabled`
  // attribute has re-rendered. This is the mechanism that actually stops a
  // duplicate submission; the disabled button below is a courtesy on top
  // of it, not the guarantee.
  const submittingRef = useRef(false);

  const t = COPY[lang];

  async function submit() {
    if (submittingRef.current) return;
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      setStep({ kind: "error", message: t.emptyError });
      return;
    }
    if (trimmed.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
      setStep({ kind: "error", message: t.tooLongError });
      return;
    }

    submittingRef.current = true;
    setStep({ kind: "submitting" });
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          lang,
          // Omitted entirely (never sent as null/empty) when there is no
          // game context — the standalone page's own call site simply
          // never passes gameId at all.
          ...(gameId ? { game_id: gameId } : {}),
        }),
      });

      if (res.status === 429) {
        setStep({ kind: "error", message: t.rateLimitError });
        return;
      }
      if (res.status === 400) {
        const data = await res.json().catch(() => ({}) as { error?: string });
        setStep({
          kind: "error",
          message: data.error === "message_too_long" ? t.tooLongError : t.emptyError,
        });
        return;
      }
      if (!res.ok) {
        setStep({ kind: "error", message: t.unavailableError });
        return;
      }

      setMessage("");
      setStep({ kind: "success" });
    } catch {
      setStep({ kind: "error", message: t.networkError });
    } finally {
      submittingRef.current = false;
    }
  }

  if (step.kind === "success") {
    return (
      <div className={compact ? "flex flex-col gap-2" : "flex flex-col gap-3"}>
        <p className="text-sm font-medium text-[var(--green)]">{t.success}</p>
        <button
          type="button"
          onClick={() => setStep({ kind: "editing" })}
          className="self-start text-xs text-[var(--ink-soft)] underline-offset-2 hover:underline"
        >
          {t.sendAnother}
        </button>
      </div>
    );
  }

  const submitting = step.kind === "submitting";

  return (
    <div className={compact ? "flex flex-col gap-2" : "flex flex-col gap-3"}>
      <label className="flex flex-col gap-1 text-sm">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t.placeholder}
          maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
          disabled={submitting}
          className={`w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--green)] ${
            compact ? "h-20" : "h-32"
          }`}
        />
        <span className="self-end text-xs text-[var(--ink-soft)]">
          {message.length} / {FEEDBACK_MESSAGE_MAX_LENGTH}
        </span>
      </label>

      {step.kind === "error" && <p className="text-sm text-[var(--red)]">{step.message}</p>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={submitting || message.trim().length === 0}
        className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
      >
        {submitting ? t.submitting : t.submit}
      </button>
    </div>
  );
}
