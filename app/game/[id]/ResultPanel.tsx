"use client";

import PostGameRegisterCTA from "@/app/components/PostGameRegisterCTA";
import FeedbackAction from "@/app/components/FeedbackAction";
import type { RefObject } from "react";
import type { GameRecord } from "@/lib/types";

// This component is quarantined from secretStore by scripts/check-isolation.mjs.
// It shows the target by reading game.revealed_target, which the resolve route
// writes at the single declassification point. It has no other route to it.

interface Props {
  game: GameRecord;
  resolving: boolean;
  error: string | null;
  onRetry: () => void;
  /**
   * V2.8.7.2 — GameClient.tsx's auto-reveal effect (lib/resultReveal.ts)
   * focuses and scrolls to THIS heading the instant the game reaches its
   * terminal result. Optional so nothing else that might ever render this
   * component without wiring the reveal behavior is forced to.
   */
  headingRef?: RefObject<HTMLHeadingElement>;
}

// V2.8.4.3 — the "PC" incident: a completed review (verdict "upheld") with an
// empty legacy `integrity_notes` string used to hide this entire section,
// because the old guard was `{game.integrity_notes && (...)}` — truthiness of
// the PROSE, not of whether a review actually ran. A finished review must
// render honestly even with nothing to quote, so the section now keys off
// the explicit `integrity_verdict` field (null only when no review ran at
// all) and falls back to a plain, honest notice instead of vanishing.
function integrityFallbackNotice(gameLanguage: GameRecord["game_language"]): string {
  return gameLanguage === "en"
    ? "The review completed, but no detailed explanation was received."
    : "Az ellenőrzés befejeződött, de részletes indoklás nem érkezett.";
}

const HEADLINE: Record<string, string> = {
  racer_correct: "Az AI eltalálta.",
  racer_incorrect: "Az AI nem talált. Nyertél.",
  composer_win_integrity_upheld: "Az AI feladta. Nyertél.",
  racer_win_integrity_violation: "Az AI-nak ítélve — integritás-ellenőrzés.",
};

// ---------------------------------------------------------------------------
// V2.8.8 COMPLETION — terminal presentation copy, by mode. Wording only: the
// underlying result/won/lost fact these describe is decided entirely
// upstream (the adjudicator), never here. HEADLINE above still serves as
// BOTH the Competitive AND the legacy (no experience_mode) copy, unchanged —
// "concise, neutral presentation" is exactly what it already is, so
// Competitive gets no separate entry.
//
// Teaching also has no separate entry here: this direction's human never
// asks a question (they are the Composer), so the differentiator Teaching
// mode offers them is the AI Racer's own briefly-narrated question style
// (lib/prompts/racer.ts's RACER_MODE_TONE), not a different closing
// headline — see this game's REPORT for the fuller reasoning.
// ---------------------------------------------------------------------------
const HEADLINE_FRIENDLY: Partial<Record<string, string>> = {
  racer_correct: "Az AI eltalálta — szoros volt!",
  racer_incorrect: "Az AI nem talált. Szép játék, nyertél!",
  composer_win_integrity_upheld: "Az AI feladta. Nyertél!",
};
const HEADLINE_HUMOROUS: Partial<Record<string, string>> = {
  racer_correct: "Az AI eltalálta. Ezúttal neki jött be.",
  racer_incorrect: "Az AI üres kézzel távozott. Nyertél!",
  composer_win_integrity_upheld: "Az AI feladta a küzdelmet. Nyertél!",
};

function headlineFor(game: GameRecord): string {
  const key = game.result ?? "";
  if (game.experience_mode === "friendly") return HEADLINE_FRIENDLY[key] ?? HEADLINE[key] ?? "A játék véget ért.";
  if (game.experience_mode === "humorous") return HEADLINE_HUMOROUS[key] ?? HEADLINE[key] ?? "A játék véget ért.";
  return HEADLINE[key] ?? "A játék véget ért.";
}

const SUBHEAD: Record<string, string> = {
  racer_correct: "A kérdéskereten belül megnevezte a titkod.",
  racer_incorrect: "A válaszaid kiállták az ellenőrzést.",
  composer_win_integrity_upheld: "Elfogytak a kérdései és feladta. A válaszaid kiállták az ellenőrzést.",
  racer_win_integrity_violation:
    "Az ellenőrzés legalább egy ellentmondó választ talált.",
};

export default function ResultPanel({ game, resolving, error, onRetry, headingRef }: Props) {
  if (game.phase === "resolving") {
    return (
      <section className="rounded-md border border-[var(--green)]/30 bg-[var(--green)]/6 p-4">
        <p className="text-sm text-[var(--green)]">
          {game.final_action === "concede"
            ? "Az AI feladta."
            : "Az AI tippelt."}
        </p>
        {game.final_guess_text && (
          <p className="mt-1 break-words text-sm text-[var(--ink)]">“{game.final_guess_text}”</p>
        )}

        {error ? (
          <div className="mt-3 flex flex-col items-start gap-2">
            <p className="text-sm text-[var(--red)]">{error}</p>
            <p className="text-xs text-[var(--ink-soft)]">
              A játékod változatlan — még nem dőlt el semmi.
            </p>
            <button
              onClick={onRetry}
              className="min-h-11 rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm text-[var(--ink)]"
            >
              Újra
            </button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-[var(--ink-soft)]">
            {resolving ? "Értékelés folyamatban…" : "Várakozás az értékelésre…"}
          </p>
        )}
      </section>
    );
  }

  if (game.phase !== "complete" || !game.result) return null;

  const racerWon =
    game.result === "racer_correct" || game.result === "racer_win_integrity_violation";

  return (
    <section
      className={
        racerWon
          ? "rounded-md border border-[var(--red)]/30 bg-[var(--red)]/6 p-5"
          : "rounded-md border border-[var(--green)]/30 bg-[var(--green)]/5 p-5"
      }
    >
      {/*
        V2.8.7.2 — tabIndex={-1} makes this a valid PROGRAMMATIC focus target
        (assistive tech announces it, "beneath the fixed header" scroll math
        in lib/resultReveal.ts measures it) without adding it to the Tab
        order — nobody reaches it by pressing Tab, only GameClient.tsx's own
        auto-reveal effect ever focuses it. outline-none suppresses the
        browser's default focus RING specifically because that ring reads as
        an editable-input affordance on a heading that accepts no input; the
        focus move itself (and its screen-reader announcement) still happens
        regardless of any visible ring.
      */}
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold text-[var(--ink)] outline-none"
      >
        {headlineFor(game)}
      </h2>
      <p className="mt-1 text-sm text-[var(--ink-soft)]">{SUBHEAD[game.result] ?? ""}</p>

      <dl className="mt-4 flex flex-col gap-3 border-t border-[var(--ink)]/15 pt-4 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">A te titkod</dt>
          <dd className="mt-0.5 break-words text-[var(--ink)]">{game.revealed_target}</dd>
        </div>

        {game.final_action === "guess" && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">
              Az AI tippje
            </dt>
            <dd className="mt-0.5 break-words text-[var(--ink)]">{game.final_guess_text}</dd>
          </div>
        )}

        <PostGameRegisterCTA />

        <div>
          <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">Felhasznált kérdés</dt>
          <dd className="mt-0.5 text-[var(--ink)]">
            {game.question_count} / {game.max_questions}
            {game.ambiguous_count > 0 && ` · ${game.ambiguous_count} bizonytalan`}
          </dd>
        </div>

        {game.adjudication_notes && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">Értékelés</dt>
            <dd className="mt-0.5 break-words text-[var(--ink)]">{game.adjudication_notes}</dd>
          </div>
        )}

        {game.integrity_verdict !== null && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">
              Integritás-ellenőrzés
            </dt>
            <dd className="mt-0.5 break-words text-[var(--ink)]">
              {game.integrity_notes && game.integrity_notes.trim().length > 0
                ? game.integrity_notes
                : integrityFallbackNotice(game.game_language)}
            </dd>
            {game.integrity_flagged_turns && game.integrity_flagged_turns.length > 0 && (
              <dd className="mt-1 text-xs text-[var(--red)]">
                Ellentmondó körök: {game.integrity_flagged_turns.map((t) => `#${t}`).join(", ")}
              </dd>
            )}
          </div>
        )}
      </dl>

        {game.private_target && (
          <p className="mt-4 rounded-md border border-[var(--ink)]/15 bg-white/70 p-3 text-xs text-[var(--ink-soft)]">
            Személyes titok volt: az értékelés a játék során megadott információk
            alapján készült, nem független ellenőrzéssel.
          </p>
        )}

      <a
        href="/"
        className="mt-5 inline-block min-h-11 rounded-md bg-[var(--green)] px-5 py-3 text-sm font-medium text-[var(--parchment)]"
      >
        Új játék
      </a>

      {/*
        V2.9.1 — discreet, opt-in, below the primary "Új játék" CTA it must
        never compete with. game.game_id is the SAME id corpus.games mirrors
        as operational_game_id; FeedbackAction only ever forwards it into a
        feedback submission body, never renders it.
      */}
      <FeedbackAction gameId={game.game_id} gameLanguage={game.game_language} />
    </section>
  );
}
