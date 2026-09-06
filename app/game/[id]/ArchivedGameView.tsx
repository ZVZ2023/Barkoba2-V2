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
// integrity_verdict) are simply omitted, matching how the live result
// screens already treat the identical nulls.
//
// V2.8.8.3 PRESENTATION AUDIT — bilingual narrative copy, added after the
// first pass shipped Hungarian-only. WHAT FOLLOWS game_language and WHAT
// DOESN'T is a deliberate line, not an oversight:
//   - Full-sentence NARRATIVE the app itself authors describing what
//     happened (outcome, verdict, missing-data notices, the Integrity
//     Review effect sentence) follows game_language — the exact same
//     precedent GameClient.tsx's SANDBOX_CLARIFICATION_* maps and
//     ResultPanel.tsx's integrityFallbackNotice already established for
//     app-authored narrative text.
//   - A small, FIXED set of VALUE LABELS — role names and experience-mode
//     names — stay Hungarian regardless of game_language, matching the
//     product's own explicit, already-approved decision that setup/role/
//     mode chrome is Hungarian everywhere (see lib/experienceMode.ts's own
//     doc; HistoryClient.tsx's identical ROLE_HU is the live precedent).
//     These are not translated, not left as raw enums either — a fixed
//     Hungarian label either way, exactly like the live game already shows.
// Free-text CONTENT itself (target, guesses, questions, answers, notes) is
// never translated — it is reproduced verbatim in whatever language it was
// actually written in, tagged with `lang` so assistive tech treats it
// correctly, exactly like GameClient.tsx's own `lang={game.game_language}`
// usage on equivalent live content.
// ---------------------------------------------------------------------------

const ROLE_HU: Record<string, string> = {
  composer: "gondolkodó voltál",
  racer: "kérdező voltál",
};

const UNKNOWN_LABEL: Record<string, string> = { hu: "ismeretlen", en: "unknown" };

const ANSWER_LABEL: Record<string, Record<string, string>> = {
  hu: { YES: "IGEN", NO: "NEM", AMBIGUOUS: "IS-IS" },
  en: { YES: "YES", NO: "NO", AMBIGUOUS: "UNCLEAR" },
};

const OUTCOME_SENTENCE: Record<string, Record<string, string>> = {
  hu: {
    racer_correct: "A kérdező eltalálta.",
    racer_incorrect: "A kérdező nem találta el.",
    composer_win_integrity_upheld: "A kérdező feladta.",
    racer_win_integrity_violation: "A válaszok ellentmondtak egymásnak — a kérdezőnek ítélve.",
  },
  en: {
    racer_correct: "The guesser got it right.",
    racer_incorrect: "The guesser did not get it right.",
    composer_win_integrity_upheld: "The guesser gave up.",
    racer_win_integrity_violation: "The answers contradicted each other — ruled in the guesser's favor.",
  },
};

const ADJUDICATOR_VERDICT_SENTENCE: Record<string, Record<string, string>> = {
  hu: { correct: "helyes tipp", incorrect: "helytelen tipp" },
  en: { correct: "correct guess", incorrect: "incorrect guess" },
};

interface ArchivedViewCopy {
  title: string;
  home: string;
  roleUnknown: string;
  archivedNotice: string;
  resultHeading: string;
  targetLabel: string;
  targetNotRetained: string;
  finalGuessLabel: string;
  provisionalLabel: string;
  provisionalConcede: string;
  finalLabel: string;
  finalUnknown: string;
  evaluationLabel: string;
  evaluationNotRetained: string;
  integrityLabel: string;
  integrityViolated: string;
  integrityUpheld: string;
  integrityChangedOutcome: string;
  integrityNoChange: string;
  flaggedTurns: string;
  transcriptHeading: string;
  transcriptNotRetained: string;
  hintLabel: string;
  flaggedNote: string;
  back: string;
  versionTitle: string;
}

const COPY: Record<"hu" | "en", ArchivedViewCopy> = {
  hu: {
    title: "Mentett játék",
    home: "Barkóba főoldal",
    roleUnknown: "szerep ismeretlen",
    archivedNotice:
      "Ez egy tárolt, lezárt játék rekordja — az élő adat már lejárt, ezért a tartós nyilvántartásból jelenik meg. Nem folytatható.",
    resultHeading: "Eredmény",
    targetLabel: "A cél",
    targetNotRetained: "A cél nincs megőrizve ehhez a játékhoz.",
    finalGuessLabel: "A végső tipp",
    provisionalLabel: "Előzetes döntés",
    provisionalConcede: "nincs (feladás — az adjudikáció nem futott le)",
    finalLabel: "Végső eredmény",
    finalUnknown: "ismeretlen",
    evaluationLabel: "Értékelés",
    evaluationNotRetained: "Az értékelés részletei nincsenek megőrizve ehhez a játékhoz.",
    integrityLabel: "Integritás-ellenőrzés",
    integrityViolated: "Ellentmondást talált.",
    integrityUpheld: "Megerősítve.",
    integrityChangedOutcome:
      "Ez megváltoztatta a végeredményt: bár a tipp/feladás önmagában vesztést jelentett volna, az ellentmondó válaszok miatt a kérdező kapta a győzelmet.",
    integrityNoChange: "Ez nem változtatta meg a végeredményt: a válaszok kiállták az ellenőrzést.",
    flaggedTurns: "Ellentmondó körök",
    transcriptHeading: "Kérdések és válaszok",
    transcriptNotRetained: "A kérdés-válasz napló nincs megőrizve ehhez a játékhoz.",
    hintLabel: "SÚGÓ",
    flaggedNote: "ellentmondónak jelölve",
    back: "← Vissza a Játékaimhoz",
    versionTitle: "Telepített Barkóba verzió",
  },
  en: {
    title: "Saved game",
    home: "Barkóba home",
    roleUnknown: "role unknown",
    archivedNotice:
      "This is a stored record of a completed game — the live data has already expired, so it is shown from the durable record. It cannot be resumed.",
    resultHeading: "Result",
    targetLabel: "The target",
    targetNotRetained: "The target was not retained for this game.",
    finalGuessLabel: "The final guess",
    provisionalLabel: "Provisional verdict",
    provisionalConcede: "none (gave up — adjudication never ran)",
    finalLabel: "Final result",
    finalUnknown: "unknown",
    evaluationLabel: "Evaluation",
    evaluationNotRetained: "Evaluation details were not retained for this game.",
    integrityLabel: "Integrity review",
    integrityViolated: "Found a contradiction.",
    integrityUpheld: "Confirmed.",
    integrityChangedOutcome:
      "This changed the final outcome: although the guess/give-up would have meant a loss on its own, the contradictory answers gave the win to the guesser.",
    integrityNoChange: "This did not change the final outcome: the answers held up under review.",
    flaggedTurns: "Contradicting rounds",
    transcriptHeading: "Questions and answers",
    transcriptNotRetained: "The question/answer log was not retained for this game.",
    hintLabel: "HINT",
    flaggedNote: "flagged as contradictory",
    back: "← Back to My Games",
    versionTitle: "Installed Barkóba version",
  },
} as const;

function localeFor(gameLanguage: string): string {
  return gameLanguage === "en" ? "en-US" : "hu-HU";
}

function copyFor(gameLanguage: string): ArchivedViewCopy {
  return gameLanguage === "en" ? COPY.en : COPY.hu;
}

function formatWhen(iso: string, gameLanguage: string): string {
  try {
    return new Date(iso).toLocaleString(localeFor(gameLanguage), {
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
  const lang = record.game_language === "en" ? "en" : "hu";
  const t = copyFor(record.game_language);
  const answerLabel = ANSWER_LABEL[lang]!;
  const outcomeSentence = OUTCOME_SENTENCE[lang]!;
  const adjudicatorSentence = ADJUDICATOR_VERDICT_SENTENCE[lang]!;
  const unknown = UNKNOWN_LABEL[lang]!;

  let questionNo = 0;
  const flagged = new Set(record.integrity_flagged_turns ?? []);

  return (
    <main className="mx-auto flex w-full min-h-screen max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--ink)]/10 pb-3">
        <a href="/" className="flex min-w-0 items-center gap-2" aria-label={t.home}>
          <span
            aria-hidden="true"
            className="inline-block h-6 w-6 shrink-0 rounded-full border-[3px] border-[var(--ink)]/80"
            style={{ borderRightColor: "transparent" }}
          />
          <span className="truncate text-base font-semibold tracking-tight">Barkóba</span>
        </a>
        <h1 className="text-sm font-semibold text-[var(--ink)]">{t.title}</h1>
      </header>

      <div className="rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
        <p className="text-sm text-[var(--ink)]">{formatWhen(record.created_at, record.game_language)}</p>
        {/*
          V2.8.8.3 audit — role and experience-mode LABELS stay Hungarian
          regardless of game_language, matching the product's own explicit
          decision (lib/experienceMode.ts) and this app's live precedent
          (HistoryClient.tsx's own ROLE_HU). Not raw enums either way — a
          fixed, human-readable Hungarian label.
        */}
        <p className="mt-1 text-xs text-[var(--ink-soft)]">
          {record.role ? ROLE_HU[record.role] : t.roleUnknown}
          {isExperienceMode(record.experience_mode) ? ` · ${EXPERIENCE_MODE_LABEL_HU[record.experience_mode]}` : ""}
        </p>
        <p className="mt-2 text-xs text-[var(--ink-soft)]">{t.archivedNotice}</p>
      </div>

      <section className="rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
        <h2 className="text-sm font-semibold text-[var(--ink)]">{t.resultHeading}</h2>
        <dl className="mt-2 flex flex-col gap-2 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">{t.targetLabel}</dt>
            <dd className="mt-0.5 text-[var(--ink)]" lang={record.target_retained ? record.game_language : undefined}>
              {record.target_retained ? record.target : t.targetNotRetained}
            </dd>
          </div>
          {record.final_guess_text && (
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">{t.finalGuessLabel}</dt>
              <dd className="mt-0.5 text-[var(--ink)]" lang={record.game_language}>
                {record.final_guess_text}
              </dd>
            </div>
          )}
          {record.resolution_retained ? (
            <>
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">{t.provisionalLabel}</dt>
                <dd className="mt-0.5 text-[var(--ink)]">
                  {record.adjudicator_verdict
                    ? (adjudicatorSentence[record.adjudicator_verdict] ?? unknown)
                    : t.provisionalConcede}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">{t.finalLabel}</dt>
                <dd className="mt-0.5 text-[var(--ink)]">
                  {record.outcome ? (outcomeSentence[record.outcome] ?? unknown) : t.finalUnknown}
                </dd>
              </div>
              {record.adjudication_notes && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">{t.evaluationLabel}</dt>
                  <dd className="mt-0.5 text-[var(--ink)]" lang={record.game_language}>
                    {record.adjudication_notes}
                  </dd>
                </div>
              )}
              {record.integrity_verdict && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">{t.integrityLabel}</dt>
                  <dd className="mt-0.5 text-[var(--ink)]">
                    {record.integrity_verdict === "violated" ? t.integrityViolated : t.integrityUpheld}{" "}
                    {record.integrity_verdict === "violated" ? t.integrityChangedOutcome : t.integrityNoChange}
                  </dd>
                  {record.integrity_notes && (
                    <dd className="mt-1 text-[var(--ink)]" lang={record.game_language}>
                      {record.integrity_notes}
                    </dd>
                  )}
                  {record.integrity_flagged_turns && record.integrity_flagged_turns.length > 0 && (
                    <dd className="mt-1 text-xs text-[var(--red)]">
                      {t.flaggedTurns}: {record.integrity_flagged_turns.map((n) => `#${n}`).join(", ")}
                    </dd>
                  )}
                </div>
              )}
            </>
          ) : (
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--ink-soft)]">{t.evaluationLabel}</dt>
              <dd className="mt-0.5 text-[var(--ink)]">{t.evaluationNotRetained}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--ink)]">{t.transcriptHeading}</h2>
        {record.turns.length === 0 && <p className="text-sm text-[var(--ink-soft)]">{t.transcriptNotRetained}</p>}
        <ul className="flex flex-col gap-2">
          {record.turns.map((turn, i) => {
            if (turn.turn_type === "clue") {
              return (
                <li key={i} className="rounded-md border border-[var(--blue)]/25 bg-[var(--blue)]/5 p-3 text-sm">
                  <span className="font-medium text-[var(--blue)]">{t.hintLabel}: </span>
                  <span lang={record.game_language}>{turn.clue_text}</span>
                </li>
              );
            }
            if (turn.turn_type !== "question") return null;
            questionNo += 1;
            const isFlagged = flagged.has(turn.turn_index);
            return (
              <li
                key={i}
                className={`rounded-md border p-3 text-sm ${
                  isFlagged ? "border-[var(--red)]/40 bg-[var(--red)]/6" : "border-[var(--ink)]/15 bg-white/50"
                }`}
              >
                <p className="text-[var(--ink)]" lang={record.game_language}>
                  {questionNo}. {turn.question_text}
                </p>
                <p className="mt-1 font-medium text-[var(--ink)]">
                  {turn.composer_response ? (answerLabel[turn.composer_response] ?? unknown) : "—"}
                  {isFlagged && <span className="ml-2 text-xs font-normal text-[var(--red)]">{t.flaggedNote}</span>}
                </p>
                {turn.ambiguous_explanation && (
                  <p className="mt-1 text-xs text-[var(--ink-soft)]" lang={record.game_language}>
                    {turn.ambiguous_explanation}
                  </p>
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
          {t.back}
        </a>
        <span className="text-xs text-[var(--ink-soft)]" title={t.versionTitle}>
          {versionLabel}
        </span>
      </div>
    </main>
  );
}
