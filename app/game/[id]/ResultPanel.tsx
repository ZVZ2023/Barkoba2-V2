"use client";

import PostGameRegisterCTA from "@/app/components/PostGameRegisterCTA";
import type { GameRecord } from "@/lib/types";

// This component is quarantined from secretStore by scripts/check-isolation.mjs.
// It shows the target by reading game.revealed_target, which the resolve route
// writes at the single declassification point. It has no other route to it.

interface Props {
  game: GameRecord;
  resolving: boolean;
  error: string | null;
  onRetry: () => void;
}

const HEADLINE: Record<string, string> = {
  racer_correct: "Az AI eltalálta.",
  racer_incorrect: "Az AI nem talált. Nyertél.",
  composer_win_integrity_upheld: "Az AI feladta. Nyertél.",
  racer_win_integrity_violation: "Az AI-nak ítélve — integritás-ellenőrzés.",
};

const SUBHEAD: Record<string, string> = {
  racer_correct: "A kérdéskereten belül megnevezte a titkod.",
  racer_incorrect: "A válaszaid kiállták az ellenőrzést.",
  composer_win_integrity_upheld: "Elfogytak a kérdései és feladta. A válaszaid kiállták az ellenőrzést.",
  racer_win_integrity_violation:
    "Az ellenőrzés legalább egy ellentmondó választ talált.",
};

export default function ResultPanel({ game, resolving, error, onRetry }: Props) {
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
      <h2 className="text-lg font-semibold text-[var(--ink)]">
        {HEADLINE[game.result] ?? "A játék véget ért."}
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

        {game.integrity_notes && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">
              Integritás-ellenőrzés
            </dt>
            <dd className="mt-0.5 break-words text-[var(--ink)]">{game.integrity_notes}</dd>
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
    </section>
  );
}
