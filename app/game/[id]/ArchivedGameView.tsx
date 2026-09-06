import type { ArchivedGameRecord } from "@/lib/corpus/gameCorpus";
import { EXPERIENCE_MODE_LABEL_HU, isExperienceMode } from "@/lib/experienceMode";

// ---------------------------------------------------------------------------
// V2.8.8.3 — the read-only view for a COMPLETED game whose live KV record has
// already expired (~24h TTL). A plain server component on purpose: nothing
// here mutates, polls, or accepts input, so it needs none of GameClient's/
// RacerClient's/HumanClient's client-side machinery. app/game/[id]/page.tsx
// only ever reaches this after its OWN corpus query
// (getArchivedGameForOwner) has already verified lifecycle_state='completed'
// and ownership — this component trusts its caller for that and renders
// exactly what it is handed, nothing more.
//
// HONEST GAPS, LABELLED RATHER THAN HIDDEN (requirement: "not retained for
// this game", not a silent blank): target_retained/resolution_retained cover
// the (anomalous, defensive-only) case where a completed game's own
// evidence rows are missing; individual nullable fields (adjudication_notes,
// integrity_verdict, experience_mode) are simply omitted, matching how the
// live result screens already treat the identical nulls.
// ---------------------------------------------------------------------------

const ROLE_HU: Record<string, string> = {
  composer: "gondolkodó voltál",
  racer: "kérdező voltál",
};

const ANSWER_HU: Record<string, string> = {
  YES: "IGEN",
  NO: "NEM",
  AMBIGUOUS: "IS-IS",
};

const OUTCOME_HU: Record<string, string> = {
  racer_correct: "A kérdező eltalálta.",
  racer_incorrect: "A kérdező nem találta el.",
  composer_win_integrity_upheld: "A kérdező feladta.",
  racer_win_integrity_violation: "A válaszok ellentmondtak egymásnak — a kérdezőnek ítélve.",
};

const ADJUDICATOR_VERDICT_HU: Record<string, string> = {
  correct: "helyes tipp",
  incorrect: "helytelen tipp",
};

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("hu-HU", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function ArchivedGameView({
  record,
  versionLabel,
}: {
  record: ArchivedGameRecord;
  versionLabel: string;
}) {
  let questionNo = 0;
  const flagged = new Set(record.integrity_flagged_turns ?? []);

  return (
    <main className="mx-auto flex w-full min-h-screen max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--ink)]/10 pb-3">
        <a href="/" className="flex min-w-0 items-center gap-2" aria-label="Barkóba főoldal">
          <span
            aria-hidden="true"
            className="inline-block h-6 w-6 shrink-0 rounded-full border-[3px] border-[var(--ink)]/80"
            style={{ borderRightColor: "transparent" }}
          />
          <span className="truncate text-base font-semibold tracking-tight">Barkóba</span>
        </a>
        <h1 className="text-sm font-semibold text-[var(--ink)]">Mentett játék</h1>
      </header>

      <div className="rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
        <p className="text-sm text-[var(--ink)]">{formatWhen(record.created_at)}</p>
        <p className="mt-1 text-xs text-[var(--ink-soft)]">
          {record.role ? ROLE_HU[record.role] : "szerep ismeretlen"}
          {isExperienceMode(record.experience_mode) ? ` · ${EXPERIENCE_MODE_LABEL_HU[record.experience_mode]}` : ""}
        </p>
        <p className="mt-2 text-xs text-[var(--ink-soft)]">
          Ez egy tárolt, lezárt játék rekordja — az élő adat már lejárt, ezért a tartós
          nyilvántartásból jelenik meg. Nem folytatható.
        </p>
      </div>

      <section className="rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
        <h2 className="text-sm font-semibold text-[var(--ink)]">Eredmény</h2>
        <dl className="mt-2 flex flex-col gap-2 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">A cél</dt>
            <dd className="mt-0.5 text-[var(--ink)]">
              {record.target_retained ? record.target : "A cél nincs megőrizve ehhez a játékhoz."}
            </dd>
          </div>
          {record.final_guess_text && (
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">A végső tipp</dt>
              <dd className="mt-0.5 text-[var(--ink)]">{record.final_guess_text}</dd>
            </div>
          )}
          {record.resolution_retained ? (
            <>
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">Előzetes döntés</dt>
                <dd className="mt-0.5 text-[var(--ink)]">
                  {record.adjudicator_verdict
                    ? (ADJUDICATOR_VERDICT_HU[record.adjudicator_verdict] ?? record.adjudicator_verdict)
                    : "nincs (feladás — az adjudikáció nem futott le)"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">Végső eredmény</dt>
                <dd className="mt-0.5 text-[var(--ink)]">
                  {record.outcome ? (OUTCOME_HU[record.outcome] ?? record.outcome) : "ismeretlen"}
                </dd>
              </div>
              {record.adjudication_notes && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">Értékelés</dt>
                  <dd className="mt-0.5 text-[var(--ink)]">{record.adjudication_notes}</dd>
                </div>
              )}
              {record.integrity_verdict && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">Integritás-ellenőrzés</dt>
                  <dd className="mt-0.5 text-[var(--ink)]">
                    {record.integrity_verdict === "violated" ? "Ellentmondást talált." : "Megerősítve."}
                    {record.integrity_notes && ` ${record.integrity_notes}`}
                  </dd>
                  {record.integrity_flagged_turns && record.integrity_flagged_turns.length > 0 && (
                    <dd className="mt-1 text-xs text-[var(--red)]">
                      Ellentmondó körök: {record.integrity_flagged_turns.map((t) => `#${t}`).join(", ")}
                    </dd>
                  )}
                </div>
              )}
            </>
          ) : (
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">Értékelés</dt>
              <dd className="mt-0.5 text-[var(--ink)]">Az értékelés részletei nincsenek megőrizve ehhez a játékhoz.</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--ink)]">Kérdések és válaszok</h2>
        {record.turns.length === 0 && (
          <p className="text-sm text-[var(--ink-soft)]">A kérdés-válasz napló nincs megőrizve ehhez a játékhoz.</p>
        )}
        <ul className="flex flex-col gap-2">
          {record.turns.map((t, i) => {
            if (t.turn_type === "clue") {
              return (
                <li key={i} className="rounded-md border border-[var(--blue)]/25 bg-[var(--blue)]/5 p-3 text-sm">
                  <span className="font-medium text-[var(--blue)]">SÚGÓ: </span>
                  {t.clue_text}
                </li>
              );
            }
            if (t.turn_type !== "question") return null;
            questionNo += 1;
            const isFlagged = flagged.has(t.turn_index);
            return (
              <li
                key={i}
                className={`rounded-md border p-3 text-sm ${
                  isFlagged ? "border-[var(--red)]/40 bg-[var(--red)]/6" : "border-[var(--ink)]/15 bg-white/50"
                }`}
              >
                <p className="text-[var(--ink)]">
                  {questionNo}. {t.question_text}
                </p>
                <p className="mt-1 font-medium text-[var(--ink)]">
                  {t.composer_response ? (ANSWER_HU[t.composer_response] ?? t.composer_response) : "—"}
                  {isFlagged && <span className="ml-2 text-xs font-normal text-[var(--red)]">ellentmondónak jelölve</span>}
                </p>
                {t.ambiguous_explanation && (
                  <p className="mt-1 text-xs text-[var(--ink-soft)]">{t.ambiguous_explanation}</p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <a
          href="/history"
          className="inline-flex min-h-11 items-center text-sm text-[var(--ink-soft)] underline-offset-2 hover:underline"
        >
          ← Vissza a Játékaimhoz
        </a>
        <span className="text-xs text-[var(--ink-soft)]" title="Telepített Barkóba verzió">
          {versionLabel}
        </span>
      </div>
    </main>
  );
}
